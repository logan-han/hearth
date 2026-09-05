import { NextResponse } from 'next/server'
import { Receiver } from '@upstash/qstash'
import {
  dueAutomations, claimAutomation, allowedMembers, recordMessage,
  messagesSince, getSetting, setSetting, retireStaleProposals,
} from '@/lib/db/queries'
import { localDateKey, tzOffsetMs, nextRun } from '@/lib/cron'
import { timezone } from '@/lib/env'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { runAgent, decideWatcherPost, reviewDraft, type AgentResult } from '@/lib/agent'
import { buildTools, type ToolName } from '@/lib/tools'
import type { ToolContext } from '@/lib/tools/context'
import { WATCHERS, isWatcherKind, type WatcherKind } from '@/lib/watchers'
import { send } from '@/lib/telegram'
import { hydrateSecrets } from '@/lib/settings'
import { flushTelemetry } from '@/lib/telemetry'
import { parseLog, prune, underCap, recordPost, shouldWarn, markWarned, PROACTIVE_POSTS_PER_HOUR } from '@/lib/rate-cap'
import type { Automation, Member } from '@/lib/db/schema'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/** A draft posts only when the decision is post and at least this sure. */
const POST_CONFIDENCE = 0.7

/** QStash signs every delivery; without keys we only accept a manual admin secret. */
async function authorised(req: Request, body: string): Promise<boolean> {
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY
  const next = process.env.QSTASH_NEXT_SIGNING_KEY
  const signature = req.headers.get('upstash-signature')

  if (current && signature) {
    try {
      const receiver = new Receiver({ currentSigningKey: current, nextSigningKey: next ?? current })
      return await receiver.verify({ signature, body, url: req.url })
    } catch (err) {
      console.warn('[tick] signature verification failed:', err)
      return false
    }
  }

  const adminSecret = process.env.TICK_SECRET
  return Boolean(adminSecret) && req.headers.get('x-tick-secret') === adminSecret
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

/** Telegram gives groups negative ids; a private chat's id is the person's own. */
const isGroupChat = (chatId: string) => chatId.startsWith('-')

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

type Fetched = { data: Record<string, unknown>; empty: boolean; problems: string[] }

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
    case 'inbox': {
      const r = await runTool(tools, 'new_mail', { limit: 10, everyone: isGroupChat(a.chatId) })
      const err = errorOf(r)
      if (err) problems.push(`new_mail: ${err}`)
      const accounts = Array.isArray(r.accounts) ? (r.accounts as Record<string, unknown>[]) : []
      let count = 0
      for (const acct of accounts) {
        const e = errorOf(acct)
        if (e) problems.push(`new_mail (${String(acct.member)}, ${String(acct.provider)}): ${e}`)
        if (Array.isArray(acct.messages)) count += acct.messages.length
      }
      return { data: { mail: r }, empty: count === 0, problems }
    }
    case 'morning': {
      const day = localDateKey(ctx.now)
      const [events, board, weather] = await Promise.all([
        runTool(tools, 'list_family_events', { from: `${day}T00:00`, to: `${day}T23:59`, include_cancelled: false }),
        runTool(tools, 'jira_board_summary', {}),
        runTool(tools, 'weather', {}),
      ])
      const eventsErr = errorOf(events)
      if (eventsErr) problems.push(`list_family_events: ${eventsErr}`)
      for (const [name, r] of [['jira_board_summary', board], ['weather', weather]] as const) {
        const e = errorOf(r)
        if (e && !isUnconfigured(e)) problems.push(`${name}: ${e}`)
      }
      const todays = Array.isArray(events.events) ? events.events : []
      const overdue = Array.isArray(board.overdue) ? board.overdue : []
      const data: Record<string, unknown> = { events }
      if (!errorOf(board)) data.board = board
      if (!errorOf(weather)) data.weather = weather
      // A day with nothing on and nothing due gets no brief; weather alone is
      // not news the household needs pushed at it.
      return { data, empty: todays.length === 0 && overdue.length === 0, problems }
    }
  }
}

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
    return
  }

  const watcher = WATCHERS[kind]
  const familyNote = kind === 'inbox' && isGroupChat(a.chatId) ? ' Say whose mailbox each item came from.' : ''
  const data = JSON.stringify(fetched.data, null, 1)
  const result = await runAgent({
    chatId: a.chatId,
    chatType: isGroupChat(a.chatId) ? 'group' : 'private',
    member: member ?? null,
    memberName,
    mode: 'watcher',
    tools: watcher.tools,
    history: false,
    text: `Scheduled check "${a.label}".\n\n${watcher.instruction}${familyNote}\n\nDATA (fetched just now):\n${data}`,
  })
  await deliver(a, member, result, `INSTRUCTION:\n${watcher.instruction}\n\nDATA:\n${data}\n\nTOOL RESULTS:\n${result.evidence || '(none)'}`)
}

/** A member's own scheduled instruction: the model decides what to fetch, with read-only tools. */
async function runCustom(a: Automation, member: Member | undefined): Promise<void> {
  const result = await runAgent({
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
  })
  await deliver(a, member, result, `INSTRUCTION:\n${a.instruction}\n\nTOOL RESULTS:\n${result.evidence || '(none)'}`)
}

/**
 * Post-or-skip is decided in a fresh context against the evidence, with
 * announced payoffs and a confidence, rather than left to the model that
 * wrote the draft. If the decision itself cannot be made (a provider that
 * will not return the structured object) the draft goes out as it always
 * did, and an admin hears that the safety net was down.
 */
async function approve(a: Automation, member: Member | undefined, draft: string, evidence: string): Promise<string | null> {
  // First the factored check: each claim against the evidence, in a context
  // that never sees the draft. What fails is cut; if nothing survives, silence.
  let reviewed = draft
  try {
    const review = await reviewDraft({ label: a.label, draft, evidence })
    if (review.message === null) {
      console.warn(`[tick] ${a.label}: held back, no claim survived the check: ${review.unsupported.join(' | ')}`)
      return null
    }
    if (review.unsupported.length) {
      console.warn(`[tick] ${a.label}: cut ${review.unsupported.length} unsupported claim(s): ${review.unsupported.join(' | ')}`)
    }
    reviewed = review.message
  } catch (err) {
    console.error(`[tick] ${a.label}: claim check unavailable, deciding on the raw draft:`, err instanceof Error ? err.message : err)
  }
  try {
    const d = await decideWatcherPost({ label: a.label, draft: reviewed, evidence })
    console.info(
      '[tick] decision',
      JSON.stringify({ label: a.label, decision: d.decision, confidence: d.confidence, model: d.model, reason: d.reason ?? null }),
    )
    if (d.decision === 'post' && d.confidence >= POST_CONFIDENCE) return d.message?.trim() || reviewed
    console.warn(`[tick] ${a.label}: held back (${d.decision} at ${d.confidence.toFixed(2)})${d.reason ? `: ${d.reason}` : ''}`)
    return null
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
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
async function deliver(a: Automation, member: Member | undefined, result: AgentResult, evidence: string): Promise<void> {
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
  if (!draft.skip && draft.rest) {
    const approved = await approve(a, member, draft.rest, evidence)
    if (approved) parts.push(approved)
  }
  parts.push(...notices.filter((n) => !parts.some((p) => p.includes(n))))

  const message = parts.join('\n\n').trim()
  if (!message) return

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
    return
  }

  await send(a.chatId, message)
  await setSetting(capKey, JSON.stringify(recordPost(log, now)))
  await db().insert(schema.messages).values({
    chatId: a.chatId,
    role: 'assistant',
    content: message,
    model: result.model,
  })
}

async function runDue(): Promise<{ ran: number; skipped: number }> {
  const now = new Date()
  const due = await dueAutomations(now)
  let ran = 0
  let skipped = 0

  for (const a of due) {
    // Claim before running: an overlapping tick then finds nothing to do.
    const following = nextRun(a.cronExpr, new Date(now.getTime() + 1000))
    if (!(await claimAutomation(a.id, a.nextRunAt, following))) {
      skipped++
      continue
    }

    try {
      const member = a.memberId
        ? (await db().select().from(schema.members).where(eq(schema.members.id, a.memberId)).limit(1))[0]
        : undefined

      if (isWatcherKind(a.kind)) await runReadyMade(a.kind, a, member)
      else await runCustom(a, member)
      ran++
    } catch (err) {
      console.error(`[tick] automation ${a.id} failed:`, err)
      const reason = err instanceof Error ? err.message : String(err)
      try {
        await tellAdminQuietly(undefined, `Watcher **${a.label}** failed: ${reason}`)
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
  if (!(await authorised(req, body))) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  const result = await runDue()
  await maybeConsolidateMemory(new Date())
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
