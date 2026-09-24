import { NextResponse } from 'next/server'
import { GrammyError, HttpError } from 'grammy'
import { APICallError, RetryError } from 'ai'
import { Receiver } from '@upstash/qstash'
import {
  dueAutomations, claimAutomation, allowedMembers, recordMessage, strangersIn,
  messagesSince, getSetting, setSetting, retireStaleProposals, recordTick,
  unaskedQuestions, markQuestionsAsked, memberByTelegramId, setAutomationEnabled,
} from '@/lib/db/queries'
import { localDateKey, tzOffsetMs, nextRun, formatLocal } from '@/lib/cron'
import { timezone, idSet } from '@/lib/env'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { runAgent, decideWatcherPost, reviewDraft, looksBefore, type AgentResult } from '@/lib/agent'
import { buildTools, type ToolName } from '@/lib/tools'
import type { ToolContext } from '@/lib/tools/context'
import { WATCHERS, isWatcherKind, isGroupChat, watcherInstruction, type WatcherKind } from '@/lib/watchers'
import { installBuiltins } from '@/lib/builtins'
import { unaccountedIn } from '@/lib/headcount'
import { commitCursors, type StagedCursor } from '@/lib/tools/cursor'
import { send } from '@/lib/telegram'
import { hydrateSecrets } from '@/lib/settings'
import { flushTelemetry } from '@/lib/telemetry'
import { pruneModelEvents } from '@/lib/model-events'
import { parseLog, prune, underCap, recordPost, shouldWarn, markWarned, PROACTIVE_POSTS_PER_HOUR } from '@/lib/rate-cap'
import type { Automation, Member } from '@/lib/db/schema'
import { describeError } from '@/lib/errors'
import { unsaid } from '@/lib/notices'
import { plainData } from '@/lib/plain-data'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * QStash signs every delivery; without keys we only accept a manual admin
 * secret. Which one let the call in matters: only the scheduler's own calls
 * are its pulse.
 */
async function authorised(req: Request, body: string): Promise<'scheduler' | 'manual' | null> {
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY
  const next = process.env.QSTASH_NEXT_SIGNING_KEY
  const signature = req.headers.get('upstash-signature')

  if (current && signature) {
    try {
      const receiver = new Receiver({ currentSigningKey: current, nextSigningKey: next ?? current })
      return (await receiver.verify({ signature, body, url: req.url })) ? 'scheduler' : null
    } catch (err) {
      console.warn('[tick] signature verification failed:', err)
      return null
    }
  }

  const adminSecret = process.env.TICK_SECRET
  return Boolean(adminSecret) && req.headers.get('x-tick-secret') === adminSecret ? 'manual' : null
}

/**
 * Failures and diagnostics belong in an admin's DM, not the family group: the
 * chat is for the household, not for stack traces. Preference order is the
 * automation's creator, then any admin; if nobody is reachable it stays in
 * the logs rather than the group.
 */
async function tellAdminQuietly(creator: { telegramUserId: string } | undefined, text: string): Promise<void> {
  const admins = await allowedMembers()
    .then((all) => all.filter((m) => m.isAdmin).map((m) => m.telegramUserId))
    .catch(() => [] as string[])
  const targets = [...new Set([creator?.telegramUserId, ...admins].filter(Boolean))] as string[]
  for (const to of targets) {
    try {
      await send(to, text)
      try {
        // Into that DM's history too, or the admin's next reply lands on a
        // conversation the model cannot see.
        await recordMessage({ chatId: to, role: 'assistant', content: text })
      } catch {
        // Delivered is what matters; history here is best-effort.
      }
      return
    } catch {
      // They may never have opened a DM with the bot; try the next admin.
    }
  }
  console.error('[tick] no admin reachable by DM:', text)
}

const isSkipLine = (line: string) => /^skip[.!]*$/i.test(line.trim())
/** A marked failure, and nothing else, is what earns an admin a DM. */
const isProblemLine = (line: string) => /^\**\s*problem\s*\**\s*:/i.test(line.trim())

/** Enough of a held-back draft for an admin to judge the call by, not the whole post. */
const HELD_DRAFT_CHARS = 600
const heldBack = (a: Automation, why: string, draft: string) =>
  `Watcher **${a.label}** was held back: ${why}\n\nDraft:\n${draft.length > HELD_DRAFT_CHARS ? `${draft.slice(0, HELD_DRAFT_CHARS)}…` : draft}`

/**
 * The nightly memory pass: relying on the chat-turn model to file memories
 * while it is busy answering leaves most facts on the floor, so once a day the
 * previous day's talk is re-read purely for what deserves keeping. One model
 * call, silent, with only the memory tools in reach.
 */
async function maybeConsolidateMemory(now: Date): Promise<void> {
  const localHour = new Date(now.getTime() + tzOffsetMs(now, timezone())).getUTCHours()
  if (localHour < 3) return
  const today = localDateKey(now)
  if ((await getSetting('memory_sweep_day')) === today) return
  // Claim before working; a racing tick at worst repeats an idempotent pass.
  await setSetting('memory_sweep_day', today)

  const talk = await messagesSince(26)
  if (talk.length === 0) return

  const transcript = talk
    .map((m) => `[${m.chatId}] ${m.role === 'user' ? (m.authorName ?? 'someone') : 'you'}: ${m.content.slice(0, 400)}`)
    .join('\n')

  try {
    await runAgent({
      chatId: 'memory-sweep',
      chatType: 'private',
      member: null,
      memberName: 'the household',
      mode: 'sweep',
      history: false,
      text:
        "Nightly memory pass. Yesterday's household talk follows; the Known household facts are in your context.\n\n" +
        transcript,
    })
  } catch (err) {
    // A failed pass costs nothing; tomorrow re-reads a fresh day.
    console.error('[tick] memory pass failed:', err)
  }
}

type Tools = ReturnType<typeof buildTools>

/** Run one of the agent's own tools directly, the way a model turn would. */
async function runTool(tools: Tools, name: ToolName, args: unknown): Promise<Record<string, unknown>> {
  const t = tools[name] as unknown as { execute?: (input: unknown, options: unknown) => Promise<unknown> }
  if (!t.execute) throw new Error(`${name} cannot run outside a model turn`)
  const out = await t.execute(args, { toolCallId: `tick-${name}`, messages: [] })
  return (out ?? {}) as Record<string, unknown>
}

const errorOf = (r: Record<string, unknown>): string | null => (typeof r.error === 'string' ? r.error : null)
/** Optional integrations answer "not configured"; that is a setting, not a fault. */
const isUnconfigured = (err: string | null) => Boolean(err && /not configured/i.test(err))
/** Nobody having linked a mailbox yet is a setting too; a mailbox that will not answer is a fault. */
const isUnlinked = (err: string | null) => Boolean(err && /linked a mailbox|no email account linked/i.test(err))

type Fetched = {
  data: Record<string, unknown>
  empty: boolean
  problems: string[]
  /** Questions the nightly pass left for the family, put to them by this run. */
  asked?: number[]
}

/**
 * The deterministic half of a ready-made watcher: fetch what it watches and
 * decide in code whether there is anything at all. A quiet hour then costs no
 * model call and cannot produce a speculative post, and when there is
 * something, the model only has to phrase what is already in hand.
 */
async function fetchFor(kind: WatcherKind, a: Automation, ctx: ToolContext, tools: Tools): Promise<Fetched> {
  const problems: string[] = []
  switch (kind) {
    case 'money': {
      const r = await runTool(tools, 'new_transactions', { account: '2up', limit: 20 })
      const err = errorOf(r)
      if (err) problems.push(`new_transactions: ${err}`)
      const transactions = Array.isArray(r.transactions) ? r.transactions : []
      return { data: { transactions: r }, empty: transactions.length === 0, problems }
    }
    case 'morning': {
      const day = localDateKey(ctx.now)
      // In a group the brief sweeps every linked mailbox, each on its own
      // cursor; in a DM only the owner's. The cursor is the chat's, so the
      // brief picks up where the retired inbox sweep left off.
      // The nightly pass asks rather than guesses; the brief is where its
      // questions reach the family, once each. Home carries them after that.
      const [events, mail, board, weather, questions] = await Promise.all([
        // The whole day, and anything on during it: day three of a camp is news too.
        runTool(tools, 'list_family_events', { from: day, to: day, include_cancelled: false }),
        // A day's mail, not an hour's: the brief runs once a morning. What
        // does not fit is counted in the brief rather than dropped.
        runTool(tools, 'new_mail', { limit: 20, everyone: isGroupChat(a.chatId) }),
        runTool(tools, 'jira_board_summary', {}),
        runTool(tools, 'weather', {}),
        isGroupChat(a.chatId) ? unaskedQuestions().catch(() => []) : Promise.resolve([]),
      ])
      const eventsErr = errorOf(events)
      if (eventsErr) problems.push(`list_family_events: ${eventsErr}`)
      const mailErr = errorOf(mail)
      if (mailErr && !isUnlinked(mailErr)) problems.push(`new_mail: ${mailErr}`)
      const accounts = Array.isArray(mail.accounts) ? (mail.accounts as Record<string, unknown>[]) : []
      let arrived = 0
      for (const acct of accounts) {
        const e = errorOf(acct)
        if (e) problems.push(`new_mail (${String(acct.mailbox)}): ${e}`)
        if (Array.isArray(acct.messages)) arrived += acct.messages.length
      }
      for (const [name, r] of [['jira_board_summary', board], ['weather', weather]] as const) {
        const e = errorOf(r)
        if (e && !isUnconfigured(e)) problems.push(`${name}: ${e}`)
      }
      const todays = Array.isArray(events.events) ? events.events : []
      const overdue = Array.isArray(board.overdue) ? board.overdue : []
      const data: Record<string, unknown> = { events }
      if (!mailErr) data.mail = mail
      if (!errorOf(board)) data.board = board
      if (!errorOf(weather)) data.weather = weather
      if (questions.length) data.questions = questions.map((qn) => ({ id: qn.id, question: qn.question }))
      // A day with nothing on, no new mail, nothing due and nothing to ask
      // gets no brief; weather alone is not news the household needs pushed at it.
      return {
        data,
        empty: todays.length === 0 && arrived === 0 && overdue.length === 0 && questions.length === 0,
        problems,
        asked: questions.map((qn) => qn.id),
      }
    }
    case 'snapshot': {
      const today = localDateKey(ctx.now)
      const weekStart = localDateKey(new Date(ctx.now.getTime() - 6 * 86_400_000))
      // PocketSmith has the categories and the budget; without it the raw Up
      // feed still gives the totals.
      const spending = async (range: { from?: string; to?: string }) => {
        const categorised = await runTool(tools, 'spending_summary', { ...range, source: 'pocketsmith' })
        return isUnconfigured(errorOf(categorised)) ? runTool(tools, 'spending_summary', { ...range, source: 'up' }) : categorised
      }
      const [week, month, budget] = await Promise.all([
        spending({ from: weekStart, to: today }),
        spending({}),
        runTool(tools, 'budget_summary', {}),
      ])
      for (const [name, r] of [['spending_summary (week)', week], ['spending_summary (month)', month], ['budget_summary', budget]] as const) {
        const e = errorOf(r)
        if (e && !isUnconfigured(e)) problems.push(`${name}: ${e}`)
      }
      const data: Record<string, unknown> = { week: `${weekStart} to ${today}` }
      if (!errorOf(week)) data.this_week = week
      if (!errorOf(month)) data.month_so_far = month
      if (!errorOf(budget)) data.budget = budget
      // No bank connected is a setting, not a fault, and a week in which no
      // money moved is nothing to post about either.
      const moved = Number(week.transactions ?? 0) + Number(month.transactions ?? 0)
      return { data, empty: moved === 0, problems }
    }
  }
}

/** The Known facts the writer had in view, so the checks judge the draft against the same sources. */
const factsGiven = (r: AgentResult) => (r.facts ? `${r.facts}\n\n` : '')

async function runReadyMade(kind: WatcherKind, a: Automation, member: Member | undefined): Promise<void> {
  const now = new Date()
  const memberName = member?.name ?? 'the family'
  const ctx: ToolContext = { chatId: a.chatId, member: member ?? null, memberName, now, notices: [] }
  const tools = buildTools(ctx)

  const fetched = await fetchFor(kind, a, ctx, tools)
  if (fetched.problems.length) {
    await tellAdminQuietly(member, `Watcher **${a.label}** hit a problem:\n\n${fetched.problems.join('\n')}`)
  }
  if (fetched.empty) {
    console.info(`[tick] ${a.label}: nothing new, no model call`)
    // Nothing new is still a look taken, and a first one sets the marker.
    await spentClean(a, ctx.pendingCursors ?? [])
    return
  }

  const watcher = WATCHERS[kind]
  const instruction = watcherInstruction(kind, a.chatId)
  const data = plainData(fetched.data)
  const result = await counted(a, member, (err) => [...(ctx.pendingCursors ?? []), ...looksBefore(err)], () => runAgent({
    chatId: a.chatId,
    chatType: isGroupChat(a.chatId) ? 'group' : 'private',
    member: member ?? null,
    memberName,
    mode: 'watcher',
    tools: watcher.tools,
    ...(watcher.maxOutputTokens ? { maxOutputTokens: watcher.maxOutputTokens } : {}),
    history: false,
    text: `Scheduled check "${a.label}".\n\n${instruction}\n\nDATA (fetched just now):\n${data}`,
  }))
  const staged = () => [...(ctx.pendingCursors ?? []), ...(result.cursors ?? [])]
  await counted(a, member, staged, () => deliver(
    a, member, result,
    `INSTRUCTION:\n${instruction}\n\n${factsGiven(result)}DATA:\n${data}\n\nTOOL RESULTS:\n${result.evidence || '(none)'}`,
    () => spentClean(a, staged()),
  ))
  // Asked once: whatever became of the post, Home keeps the question until it is answered.
  if (fetched.asked?.length) await markQuestionsAsked(fetched.asked)
}

/** A member's own scheduled instruction: the model decides what to fetch, with read-only tools. */
async function runCustom(a: Automation, member: Member | undefined): Promise<void> {
  const result = await counted(a, member, looksBefore, () => runAgent({
    chatId: a.chatId,
    chatType: isGroupChat(a.chatId) ? 'group' : 'private',
    member: member ?? null,
    memberName: member?.name ?? 'the family',
    mode: 'watcher',
    history: false,
    text:
      `Scheduled automation "${a.label}" is due now. Carry out this instruction; whatever you write will be posted to the family chat, briefly:\n\n${a.instruction}\n\n` +
      'If the instruction only wants a post under some condition and that condition is not met (nothing new, nothing to report), reply with exactly SKIP and nothing will be posted. Write nothing beside it: a quiet run needs no explanation of why it was quiet. ' +
      'If a tool fails or errors, never post the failure to the chat: write PROBLEM: followed by a one-line diagnosis, then SKIP on its own line. That, and only that, reaches the admins privately. ' +
      'Reply with the post alone: no preamble, no planning notes, no handover line such as "now the post:", no commentary about what the tools returned.',
  }))
  const staged = () => result.cursors ?? []
  await counted(a, member, staged, () => deliver(
    a, member, result,
    `INSTRUCTION:\n${a.instruction}\n\n${factsGiven(result)}TOOL RESULTS:\n${result.evidence || '(none)'}`,
    () => spentClean(a, staged()),
  ))
}

/**
 * Run one step of a watcher, counting it against the stuck guard when it
 * leaves what the run read unspent: a throw, or deliver() reporting a PROBLEM.
 * A failure of the model chain or the network passes, and says nothing about
 * the items, so it is not counted. The guard's own failure never hides the run's.
 */
async function counted<T>(
  a: Automation,
  member: Member | undefined,
  staged: (err?: unknown) => StagedCursor[],
  step: () => Promise<T>,
): Promise<T> {
  let out: T
  try {
    out = await step()
  } catch (err) {
    if (!passing(err)) await unspent(a, member, staged(err), describeError(err)).catch((e) => console.error('[tick] stuck guard failed:', e))
    throw err
  }
  if (out === 'problem') {
    await unspent(a, member, staged(), 'the run reported a problem').catch((e) => console.error('[tick] stuck guard failed:', e))
  }
  return out
}

/**
 * How a failure that says nothing about the items reads: a service down,
 * rate limited, out of credit, unreachable or refusing its key. Numbers
 * stand alone, so a token count in a "too long" message is not a 5xx.
 */
const PASSING_WORDS =
  /\b(?:401|403|429|5\d\d)\b|rate.?limit|quota|too many requests|timed? ?out|\btimeout\b|unavailable|overloaded|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|cannot connect|network error|no llm configured|not configured|unreachable|unauthori[sz]ed|api key|insufficient credits|provider returned error|expired or been revoked/i

/**
 * A failure of the model chain, a service or the network, which passes or
 * needs fixing, not skipping. What is left (a request the provider rejects as
 * it stands, a message Telegram cannot parse) is about what was sent, and
 * counts. Judged on the error itself where it says, and on its words only
 * where it does not.
 */
function passing(err: unknown): boolean {
  if (RetryError.isInstance(err)) return passing(err.lastError)
  if (APICallError.isInstance(err)) {
    if (err.isRetryable || err.statusCode === undefined || ![400, 413, 422].includes(err.statusCode)) return true
    // A 400 can still be the key (Gemini answers a bad one that way).
    return PASSING_WORDS.test(err.message)
  }
  if (err instanceof GrammyError) return err.error_code === 429 || err.error_code >= 500 || err.error_code === 401 || err.error_code === 403
  if (err instanceof HttpError) return true
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return true
  return PASSING_WORDS.test(describeError(err))
}

/**
 * Post-or-skip is decided in a fresh context against the evidence, by a
 * judge that answers two questions and never sees the writer's draft as its
 * own. Each judge draws its own line (Jev's in lib/jev.ts, the chain's in
 * lib/agent.ts) and what comes back is honoured as decided: a second line
 * here once stacked on Jev's and held back a grounded brief at 0.63. If the
 * decision itself cannot be made (a provider that will not return the
 * structured object) the draft goes out as it always did, and an admin hears
 * that the safety net was down. A draft held back at either step is reported
 * to an admin with the reason: a run that wrote something and posted nothing
 * is not the quiet kind of quiet.
 *
 * What posts is the reviewed draft itself, never a retype from the decision:
 * the decision once offered its own wording, and that is what turned a
 * formatted snapshot into plain lines and brought back entries the check had
 * never seen.
 */
async function approve(a: Automation, member: Member | undefined, draft: string, evidence: string): Promise<string | null> {
  // First the factored check: each claim against the evidence, in a context
  // that never sees the draft. What fails is cut; if nothing survives, silence.
  let reviewed = draft
  // Whether that check went through this draft and passed it whole: it pulled
  // statements out, every one was put to the checker against this evidence,
  // and every one came back supported. The decision below asks its own
  // grounding question of the draft all at once, which is the coarser of the
  // two and drifts up with the draft's length, so what it takes to override a
  // check that has already passed is set where the lines are, in lib/jev.ts. A
  // check that could not run, or one whose rewrite put back a draft nobody has
  // checked since, leaves this false and the full line stands.
  let verified = false
  try {
    const review = await reviewDraft({ label: a.label, draft, evidence })
    if (review.message === null) {
      const why = `no claim survived the check: ${review.unsupported.join(' | ')}`
      console.warn(`[tick] ${a.label}: held back, ${why}`)
      await tellAdminQuietly(member, heldBack(a, why, draft))
      return null
    }
    if (review.unsupported.length) {
      console.warn(`[tick] ${a.label}: cut ${review.unsupported.length} unsupported claim(s): ${review.unsupported.join(' | ')}`)
    }
    reviewed = review.message
    verified = review.claims.length > 0 && review.unsupported.length === 0
  } catch (err) {
    console.error(`[tick] ${a.label}: claim check unavailable, deciding on the raw draft:`, describeError(err))
  }
  try {
    const d = await decideWatcherPost({ label: a.label, draft: reviewed, evidence, verified })
    console.info(
      '[tick] decision',
      JSON.stringify({ label: a.label, decision: d.decision, confidence: d.confidence, verified, model: d.model, reason: d.reason ?? null }),
    )
    if (d.decision === 'post') return reviewed
    const why = `the post check said ${d.decision} at ${d.confidence.toFixed(2)}${d.reason ? `: ${d.reason}` : ''}`
    console.warn(`[tick] ${a.label}: held back, ${why}`)
    await tellAdminQuietly(member, heldBack(a, why, reviewed))
    return null
  } catch (err) {
    const reason = describeError(err)
    console.error(`[tick] ${a.label}: post decision unavailable, posting the draft:`, reason)
    await tellAdminQuietly(member, `Watcher **${a.label}**: the post decision failed (${reason}), so its draft went out unchecked.`)
    return reviewed
  }
}

/**
 * Turn a run's output into at most one chat message. A lone SKIP line keeps
 * that part out of the chat whatever else it says; a marked PROBLEM goes to
 * the admins; the draft itself posts only once approved; tool notices report
 * actions already taken, so they always post.
 */
/**
 * Post a watcher's result, checked, capped and with its problems routed to an
 * admin. `spent` marks what the run read as seen, and is called only once that
 * has reached the chat, or was deliberately kept from it: a plain SKIP, or a
 * draft the checks held back (an admin has it). A PROBLEM, a post the hourly
 * cap held back, or a send that fails leaves it new for the next run, with one
 * exception: a run that wrote something unrepeatable on the strength of it (a
 * list item, a reminder) spends it whatever else happened, or the next run
 * would write it again. Says which it was.
 */
async function deliver(
  a: Automation,
  member: Member | undefined,
  result: AgentResult,
  evidence: string,
  spent: () => Promise<void>,
): Promise<'spent' | 'problem' | 'unavailable' | 'capped'> {
  const split = (part: string) => {
    const lines = part.split('\n')
    const skip = lines.some(isSkipLine)
    return { skip, rest: skip ? lines.filter((l) => !isSkipLine(l)).join('\n').trim() : part.trim() }
  }

  const quiet: string[] = []
  const notices: string[] = []
  const draft = split(result.text)
  if (draft.skip && draft.rest) quiet.push(draft.rest)
  for (const n of result.notices) {
    const s = split(n)
    if (!s.skip) notices.push(n)
    else if (s.rest) quiet.push(s.rest)
  }

  // Staying quiet is the normal outcome for a watcher, not news: only a marked
  // PROBLEM reaches an admin. Anything else written beside SKIP is the model
  // narrating why it said nothing, and that belongs in the logs.
  const problems = quiet.flatMap((q) => q.split('\n').filter(isProblemLine))
  if (problems.length) {
    await tellAdminQuietly(member, `Watcher **${a.label}** hit a problem:\n\n${problems.join('\n')}`)
  } else if (quiet.length) {
    console.warn(`[tick] ${a.label} stayed quiet:`, quiet.join(' | '))
  }

  const parts: string[] = []
  let withheld = false
  if (!draft.skip && draft.rest) {
    const approved = await approve(a, member, draft.rest, evidence)
    if (approved) parts.push(approved)
    else withheld = true
  }
  parts.push(...unsaid(parts.join('\n\n'), notices))

  const message = parts.join('\n\n').trim()
  if (!message) {
    // Quiet by choice, or held back on purpose, is the run done with what it
    // read. A run that could not do its job (a PROBLEM) leaves it for the next.
    if (withheld || problems.length === 0 || result.wrote?.length) {
      await spent()
      return 'spent'
    }
    // Counted against the stuck guard only when a problem is about what was
    // read, not a tool whose service is down or whose link has lapsed.
    return problems.every((line) => PASSING_WORDS.test(line)) ? 'unavailable' : 'problem'
  }

  // The last guard: however the run got here, a chat hears from its watchers
  // only so often. An admin hears about the first held-back post each hour.
  const now = new Date()
  const capKey = `proactive_posts:${a.chatId}`
  const log = prune(parseLog(await getSetting(capKey)), now)
  if (!underCap(log)) {
    console.warn(`[tick] ${a.label}: held back, ${log.posts.length} scheduled posts in the last hour for chat ${a.chatId}`)
    if (shouldWarn(log, now)) {
      await setSetting(capKey, JSON.stringify(markWarned(log, now)))
      await tellAdminQuietly(
        member,
        `Watcher **${a.label}** was held back: this chat has had ${PROACTIVE_POSTS_PER_HOUR} scheduled posts in the last hour. A schedule may be too eager.`,
      )
    }
    if (result.wrote?.length) {
      // Spent, or the next run would write it all again; so the draft is all
      // there is of what it read, and an admin gets it.
      await spent()
      await tellAdminQuietly(member, heldBack(a, 'the hourly cap was reached after the run had already acted on what it read.', message))
      return 'spent'
    }
    return 'capped'
  }

  await send(a.chatId, message)
  // Spent the moment it is posted, before the bookkeeping below can fail and bring it round again.
  await spent()
  await setSetting(capKey, JSON.stringify(recordPost(log, now)))
  await db().insert(schema.messages).values({
    chatId: a.chatId,
    role: 'assistant',
    content: message,
    model: result.model,
  })
  if (result.cutShort) {
    await tellAdminQuietly(
      member,
      `Watcher **${a.label}** ran out of room: the model's output allowance cut its post short, so it went out without its unfinished end, and whatever that held was not posted. A shorter instruction, or a larger allowance for this watcher, stops it.`,
    )
  }
  return 'spent'
}

/**
 * How many runs in a row, and over how long, may leave the same new items
 * unspent before they are moved past. The span keeps an hourly watcher from
 * skipping anything over a bad morning.
 */
const STUCK_RUNS = 3
const STUCK_FOR_MS = 12 * 3600_000
/**
 * A count that has not got there in this long is forgotten: runs that far
 * apart are not one failure repeating, and a mailbox unlinked meanwhile must
 * not have its old place committed onto it when it is linked again.
 */
const STUCK_FORGOTTEN_MS = 8 * 86_400_000

/** One cursor held at the same place: since when, how many runs, and the first stuck run's move. */
type Stuck = { from: string; since: string; runs: number; move: StagedCursor }

async function readStuck(a: Automation): Promise<Record<string, Stuck>> {
  let parsed: unknown
  try {
    parsed = JSON.parse((await getSetting(`unspent:${a.id}`)) || '{}')
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  // Anything unreadable counts as never stuck, and anything that old as forgotten.
  const cutoff = Date.now() - STUCK_FORGOTTEN_MS
  return Object.fromEntries(
    Object.entries(parsed).filter(
      ([, v]) => typeof v?.from === 'string' && typeof v?.move?.key === 'string' && Date.parse(v?.since) > cutoff,
    ),
  ) as Record<string, Stuck>
}

const writeStuck = (a: Automation, stuck: Record<string, Stuck>) =>
  setSetting(`unspent:${a.id}`, Object.keys(stuck).length ? JSON.stringify(stuck) : '')

/** The source and the span skipped, which is what an admin can go and look at. */
const describeMove = (m: Stuck) => {
  const [kind, , ...rest] = m.move.key.split(':')
  const provider = rest.at(-1)
  const what =
    kind === 'mail_cursor' ? `mail in a linked ${provider === 'google' ? 'Gmail' : provider === 'microsoft' ? 'Outlook' : String(provider)} mailbox`
    : kind === 'up_cursor' ? 'Up transactions'
    : 'new items'
  const from = m.from === '-' ? 'up' : `from ${formatLocal(new Date(m.from))}`
  return `${what} ${from} to ${formatLocal(new Date(m.move.at))}`
}

/**
 * Leaving what a run read unspent is right when the run failed for a reason
 * that passes. A failure that is the same every time (an attachment no model
 * will take, a reply Telegram will not parse) would otherwise keep every later
 * run on the same items for good, posting nothing and telling an admin each
 * time. So each cursor held at the same place for STUCK_RUNS runs and
 * STUCK_FOR_MS is moved past what the first of those runs saw, and no
 * further: anything that arrived since gets its own chance. One message says so.
 */
async function unspent(a: Automation, member: Member | undefined, staged: StagedCursor[], why: string): Promise<void> {
  const last = new Map<string, StagedCursor>()
  for (const s of staged) last.set(s.key, s)
  if (last.size === 0) return
  const now = Date.now()
  const stuck = await readStuck(a)
  const moved: Stuck[] = []
  // Per cursor: a mailbox whose fetch fails some runs, and so stages nothing
  // then, neither resets nor stands in for another held at the same place.
  for (const s of last.values()) {
    const from = s.prev?.at ?? '-'
    const was = stuck[s.key]
    const entry: Stuck = was?.from === from ? { ...was, runs: was.runs + 1 } : { from, since: new Date(now).toISOString(), runs: 1, move: s }
    if (entry.runs >= STUCK_RUNS && now - Date.parse(entry.since) >= STUCK_FOR_MS) {
      moved.push(entry)
      delete stuck[s.key]
    } else {
      stuck[s.key] = entry
    }
  }
  if (moved.length) await commitCursors(moved.map((m) => m.move))
  await writeStuck(a, stuck)
  if (!moved.length) return
  const runs = Math.max(...moved.map((m) => m.runs))
  await tellAdminQuietly(
    member,
    `**${a.label}** failed on the same new items ${runs} runs running (${why}), so I have moved past them without posting them: ` +
      `${moved.map(describeMove).join('; ')}. The failures above say why; anything since then is still new.`,
  )
}

/** A run that spent what it read clears those cursors from the stuck guard. Best effort: the post is what matters. */
async function spentClean(a: Automation, staged: StagedCursor[]): Promise<void> {
  await commitCursors(staged)
  try {
    const stuck = await readStuck(a)
    const held = staged.filter((s) => stuck[s.key])
    if (!held.length) return
    for (const s of held) delete stuck[s.key]
    await writeStuck(a, stuck)
  } catch (err) {
    console.error('[tick] stuck guard failed:', describeError(err))
  }
}

/** Telegram turning the chat itself away, rather than failing this once. */
const refusedChat = (err: unknown) =>
  err instanceof GrammyError &&
  (err.error_code === 403 ||
    (err.error_code === 400 &&
      /chat not found|upgraded to a supergroup|rights to send|CHAT_WRITE_FORBIDDEN|CHAT_RESTRICTED|TOPIC_CLOSED/i.test(err.description)))

/** Allowed by the env seed or by an admin's grant, as the webhook judges it. */
async function allowedPerson(telegramUserId: string): Promise<boolean> {
  if (idSet('ALLOWED_TELEGRAM_IDS').has(telegramUserId)) return true
  return (await memberByTelegramId(telegramUserId))?.allowed === true
}

/**
 * Tell an admin why a room is being left alone, once per change in what
 * Telegram says about it rather than every hour it stays that way. `what` is
 * the thing held back: a post, or the watchers a new room would have had.
 */
async function sayUnaccounted(chatId: string, room: string, unaccounted: number | null, what: string): Promise<void> {
  const key = `unaccounted:${chatId}`
  const said = await getSetting(key)
  if (unaccounted === 0) {
    if (said && said !== '0') await setSetting(key, '0')
    return
  }
  const count = unaccounted === null ? 'unknown' : String(unaccounted)
  if (said === count) return
  await setSetting(key, count)
  await tellAdminQuietly(
    undefined,
    unaccounted === null
      ? `${what} in ${room}: Telegram would not say who is there. ` +
          'I may have been removed, or the group hides its members; making me an admin there lets me see them.'
      : `${what} in ${room}: Telegram counts ${unaccounted} ${unaccounted === 1 ? 'person' : 'people'} there ` +
          'I cannot match to an allowed member. If they are family, have them send a message there or `/allow` them; ' +
          'otherwise remove them. Making me an admin in the group also lets me see everyone who is in it.',
  )
}

/** True when a group holds people the household cannot account for, so nothing goes in unasked. */
async function heldForHeadcount(a: Automation): Promise<boolean> {
  const unaccounted = await unaccountedIn(a.chatId)
  await sayUnaccounted(a.chatId, `chat ${a.chatId}`, unaccounted, `**${a.label}** was not posted`)
  if (unaccounted === 0) return false
  console.info(`[tick] ${a.label}: ${unaccounted ?? 'unknown'} unrecognised people in chat ${a.chatId}, not posting`)
  return true
}

async function runDue(): Promise<{ ran: number; skipped: number }> {
  const now = new Date()
  const due = await dueAutomations(now)
  let ran = 0
  let skipped = 0

  for (const a of due) {
    // Claim before running: an overlapping tick then finds nothing to do.
    const following = nextRun(a.cronExpr, new Date(now.getTime() + 1000))
    if (!(await claimAutomation(a.id, now, following))) {
      console.info(`[tick] ${a.label}: already claimed by another tick, skipped`)
      skipped++
      continue
    }

    // The house rule for a room holds for what is posted into it unasked:
    // nothing while someone unrecognised is there. The run is claimed all the
    // same, so a morning brief does not turn up mid-afternoon once they leave.
    if (isGroupChat(a.chatId) && (await strangersIn(a.chatId)).length > 0) {
      console.info(`[tick] ${a.label}: someone unrecognised is in chat ${a.chatId}, not posting`)
      skipped++
      continue
    }

    try {
      // A private chat is one person's. Revoked or removed, they hear nothing
      // more from the household, whoever set the automation up.
      if (!isGroupChat(a.chatId) && !(await allowedPerson(a.chatId))) {
        console.info(`[tick] ${a.label}: chat ${a.chatId} belongs to someone no longer allowed, not posting`)
        skipped++
        continue
      }
      // And the same test holds for whoever the room cannot see: a group whose
      // head count is more than the bot and the allowed members in it.
      if (isGroupChat(a.chatId) && (await heldForHeadcount(a))) {
        skipped++
        continue
      }

      const creator = a.memberId
        ? (await db().select().from(schema.members).where(eq(schema.members.id, a.memberId)).limit(1))[0]
        : undefined
      // A custom automation runs its author's own words with the household's
      // read tools. With the author revoked, those words are a stranger's, so
      // it is paused rather than run (deleting a member pauses theirs up front,
      // before the row that says whose it was goes). A ready-made watcher's
      // instruction comes from code, and the room keeps it.
      if (!isWatcherKind(a.kind) && a.memberId && !creator?.allowed) {
        await setAutomationEnabled(a.id, false)
        console.info(`[tick] ${a.label}: whoever set it up is no longer allowed, paused`)
        await tellAdminQuietly(
          undefined,
          `Paused **${a.label}**: whoever set it up is no longer allowed, so its instruction is not run. ` +
            'Resume it from Home if the household still wants it.',
        )
        skipped++
        continue
      }
      // Nothing runs as someone who has been revoked: not their mailbox, and
      // not the first DM when a draft is held back.
      const member = creator?.allowed ? creator : undefined

      if (isWatcherKind(a.kind)) await runReadyMade(a.kind, a, member)
      else await runCustom(a, member)
      ran++
    } catch (err) {
      console.error(`[tick] automation ${a.id} failed:`, err)
      const reason = describeError(err)
      try {
        if (refusedChat(err)) {
          // Telegram will refuse this chat every hour from now on (the bot was
          // removed, or the person blocked it), and what the run read stays
          // unspent, so each hour would fetch, write and fail again. Paused, once.
          await setAutomationEnabled(a.id, false)
          await tellAdminQuietly(
            undefined,
            `Paused **${a.label}**: Telegram will not let me post in chat ${a.chatId} (${reason}). Resume it from Home once I can post there again.`,
          )
        } else {
          await tellAdminQuietly(undefined, `Watcher **${a.label}** failed: ${reason}`)
        }
      } catch (sendErr) {
        // One broken automation must not stop the rest of the tick.
        console.error(`[tick] could not report automation ${a.id} failure:`, sendErr)
      }
    }
  }

  return { ran, skipped }
}

export async function POST(req: Request) {
  // Automations run the agent and message Telegram, so dashboard-managed
  // settings must be hydrated the same as on the webhook path.
  await hydrateSecrets()
  const body = await req.text()
  const via = await authorised(req, body)
  if (!via) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  // The pulse the System page shows: a scheduler that has gone quiet is the
  // failure mode that otherwise presents as reminders silently not firing.
  // Only the scheduler's own calls count: the gap between its last two is the
  // grid every automation's timing is judged against, and a manual poke
  // would put a phantom tick on it.
  if (via === 'scheduler') {
    try {
      await recordTick(new Date())
    } catch (err) {
      console.error('[tick] could not record the tick:', err)
    }
  }
  // The built-in watchers are part of the product: every household group has
  // them, kept in step with their definitions, before anything due is run.
  try {
    const builtins = await installBuiltins(new Date(), {
      counted: (room, unaccounted) =>
        sayUnaccounted(room.chatId, room.title ?? `chat ${room.chatId}`, unaccounted, 'The built-in watchers were not set up'),
    })
    if (builtins.installed.length || builtins.converted || builtins.retired || builtins.synced) {
      console.info('[tick] built-in watchers:', JSON.stringify(builtins))
    }
  } catch (err) {
    console.error('[tick] could not install the built-in watchers:', err)
  }
  const result = await runDue()
  await maybeConsolidateMemory(new Date())
  await pruneModelEvents(30)
  // A proposal whose occasion has passed, or whose event got to the calendar
  // another way, is no longer a question for anyone. The lists already hide
  // these; this writes down why.
  try {
    const { expired, superseded } = await retireStaleProposals(new Date())
    if (expired || superseded) console.info(`[tick] proposals retired: ${expired} expired, ${superseded} already on the calendar`)
  } catch (err) {
    console.error('[tick] could not retire stale proposals:', err)
  }
  await flushTelemetry()
  return NextResponse.json({ ok: true, ...result })
}

export async function GET(req: Request) {
  // Vercel Cron sends GET; QStash sends POST. Both land here.
  return POST(new Request(req.url, { method: 'POST', headers: req.headers, body: '' }))
}
