import { NextResponse } from 'next/server'
import { APICallError, RetryError } from 'ai'
import { Receiver } from '@upstash/qstash'
import {
  dueAutomations, claimAutomation, getSetting, retireStaleProposals, recordTick, setAutomationEnabled,
  deleteAutomation, pruneActivity, pruneReports, getHelper, memberById, addReport, setSetting, type ReportStatus,
} from '@/lib/db/queries'
import { nextRun, formatLocal, clockLine } from '@/lib/cron'
import { retryTickAt } from '@/lib/scheduler'
import { runAgent, decideWatcherPost, reviewDraft, cutFromDraft, looksBefore, scheduledInstruction, TURN_BUDGET_MS, type AgentResult } from '@/lib/agent'
import { commitCursors, type StagedCursor } from '@/lib/tools/cursor'
import { hydrateSecrets, recheckSecrets } from '@/lib/settings'
import { flushTelemetry, traced, traceRun, noteRun } from '@/lib/telemetry'
import { pruneModelEvents } from '@/lib/model-events'
import { pruneUsedCodes } from '@/lib/oauth/server'
import type { Automation, Helper, Member } from '@/lib/db/schema'
import { describeError } from '@/lib/errors'

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
 * Keep something for the member who set an automation up: what it found, a
 * draft the checks held back, or what went wrong. Nothing is posted
 * anywhere, so it waits in their reports until their MCP client or Home reads
 * it. A report that cannot be written is logged, and never fails the run.
 */
async function report(
  a: Automation,
  member: Member,
  status: ReportStatus,
  body: string,
  extra: { detail?: string | null; helper?: Helper } = {},
): Promise<void> {
  try {
    await addReport({ memberId: member.id, automationId: a.id, label: a.label, helper: extra.helper?.name ?? null, status, body, detail: extra.detail ?? null })
  } catch (err) {
    console.error(`[tick] could not keep a report for ${a.label}:`, describeError(err), body)
  }
}

const isSkipLine = (line: string) => /^skip[.!]*$/i.test(line.trim())
/** A marked failure, and nothing else, is what earns a problem report. */
const isProblemLine = (line: string) => /^\**\s*problem\s*\**\s*:/i.test(line.trim())

/** The Known facts the writer had in view, so the checks judge the draft against the same sources. */
const factsGiven = (r: AgentResult) => (r.facts ? `${r.facts}\n\n` : '')

/**
 * Vercel ends the tick at maxDuration, and a run cut off there is lost: it
 * was claimed, so it is not due again until its next time. So the tick keeps
 * one clock from its start, and every run and check it makes is over this far
 * in, which leaves the last report, its records and the traces the rest.
 */
const TICK_BUDGET_MS = 280_000
/**
 * How much of the end of the tick a run leaves for its draft's checks. The
 * claim check has the first half and the decision the second, so the last
 * gate a draft passes is still asked when the claim check ran long.
 */
const REVIEW_RESERVE_MS = 60_000
const DECISION_RESERVE_MS = 30_000

/**
 * A member's own scheduled instruction: the model decides what to fetch, with
 * read-only tools. One handed to a helper runs in that helper's role and its
 * report carries the helper's name; a helper removed since leaves the job to
 * Hearth itself.
 */
async function runCustom(a: Automation, member: Member, deadline: number): Promise<Delivered> {
  const helper = a.helperId ? await getHelper(a.helperId).catch((): Helper | undefined => undefined) : undefined
  noteRun({ input: `INSTRUCTION:\n${a.instruction}`, ...(helper ? { metadata: { helper: helper.name } } : {}) })
  const result = await counted(a, member, looksBefore, () => runAgent({
    // Its author's words, run as its author: their mailbox alone.
    member,
    memberName: member.name,
    helper,
    // Its own markers for what is new: a watch that looks at mail hourly
    // would otherwise spend what the morning brief and the member's own
    // clients are there to show.
    cursorScope: `auto:${a.id}`,
    text: scheduledInstruction(a, member.name),
    deadline: deadline - REVIEW_RESERVE_MS,
  }))
  const staged = () => result.cursors ?? []
  const evidence = `${clockLine(new Date())}\n\nINSTRUCTION:\n${a.instruction}\n\n${factsGiven(result)}TOOL RESULTS:\n${result.evidence || '(none)'}`
  noteRun({ input: evidence, metadata: { writer: result.model } })
  return counted(a, member, staged, () => deliver(a, member, result, evidence, () => spentClean(a, staged()), deadline, helper))
}

/**
 * A check that runs until it finds what it is waiting for stops for good once
 * it reports (its writer is told so; see scheduledInstruction), and the report
 * says in code that it has stopped: the member then knows to ask again if it
 * was not the thing they meant.
 */
const UNTIL_FOUND = "That's what it was waiting for, so it has stopped checking. Ask again if it should keep watching."

/**
 * A one-off once it has had its run, and a watch-until once it has found
 * something, has done its job and leaves the list, so Home shows only what is
 * still to come. Its reports stay. A failure here leaves a row that will not
 * run again, and is logged.
 */
async function retire(a: Automation, why: string): Promise<void> {
  try {
    await deleteAutomation(a.id)
    noteRun({ metadata: { retired: why } })
  } catch (err) {
    console.error(`[tick] could not remove ${a.label} after ${why}:`, describeError(err))
  }
}

/**
 * Run one step of an automation, counting it against the stuck guard when it
 * leaves what the run read unspent: a throw, or deliver() reporting a PROBLEM.
 * A failure of the model chain or the network passes, and says nothing about
 * the items, so it is not counted. The guard's own failure never hides the run's.
 */
async function counted<T>(
  a: Automation,
  member: Member,
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
 * it stands) is about what was sent, and counts. Judged on the error itself
 * where it says, and on its words only where it does not.
 */
function passing(err: unknown): boolean {
  if (RetryError.isInstance(err)) return passing(err.lastError)
  if (APICallError.isInstance(err)) {
    if (err.isRetryable || err.statusCode === undefined || ![400, 413, 422].includes(err.statusCode)) return true
    // A 400 can still be the key (Gemini answers a bad one that way).
    return PASSING_WORDS.test(err.message)
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return true
  return PASSING_WORDS.test(describeError(err))
}

/**
 * A PROBLEM line is the model's own words, and a status or a timeout there is
 * as likely the item's (a link in the mail that answered 403, an attachment
 * that took too long) as a service's. Only words that can only be a service
 * down, unset or with its link lapsed let one pass.
 */
const SERVICE_PROBLEM =
  /rate.?limit|quota|too many requests|service unavailable|temporarily unavailable|overloaded|ECONNREFUSED|ECONNRESET|EAI_AGAIN|cannot connect|not configured|not connected|api key|insufficient credits|expired or been revoked|reconnect|link (?:it|one) again/i

/**
 * approve()'s answer for a draft it held back that no judge ruled on. The
 * next run may well be judged in time, so unlike a draft the checks held
 * back, what this one read is not spent with it.
 */
const UNJUDGED = Symbol('unjudged')

/** What the checks made of a draft: kept, perhaps changed and with a note on how, held back with why, or never judged. */
type Approval = { kept: string; note?: string } | { held: string; draft: string } | typeof UNJUDGED

/**
 * The second round for a checked draft the decision faulted on one
 * statement: that statement cut, and what is left put to the decision again.
 * The cut draft is a rewrite nobody has checked since, so it is judged on the
 * full line. Hands back the draft to keep, or what to add to the reason when
 * it is still held. Nothing here throws, and nothing here is UNJUDGED: the
 * judge ruled once, and a second round that cannot be run (no model, no time)
 * leaves that ruling standing.
 */
async function cutAndRejudge(
  a: Automation,
  draft: string,
  statement: string,
  evidence: string,
  deadline: number,
): Promise<{ kept?: string; why: string }> {
  try {
    const rest = await cutFromDraft({ label: a.label, draft, unsupported: [statement], deadline })
    if (!rest) return { why: '; cutting it left nothing to report' }
    const d = await decideWatcherPost({ label: a.label, draft: rest, evidence, verified: false, deadline })
    console.info(
      '[tick] decision',
      JSON.stringify({ label: a.label, decision: d.decision, confidence: d.confidence, verified: false, model: d.model, reason: d.reason ?? null, cut: statement }),
    )
    noteRun({
      metadata: { second_decision: d.decision, second_confidence: d.confidence },
      detail: { judge_cut: statement, ...(d.reason ? { second_reason: d.reason } : {}) },
    })
    if (d.decision !== 'post') {
      return { why: `; with it cut, the check said ${d.decision} at ${d.confidence.toFixed(2)}${d.reason ? `: ${d.reason}` : ''}` }
    }
    console.warn(`[tick] ${a.label}: cut the statement the check faulted, and the rest passed: ${statement}`)
    return { kept: rest, why: '' }
  } catch (err) {
    return { why: `; it could not be cut and judged again (${describeError(err)})` }
  }
}

/**
 * Keep or hold back is decided in a fresh context against the evidence, by a
 * judge that answers two questions and never sees the writer's draft as its
 * own. The judge draws its own line (in lib/agent.ts) and what comes back is
 * honoured as decided. If the decision itself cannot be made (a provider
 * that will not return the structured object) the draft is kept as it always
 * was, marked as unchecked; a decision the tick ran out of time for holds the
 * draft back instead, as the judges were not all asked, and answers UNJUDGED
 * so that what the run read stays new. A draft held back at either step is
 * still kept for its member, marked held, with the reason.
 *
 * What is kept is the reviewed draft itself, never a retype from the
 * decision: the decision once offered its own wording, and that is what
 * turned a formatted snapshot into plain lines and brought back entries the
 * check had never seen.
 */
async function approve(a: Automation, draft: string, evidence: string, deadline: number): Promise<Approval> {
  // First the factored check: each claim against the evidence, in a context
  // that never sees the draft. What fails is cut; if nothing survives, or
  // what failed could not be cut, the draft is held.
  let reviewed = draft
  // Whether that check went through this draft and passed it whole: it pulled
  // statements out, every one was put to the checker against this evidence,
  // and every one came back supported. The decision below asks its own
  // grounding question of the draft all at once, which is the coarser of the
  // two and drifts up with the draft's length, so what it takes to override a
  // check that has already passed is set where the line is, in lib/agent.ts. A
  // check that could not run, or one whose rewrite put back a draft nobody has
  // checked since, leaves this false and the full line stands.
  let verified = false
  // What the check took out, for the reason if the decision then holds the
  // rest back, or for the note on what was kept.
  let cut: string[] = []
  try {
    const review = await reviewDraft({ label: a.label, draft, evidence, deadline: deadline - DECISION_RESERVE_MS })
    if (review.message === null) {
      // A rewrite the tick's own clock stopped is no judge refusing the
      // draft, only one not asked in time, so what the run read stays new,
      // as it does for a decision the clock stopped.
      const outOfTime = review.rewriteFailed !== undefined && Date.now() >= deadline - DECISION_RESERVE_MS - 1_000
      const why = outOfTime
        ? `the tick ran out of time to cut out claims that failed the check: ${review.unsupported.join(' | ')}`
        : review.rewriteFailed
          ? `claims failed the check and could not be cut out (${review.rewriteFailed}): ${review.unsupported.join(' | ')}`
          : `no claim survived the check: ${review.unsupported.join(' | ')}`
      console.warn(`[tick] ${a.label}: held back, ${why}`)
      noteRun({ metadata: { claims: review.claims.length, unsupported: review.unsupported.length }, detail: { held_because: why } })
      return outOfTime ? UNJUDGED : { held: why, draft }
    }
    if (review.unsupported.length) {
      console.warn(`[tick] ${a.label}: cut ${review.unsupported.length} unsupported claim(s): ${review.unsupported.join(' | ')}`)
    }
    cut = review.unsupported
    reviewed = review.message
    verified = review.claims.length > 0 && review.unsupported.length === 0
    noteRun({
      metadata: { claims: review.claims.length, unsupported: review.unsupported.length, verified },
      ...(cut.length ? { detail: { check_cut: cut } } : {}),
    })
  } catch (err) {
    console.error(`[tick] ${a.label}: claim check unavailable, deciding on the raw draft:`, describeError(err))
    noteRun({ metadata: { claim_check: 'unavailable' } })
  }
  const cutNote = cut.length ? `The claim check cut: ${cut.join(' | ')}` : undefined
  try {
    const d = await decideWatcherPost({ label: a.label, draft: reviewed, evidence, verified, deadline })
    console.info(
      '[tick] decision',
      JSON.stringify({ label: a.label, decision: d.decision, confidence: d.confidence, verified, model: d.model, reason: d.reason ?? null }),
    )
    noteRun({ metadata: { decision: d.decision, confidence: d.confidence, judge: d.model }, ...(d.reason ? { detail: { reason: d.reason } } : {}) })
    if (d.decision === 'post') return { kept: reviewed, ...(cutNote ? { note: cutNote } : {}) }
    let why = `the check said ${d.decision} at ${d.confidence.toFixed(2)}${d.reason ? `: ${d.reason}` : ''}`
    // A draft the claim check passed whole, which the judge faults on one
    // statement it quotes: that statement is cut, as a claim that fails the
    // check is, and the rest is judged once more rather than going down with
    // it. A whole brief was once lost that way over a To do a later email had
    // answered: the check passed it (the request says it) and the judge read
    // it with the later mail beside it.
    if (verified && d.notInEvidence) {
      const again = await cutAndRejudge(a, reviewed, d.notInEvidence, evidence, deadline)
      if (again.kept !== undefined) return { kept: again.kept, note: `One statement the check found no evidence for was cut: ${d.notInEvidence}` }
      why += again.why
    }
    if (cutNote) why += `. ${cutNote}`
    console.warn(`[tick] ${a.label}: held back, ${why}`)
    return { held: why, draft: reviewed }
  } catch (err) {
    const reason = describeError(err)
    // The tick's own clock stopping the judges is not every judge down: the
    // rest of the chain was never asked, and a draft is kept unchecked only
    // when none could answer it. So it is held back like any other the checks
    // did not pass. A second's slack, as a timer can fire a little early by
    // the wall clock.
    if (Date.now() >= deadline - 1_000) {
      console.warn(`[tick] ${a.label}: held back, the tick ran out of time for the decision:`, reason)
      noteRun({ metadata: { decision: 'out of time' } })
      return UNJUDGED
    }
    console.error(`[tick] ${a.label}: decision unavailable, keeping the draft:`, reason)
    noteRun({ metadata: { decision: 'unavailable, kept unchecked' }, detail: { decision_error: reason } })
    return { kept: reviewed, note: [`Not checked against its evidence: the check failed (${reason}).`, cutNote].filter(Boolean).join(' ') }
  }
}

/**
 * What became of a run's output: kept as a report and what it read spent; a
 * draft the checks held back, kept marked as held and what it read spent;
 * spent with nothing kept (quiet by choice); a PROBLEM; or a service that was
 * down or a draft nobody had time to judge.
 */
type Delivered = 'kept' | 'held' | 'spent' | 'problem' | 'unavailable'

/**
 * Turn a run's output into at most one report. A lone SKIP line keeps the
 * draft from being a report whatever else it says; a marked PROBLEM is kept
 * as a problem report; the draft itself is kept once approved, or marked as
 * held with why. `spent` marks what the run read as seen, and is called once
 * a report is kept, or the run deliberately kept nothing: a plain SKIP, or a
 * draft the checks held back (the member has it, marked). A PROBLEM, or a
 * draft the tick ran out of time to judge, leaves it new for the next run,
 * with one exception: a run that wrote something unrepeatable on the strength
 * of it (a list item, a reminder) spends it whatever else happened, or the
 * next run would write it again. Says which it was.
 */
async function deliver(
  a: Automation,
  member: Member,
  result: AgentResult,
  evidence: string,
  spent: () => Promise<void>,
  deadline: number,
  /** The helper whose job this was, whose name the report carries. */
  helper?: Helper,
): Promise<Delivered> {
  const lines = result.text.split('\n')
  const skip = lines.some(isSkipLine)
  const rest = skip ? lines.filter((l) => !isSkipLine(l)).join('\n').trim() : result.text.trim()

  // Staying quiet is the normal outcome, not news: only a marked PROBLEM
  // becomes a report. Anything else written beside SKIP is the model
  // narrating why it said nothing, and that belongs in the logs.
  const problems = skip ? rest.split('\n').filter(isProblemLine) : []
  if (problems.length) {
    await report(a, member, 'problem', problems.join('\n'), { helper })
  } else if (skip && rest) {
    console.warn(`[tick] ${a.label} stayed quiet:`, rest)
  }

  if (skip || !rest) {
    const outcome = problems.length ? 'problem' : 'skipped'
    noteRun({ output: rest || result.text, metadata: { outcome }, ...(outcome === 'skipped' ? {} : { level: 'WARNING' as const }) })
    // Quiet by choice is the run done with what it read. A run that could not
    // do its job (a PROBLEM) leaves it for the next, unless it wrote on it.
    if (problems.length === 0 || result.wrote?.length) {
      await spent()
      return 'spent'
    }
    // Counted against the stuck guard only when a problem is about what was
    // read, not a tool whose service is down or whose link has lapsed.
    return problems.every((line) => SERVICE_PROBLEM.test(line)) ? 'unavailable' : 'problem'
  }

  // What a groundedness evaluator filters on: this run wrote a draft and put it to the checks.
  noteRun({ metadata: { draft: 'yes' } })
  const approved = await approve(a, rest, evidence, deadline)
  if (approved === UNJUDGED) {
    noteRun({ output: rest, metadata: { outcome: 'held back unjudged' }, level: 'WARNING' })
    // Nobody ruled on it, so what it read has reached nobody and stays new;
    // unless the run wrote on it, when the draft is all there is of what it read.
    if (!result.wrote?.length) return 'unavailable'
    await spent()
    await report(a, member, 'held', rest, { helper, detail: 'The tick ran out of time before the checks could finish, after the run had already acted on what it read.' })
    return 'held'
  }
  if ('held' in approved) {
    noteRun({ output: approved.draft, metadata: { outcome: 'held back' }, level: 'WARNING' })
    await spent()
    const stopped = a.repeat === 'until' ? ' It found something, so it has stopped watching; ask again if it should keep watching.' : ''
    await report(a, member, 'held', approved.draft, { helper, detail: `Held back: ${approved.held}.${stopped}` })
    return 'held'
  }

  // A watch-until that reports has found what it waited for, and is retired
  // once this is kept; the member hears so in code, not in the writer's words.
  const notes = [
    approved.note,
    result.cutShort ? 'The output allowance cut it short, so it lost its unfinished end.' : undefined,
    a.repeat === 'until' ? UNTIL_FOUND : undefined,
  ].filter(Boolean)
  // Spent the moment it is kept, so the bookkeeping below cannot bring it round again.
  await spent()
  await report(a, member, 'ready', approved.kept, { helper, detail: notes.length ? notes.join(' ') : null })
  noteRun({
    output: approved.kept,
    metadata: { outcome: 'kept', ...(result.cutShort ? { cut_short: true } : {}) },
    ...(result.cutShort ? { level: 'WARNING' as const } : {}),
  })
  return 'kept'
}

/**
 * How many runs in a row, and over how long, may leave the same new items
 * unspent before they are moved past. The span keeps an hourly watch from
 * skipping anything over a bad morning.
 */
const STUCK_RUNS = 3
const STUCK_FOR_MS = 12 * 3600_000
/**
 * A count not added to in this long is forgotten: a failure that has stopped
 * repeating is not stuck, and a mailbox unlinked meanwhile must not have its
 * old place committed onto it when it is linked again. Longer than a week, so
 * a weekly automation's runs still count as in a row.
 */
const STUCK_FORGOTTEN_MS = 8 * 86_400_000

/** One cursor held at the same place: since when, the last counted run, how many, and the first stuck run's move. */
type Stuck = { from: string; since: string; last: string; runs: number; move: StagedCursor }

async function readStuck(a: Automation): Promise<Record<string, Stuck>> {
  let parsed: unknown
  try {
    parsed = JSON.parse((await getSetting(`unspent:${a.id}`)) || '{}')
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  // Anything unreadable counts as never stuck, and anything left that long as forgotten.
  const cutoff = Date.now() - STUCK_FORGOTTEN_MS
  return Object.fromEntries(
    Object.entries(parsed).filter(
      ([, v]) => typeof v?.from === 'string' && typeof v?.move?.key === 'string' && Date.parse(v?.last ?? v?.since) > cutoff,
    ),
  ) as Record<string, Stuck>
}

const writeStuck = (a: Automation, stuck: Record<string, Stuck>) =>
  setSetting(`unspent:${a.id}`, Object.keys(stuck).length ? JSON.stringify(stuck) : '')

/** The source and the span skipped, which is what the member can go and look at. */
const describeMove = (m: Stuck) => {
  const [kind, ...rest] = m.move.key.split(':')
  const provider = rest.at(-1)
  const what =
    kind === 'mail_cursor' ? `mail in your linked ${provider === 'google' ? 'Gmail' : provider === 'microsoft' ? 'Outlook' : String(provider)} mailbox`
    : 'new items'
  const from = m.from === '-' ? 'up' : `from ${formatLocal(new Date(m.from))}`
  return `${what} ${from} to ${formatLocal(new Date(m.move.at))}`
}

/**
 * Leaving what a run read unspent is right when the run failed for a reason
 * that passes. A failure that is the same every time (an attachment no model
 * will take) would otherwise keep every later run on the same items for good,
 * reporting nothing but the problem each time. So each cursor held at the
 * same place for STUCK_RUNS runs and STUCK_FOR_MS is moved past what the
 * first of those runs saw, and no further: anything that arrived since gets
 * its own chance. One report says so.
 */
async function unspent(a: Automation, member: Member, staged: StagedCursor[], why: string): Promise<void> {
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
    const at = new Date(now).toISOString()
    const entry: Stuck = was?.from === from ? { ...was, last: at, runs: was.runs + 1 } : { from, since: at, last: at, runs: 1, move: s }
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
  await report(
    a,
    member,
    'problem',
    `Failed on the same new items ${runs} runs running (${why}), so it has moved past them without reporting them: ` +
      `${moved.map(describeMove).join('; ')}. The problems before this say why; anything since then is still new.`,
  )
}

/** A run that spent what it read clears those cursors from the stuck guard. Best effort: the report is what matters. */
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

async function runDue(deadline: number): Promise<{ ran: number; skipped: number }> {
  const now = new Date()
  const due = await dueAutomations(now)
  let ran = 0
  let skipped = 0

  for (const [i, a] of due.entries()) {
    // No run starts without room for a whole turn and its checks before the
    // tick's deadline, so the last one started can finish, and whatever is
    // still due stays unclaimed and first in line at the next tick.
    if (deadline - Date.now() < TURN_BUDGET_MS + REVIEW_RESERVE_MS) {
      console.warn(`[tick] out of time: ${due.length - i} due automation(s) left for the next tick`)
      break
    }
    // Claim before running: an overlapping tick then finds nothing to do. A
    // one-off has no time after this one, so the claim switches it off.
    const following = a.repeat === 'once' ? null : nextRun(a.cronExpr, new Date(now.getTime() + 1000))
    if (!(await claimAutomation(a.id, now, following))) {
      console.info(`[tick] ${a.label}: already claimed by another tick, skipped`)
      skipped++
      continue
    }

    const outcome = await traceRun(
      'hearth.watcher',
      { sessionId: `automation-${a.id}`, tags: ['watcher'], metadata: { label: a.label, automation: String(a.id) } },
      async () => {
        const out = await runClaimed(a, deadline)
        // Its one run, whatever came of it.
        if (a.repeat === 'once') await retire(a, 'its one run')
        return out
      },
    )
    if (outcome === 'ran') ran++
    else if (outcome === 'skipped') skipped++
  }

  return { ran, skipped }
}

/**
 * One claimed automation as a trace of its own: why it did not run when it
 * did not, and otherwise what it kept or held back. A failure is reported to
 * its member, and counts as neither run nor skipped.
 */
async function runClaimed(a: Automation, deadline: number): Promise<'ran' | 'skipped' | 'failed'> {
  const notRun = (why: string) => {
    noteRun({ output: why, metadata: { outcome: 'not run' } })
    return 'skipped' as const
  }

  // An automation runs its author's own words with their mailbox and the
  // household's read tools, and its report is theirs. With the author gone
  // or revoked, those words are nobody's or a stranger's, so it is paused
  // rather than run (deleting a member pauses theirs up front).
  const member = a.memberId ? await memberById(a.memberId) : undefined
  if (!member?.allowed) {
    await setAutomationEnabled(a.id, false)
    console.info(`[tick] ${a.label}: whoever set it up is no longer allowed, paused`)
    return notRun('whoever set it up is no longer allowed, so it was paused')
  }

  try {
    // Whoever set it up is the run's user on every call in it, the checks
    // included, not on the writer's alone.
    const delivered = await traced({ userId: String(member.id) }, () => runCustom(a, member, deadline))
    // It found something, kept or held, and what it read is spent: watching
    // on would only check for good, hourly, for what has gone by.
    if (a.repeat === 'until' && delivered === 'kept') await retire(a, 'it found what it was waiting for')
    if (a.repeat === 'until' && delivered === 'held') await retire(a, 'what it found was held back')
    return 'ran'
  } catch (err) {
    console.error(`[tick] automation ${a.id} failed:`, err)
    const reason = describeError(err)
    noteRun({ output: reason, metadata: { outcome: 'failed' }, level: 'ERROR' })
    // One broken automation must not stop the rest of the tick.
    await report(a, member, 'problem', `It failed: ${reason}`)
    return 'failed'
  }
}

export async function POST(req: Request) {
  const deadline = Date.now() + TICK_BUDGET_MS
  // Checked first against the keys this instance already holds, so a
  // stranger's call costs no database read (see recheckSecrets). Automations
  // run the model chain, so dashboard-managed settings are then hydrated
  // and the call checked again.
  const body = await req.text()
  if (await authorised(req, body)) await hydrateSecrets()
  else if (!(await recheckSecrets())) return NextResponse.json({ ok: false }, { status: 401 })
  const via = await authorised(req, body)
  if (!via) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  // The pulse the System page shows: a scheduler that has gone quiet is the
  // failure mode that otherwise presents as reminders silently not firing.
  // Only the scheduler's own calls count: the gap between its last two is the
  // grid every automation's timing is judged against, and a manual poke
  // would put a phantom tick on it. So would QStash trying a failed tick
  // again, seconds or minutes after the time it was due, unless the first try
  // left no stamp: then the retry is all there is of that tick, and it goes
  // down at the time it was due, or the grid would read a missed interval.
  const retried = Number(req.headers.get('upstash-retried')) > 0
  if (via === 'scheduler') {
    try {
      let at: Date | null = new Date()
      if (retried) {
        const [last, prev] = await Promise.all([getSetting('last_tick_at'), getSetting('prev_tick_at')])
        at = retryTickAt(last, prev, at)
      }
      if (at) await recordTick(at)
    } catch (err) {
      console.error('[tick] could not record the tick:', err)
    }
  }
  const result = await runDue(deadline)
  await pruneModelEvents(30)
  // Each member's record of what was changed keeps ninety days, and their reports thirty.
  await pruneActivity(90).catch((err) => console.error('[tick] could not prune the activity log:', describeError(err)))
  await pruneReports(30).catch((err) => console.error('[tick] could not prune the reports:', describeError(err)))
  // A used OAuth code is remembered only until it would have expired anyway.
  await pruneUsedCodes().catch((err) => console.error('[tick] could not prune used OAuth codes:', describeError(err)))
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
