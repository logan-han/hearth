import {
  generateText,
  isStepCount,
  Output,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
} from 'ai'
import { z } from 'zod'
import { withModelFallback, structuredChain, modelChain, EndOnFailure, type ModelSlot } from './model'
import { buildTools, CUSTOM_AUTOMATION_TOOLS, type ToolName } from './tools'
import type { ToolContext } from './tools/context'
import type { StagedCursor } from './tools/cursor'
import { listMemories } from './db/queries'
import type { Member, Helper } from './db/schema'
import { timezone, language, units, reasoningLevel, assistantName } from './env'
import { traced, callTelemetry } from './telemetry'
import { clockLine } from './cron'
import { describeError } from './errors'

const MAX_STEPS = 8
const STEP_TIMEOUT_MS = 60_000
/**
 * How long a scheduled run may take, every model it tries included. The tick
 * is killed at 300 s, and the checks on what the run wrote, its report and
 * the traces have to fit after it, so a caller with its own clock running
 * passes a nearer deadline.
 */
export const TURN_BUDGET_MS = 150_000

/** What is left before `deadline`, never nothing: a timeout of zero or less is not one the SDK takes. */
const timeLeft = (deadline: number) => Math.max(1, deadline - Date.now())

/** A judging call's timeout: its own for each step, and no later than `deadline` when the caller has one. */
const within = (stepMs: number, deadline?: number) => (deadline === undefined ? { stepMs } : { totalMs: timeLeft(deadline), stepMs })

export type AgentInput = {
  member: Member | null
  memberName: string
  text: string
  /** Narrow the tools the model may call this run. Defaults to what a scheduled instruction may reach for. */
  tools?: ToolName[]
  /** A larger output budget than the default, for a run known to write at length. */
  maxOutputTokens?: number
  /** When the caller needs the run over by, in epoch ms. The run ends at this or TURN_BUDGET_MS from its start, whichever comes first. */
  deadline?: number
  /** The helper this run works as: its role in the prompt. */
  helper?: Helper | null
  /** Whose "what's new" markers the tools read and move; see ToolContext.cursorScope. */
  cursorScope?: string
}

export type AgentResult = {
  text: string
  model: string
  /** What the tools actually returned, for the checks on the draft. */
  evidence?: string
  /** The Known household facts the model wrote with, so the checks judge against the same sources. */
  facts?: string
  /** Cursor moves the run's tools staged, for the caller to commit once the result has reached someone. */
  cursors?: StagedCursor[]
  /** Writes this run made that would double if done again; what they acted on must not be offered twice. */
  wrote?: string[]
  /** The writes in `wrote` that ran out of time and may or may not have happened; see ToolContext.unconfirmed. */
  unconfirmed?: string[]
  /** The output allowance cut the report short, and it lost its unfinished end. */
  cutShort?: boolean
}

/**
 * What an unattended run's failed slot had looked at, kept against the error
 * it threw: the caller holds nothing else to say which new items a run that
 * keeps failing is stuck on.
 */
const failedLooks = new WeakMap<object, StagedCursor[]>()
export const looksBefore = (err: unknown): StagedCursor[] =>
  (err && typeof err === 'object' ? failedLooks.get(err) : undefined) ?? []

/** Memories are cheap to store and expensive to read; a run sees the newest few dozen. */
const MEMORY_LIMIT = 50

/** A scheduled run writes cool and short. */
const RUN_SETTINGS = { temperature: 0.3, maxOutputTokens: 800 }

/**
 * A reply the output cap cut off with fewer characters than this said is a
 * model that thought its budget away, not an answer that ran long: the cap
 * counts reasoning tokens, and a thinking model can reach it having written
 * one letter of the report.
 */
const TRUNCATED_REPLY_CHARS = 200

/**
 * The least output allowance the last model in the chain gets, at twice the
 * run's when that is more. A cap that stops an earlier slot hands the run to
 * the next one; at the last there is no next, and the run is lost. The tail is
 * where the thinking models sit, and the cap counts their reasoning.
 */
const LAST_SLOT_ALLOWANCE = 4000

/**
 * The Known household facts, for a run to write with: a standing instruction
 * remembered earlier (one sender's mail to leave out) can only steer a report
 * written with it in view.
 */
export async function knownFacts(): Promise<string> {
  const memories = await listMemories(MEMORY_LIMIT).catch(() => [])
  return memories.length ? ['Known household facts:', ...memories.map((m) => `- [${m.id}] ${m.content}`)].join('\n') : ''
}

/**
 * Plain attribute-style lines, one concern each, and a handful of canonical
 * examples in place of a list of prohibitions. Gemini Flash in particular
 * follows plain lines far better than prose once a prompt carries dozens of
 * rules, and this stays well under that.
 */
export function systemPrompt(input: {
  now: Date
  context: string
  /** The helper working, when it is one: who it is and its role, ahead of everything else. */
  helper?: Pick<Helper, 'name' | 'role'> | null
}): string {
  const tz = timezone()
  const head = [
    input.helper
      ? `You are ${input.helper.name}, one of ${assistantName()}'s helpers for one family. Your report carries your name, so never sign it yourself.\nROLE: ${input.helper.role}`
      : `You are ${assistantName()}, the household assistant for one family.`,
    clockLine(input.now),
  ]
  return [...head, ...runPrompt(tz), input.context ? `\nContext:\n${input.context}` : '']
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function runPrompt(tz: string): string[] {
  return [
    'This is a scheduled job, not a conversation. Whatever you write is kept as a report for the family member who set it up, and read later.',
    'WRITE using only the tool results you fetch, the Known household facts under Context and the instruction you were given. Do not rely on outside knowledge.',
    'HOUSE RULES: a Known household fact under Context can be a standing instruction about these reports: mail from one sender or on one subject to leave out, or something always to include. Follow it even where the instruction you were given would include the item, and do not say that you did.',
    'REPORT: for a routine check, one to three short lines a housemate would find useful, the key figure in **bold**. When the instruction asks for a summary in several parts, open with a **bold** title line and give each part a **bold** heading line with its bullets under it. Names, amounts and dates exactly as given.',
    'PURPOSE: say what a payment or message is for only when a tool result, a Known fact, a calendar event or a fetched email names it, and say which. Where the instruction asks for a purpose on every line, write "purpose not recorded" for one nothing names; where it does not, say nothing about purpose.',
    'NOTHING TO SAY: when nothing is worth reporting, reply with exactly SKIP.',
    'PROBLEMS: if a tool fails, write PROBLEM: and one line of diagnosis, then SKIP on its own line. That reaches the member as a problem report, not as the report itself.',
    `FORMAT: Markdown: **bold**, *italic*, \`code\`, - bullets. No tables, no headings beyond **bold** lines, no preamble, no handover line, no commentary about tools. Write in ${language()} with ${units()} units, times in ${tz}.`,
    '',
    'EXAMPLES, where <angle brackets> stand for the real values:',
    'Good: "<Account>: **$<amount>** <PAYEE AS SHOWN>, <Day D Mon>. Purpose not recorded."',
    'Bad: "Looks like someone booked a trip to <the city in the payee string>, planning a holiday?" No source names a trip.',
    'Bad: "That payee is an airline, so this is probably the other half of a booking. Now the report:" Working shown; report alone.',
    'Skip: the tools show nothing new. Reply SKIP.',
  ]
}

/**
 * Models that think out loud sometimes narrate their reasoning and then hand
 * over with "Now the post:", which is how "<payee> is a known budget airline
 * ... Now the post:" once reached the family. The instructions already forbid
 * a preamble; this is what happens when one arrives anyway. Only a handover
 * that genuinely follows prose is cut, so a reply that simply opens "Here's
 * the summary:" keeps its first line.
 */
const HANDOVER =
  /\b(?:now|and now|here(?:'s| is)|so here(?:'s| is))\b[^.\n:]{0,60}\b(?:post|update|message|summary|brief|snapshot|report|answer|reply)\s*:[ \t]*\n/i
const MIN_PREAMBLE = 40

export function stripPreamble(text: string): string {
  const match = HANDOVER.exec(text.slice(0, 500))
  if (!match || match.index < MIN_PREAMBLE) return text
  return text.slice(match.index + match[0].length).trim() || text
}

/**
 * Some endpoints return a model's thinking inline as <think> blocks instead of
 * in a separate reasoning field. Everything inside is working, never the
 * answer; an unclosed block is a reply that never got past thinking.
 */
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi
const THINK_OPEN = /<think>[\s\S]*$/i

export function stripReasoning(text: string): string {
  return text.replace(THINK_BLOCK, '').replace(THINK_OPEN, '').trim()
}

/**
 * Working that arrives with no handover line: an opening paragraph of the
 * model talking to itself ("I have what I need", "Let me check", "No web
 * lookup needed") ahead of the report proper. A report speaks for the
 * household and never in the first person about its tools, so such an opening
 * is cut when a report follows it.
 */
const WORKING =
  /\b(?:I(?:'ll| will| have| need|'ve| checked| fetched| looked| confirmed| can see)|let me|let's|no (?:web )?(?:lookup|search) needed|known facts confirm|the tools? (?:returned|show|say)|(?:per|from) the tool|tool results?)\b/i
const MAX_WORKING_PARAGRAPHS = 3

export function stripWorking(text: string): string {
  let rest = text.trim()
  for (let i = 0; i < MAX_WORKING_PARAGRAPHS; i++) {
    const cut = rest.search(/\n[ \t]*\n/)
    if (cut < 0 || !WORKING.test(rest.slice(0, cut))) return rest
    const after = rest.slice(cut).trim()
    if (!after) return rest
    rest = after
  }
  return rest
}

/** Everything that keeps a model's working out of a report. */
export function cleanReply(raw: string, opts: { working?: boolean } = {}): { text: string; stripped: boolean } {
  const trimmed = raw.trim()
  const spoken = stripPreamble(stripReasoning(trimmed))
  const text = opts.working ? stripWorking(spoken) : spoken
  return { text, stripped: text !== trimmed }
}

/**
 * About ten thousand tokens. A run's longest reads (a few emails at 6,000
 * characters, a page at 9,000) fit whole, and the chain's claim check sends
 * the evidence once for every statement it checks.
 */
const EVIDENCE_TOTAL_CHARS = 40_000
const CUT_MARK = ' …[cut short]'

/**
 * What the tools actually said, so the decision can check a draft
 * against its sources rather than against the model's memory of them. The
 * writer saw every result whole, and a result the checks cannot see makes a
 * true statement look invented; so every result is kept, and only when they
 * run over the total are the longest cut, all to the same length, which
 * leaves the short ones (what a proposal or a list write returned) whole.
 */
type ToolResultLike = { toolName: string; input: unknown; output: unknown }

export function collectEvidence(steps: ReadonlyArray<{ toolResults?: ReadonlyArray<ToolResultLike> }>): string {
  const lines = steps.flatMap((step) =>
    (step.toolResults ?? []).map((r) => `${r.toolName}(${JSON.stringify(r.input)}) -> ${JSON.stringify(r.output)}`),
  )
  const budget = EVIDENCE_TOTAL_CHARS - Math.max(0, lines.length - 1)
  if (lines.reduce((n, l) => n + l.length, 0) <= budget) return lines.join('\n')
  // The longest length every result can be held to: the short ones take what
  // they need, and what is left is shared evenly among the rest.
  const lengths = lines.map((l) => l.length).sort((a, b) => a - b)
  let rest = budget
  let cap = 0
  for (const [i, n] of lengths.entries()) {
    cap = Math.floor(rest / (lengths.length - i))
    if (n > cap) break
    rest -= n
  }
  return lines
    .map((l) => (l.length > cap ? `${l.slice(0, Math.max(0, cap - CUT_MARK.length))}${CUT_MARK}` : l))
    .join('\n')
}

/**
 * What an unrepeatable write did, in the words a report would use (see
 * ToolContext.wrote).
 */
const DONE: Partial<Record<ToolName, string>> = {
  add_to_list: 'added to a list',
  hand_off: 'handed a job to a helper',
  create_goal: 'set up a goal',
  update_goal: 'updated a goal',
  create_automation: 'set up a reminder',
  create_calendar_event: 'added an event to your calendar',
  jira_comment: 'commented on a board ticket',
  jira_attach_email_file: 'attached a file to a board ticket',
  notion_append_to_page: 'added to a Notion page',
}

/**
 * What the run's unrepeatable writes did, for a report that cannot say it any
 * other way. A write that ran out of time may not have happened, so it is not
 * said to have.
 */
function doneSoFar(wrote: readonly string[], unconfirmed: readonly string[] = []): string {
  const done = wrote.filter((t) => !unconfirmed.includes(t))
  return [...new Set(done.map((t) => DONE[t as ToolName]).filter(Boolean))].join(', ')
}

/**
 * A check that runs until it finds what it is waiting for stops for good once
 * it reports, so its writer is told as much.
 */
const UNTIL_PROMPT =
  'This check stops for good once it reports anything, so report only when what the instruction is waiting for has happened. '

/**
 * What a scheduled run is told, as its one message: which job is due, its
 * author's instruction, and how to say nothing, a problem, or the report.
 */
export function scheduledInstruction(job: { label: string; instruction: string; repeat: string }, memberName: string): string {
  return (
    `Scheduled automation "${job.label}" is due now. Carry out this instruction; whatever you write is kept as a report for ${memberName} to read later, so keep it brief:\n\n${job.instruction}\n\n` +
    (job.repeat === 'until' ? UNTIL_PROMPT : '') +
    'If the instruction only wants a report under some condition and that condition is not met (nothing new, nothing to report), reply with exactly SKIP and nothing will be kept. Write nothing beside it: a quiet run needs no explanation of why it was quiet. ' +
    'If a tool fails or errors, write PROBLEM: followed by a one-line diagnosis, then SKIP on its own line. That reaches the member as a problem report, not as the report itself. ' +
    'Reply with the report alone: no preamble, no planning notes, no handover line such as "now the report:", no commentary about what the tools returned.'
  )
}

/**
 * One scheduled run: the instruction, the read-only tools a run may reach
 * for, and the model chain tried in order until one answers. A slot that
 * fails hands the run to the next, unless the run has already written
 * something that would double if done again.
 */
export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const now = new Date()
  const deadline = Math.min(input.deadline ?? Infinity, now.getTime() + TURN_BUDGET_MS)
  const ctx: ToolContext = {
    member: input.member,
    memberName: input.memberName,
    now,
    via: 'watcher',
    helper: input.helper ?? null,
    ...(input.cursorScope ? { cursorScope: input.cursorScope } : {}),
  }

  const context = await knownFacts()
  // Everything the run was handed, where a link it may open later can already be.
  ctx.seen = [{ text: [context, input.text].join('\n'), typed: 0 }]
  const activeTools = input.tools ?? CUSTOM_AUTOMATION_TOOLS
  const reasoning = reasoningLevel()

  const chain = modelChain()
  const allowance = input.maxOutputTokens ?? RUN_SETTINGS.maxOutputTokens
  const allowanceFor = (slot: ModelSlot) => (slot === chain.at(-1) ? Math.max(2 * allowance, LAST_SLOT_ALLOWANCE) : allowance)
  // The first long report the cap cut off, trimmed, for when no later model
  // answers at all: a report short of its end beats none.
  let shortPost: { text: string; model: string; evidence: string | undefined; cutShort: boolean; looks: StagedCursor[] } | undefined
  const result = await withModelFallback(async (slot: ModelSlot) =>
    traced(
      {
        traceName: 'hearth.watcher',
        ...(input.member ? { userId: String(input.member.id) } : {}),
        tags: ['watcher'],
        metadata: { model: slot.name, ...(input.helper ? { helper: input.helper.name } : {}) },
      },
      async () => {
        const call = () =>
          generateText({
            model: slot.model,
            system: systemPrompt({ now, context, helper: input.helper }),
            messages: [{ role: 'user', content: `${input.memberName}: ${input.text}` }],
            tools: buildTools(ctx),
            activeTools,
            stopWhen: isStepCount(MAX_STEPS),
            timeout: { totalMs: timeLeft(deadline), stepMs: STEP_TIMEOUT_MS },
            maxOutputTokens: allowanceFor(slot),
            temperature: RUN_SETTINGS.temperature,
            ...(reasoning ? { reasoning } : {}),
            telemetry: callTelemetry('hearth.watcher'),
          })

        // Whatever this slot changes stays changed if it then fails. Starting
        // the run over on the next slot would do it all again: the same list
        // items twice, a second reminder. So once anything is written, a
        // failure ends the run here, saying what was done. A slot that fails
        // has shown its looks at new mail to nobody.
        const stagedBefore = ctx.pendingCursors?.length ?? 0
        try {
          const r = await call()
          let cleaned = cleanReply(r.text, { working: true })
          if (cleaned.stripped) console.warn(`[agent] ${slot.name} leaked its working into the report; stripped`)

          // A fragment is worse than nothing: it would go to the checks as the
          // report. It is dropped here, and the failure below hands the run to
          // the next slot.
          let truncated = r.finishReason === 'length' && cleaned.text.length < TRUNCATED_REPLY_CHARS
          let cutShort = false
          if (truncated) {
            console.warn(`[agent] ${slot.name} ran out of output tokens after ${cleaned.text.length} characters of reply; dropped`)
            cleaned = { text: '', stripped: true }
          } else if (r.finishReason === 'length') {
            // A long report the cap cut off goes to the next model first, which
            // may say it in fewer words: what it would have lost is spent with
            // the rest once the report is kept. The last model's (or one
            // written after a change, which ends the run here anyway) loses its
            // broken last line rather than ending mid-bullet, and still faces
            // the checks; failing it would fail every run the same way.
            const cut = cleaned.text.lastIndexOf('\n')
            const whole = cut > 0 ? cleaned.text.slice(0, cut).trimEnd() : ''
            if (slot !== chain.at(-1) && !ctx.wrote?.length) {
              if (!shortPost && whole.length >= TRUNCATED_REPLY_CHARS) {
                const evidence = collectEvidence(r.steps ?? [])
                shortPost = { text: whole, model: slot.name, evidence, cutShort: true, looks: ctx.pendingCursors?.slice(stagedBefore) ?? [] }
              }
              throw new Error(`${slot.name} ran out of output tokens after ${cleaned.text.length} characters of report`)
            }
            // What is left of a report cut off early is a fragment, and goes the way of a short one.
            truncated = whole.length < TRUNCATED_REPLY_CHARS
            console.warn(`[agent] ${slot.name} ran out of output tokens after ${cleaned.text.length} characters; ${truncated ? 'dropped' : 'kept the complete lines'}`)
            cleaned = { text: truncated ? '' : whole, stripped: true }
            cutShort = !truncated
          }

          // An empty completion usually means the model ended on a tool call it
          // never summarised; treat it as a failure so the fallback model gets
          // a go, or, if that tool call changed something, so the run ends saying so.
          if (!cleaned.text) {
            throw new Error(truncated ? `${slot.name} ran out of output tokens before answering` : `${slot.name} returned no text`)
          }
          return { text: cleaned.text, model: slot.name, evidence: collectEvidence(r.steps ?? []), cutShort }
        } catch (err) {
          // A failed slot's looks were shown to nobody, unless the run wrote on
          // the strength of them: then they are spent with it, or the next run
          // would find the same mail and write it all again.
          if (err && typeof err === 'object') failedLooks.set(err, ctx.pendingCursors?.slice(stagedBefore) ?? [])
          if (!ctx.wrote?.length) {
            ctx.pendingCursors?.splice(stagedBefore)
            throw err
          }
          console.error(`[agent] ${slot.name} failed after changing something, so no other slot gets the run:`, describeError(err))
          // The run reports nothing but the problem, and the member hears why.
          const done = doneSoFar(ctx.wrote, ctx.unconfirmed) || 'changed something'
          throw new EndOnFailure({
            text: `PROBLEM: ${slot.name} failed (${describeError(err)}) after it had ${done}, so this run reported nothing.\nSKIP`,
            model: slot.name,
            evidence: undefined,
            cutShort: false,
          }, err)
        }
      },
    ),
  chain,
  'hearth.watcher',
  deadline,
  ).catch((err: unknown) => {
    if (!shortPost) throw err
    // Every later model failed outright; the one that ran long had its say.
    console.warn(`[agent] no later model answered (${describeError(err)}); keeping ${shortPost.model}'s report, cut short`)
    const { looks, ...post } = shortPost
    ;(ctx.pendingCursors ??= []).push(...looks)
    return post
  })

  return {
    text: result.text,
    model: result.model,
    ...(result.evidence !== undefined ? { evidence: result.evidence } : {}),
    // Only a report the model wrote says what was new.
    ...(result.text && ctx.pendingCursors?.length ? { cursors: ctx.pendingCursors } : {}),
    ...(ctx.wrote?.length ? { wrote: ctx.wrote } : {}),
    ...(ctx.unconfirmed?.length ? { unconfirmed: ctx.unconfirmed } : {}),
    ...(result.cutShort ? { cutShort: true } : {}),
    facts: context,
  }
}

/* ------------------------------------------------------------ post decision */

/** The two questions the decision asks, whichever judge answers them. */
const postAnswersSchema = z.object({
  invented: z.boolean().describe('Whether the draft states anything about the world that the evidence does not contain'),
  not_in_evidence: z.string().optional().describe('When invented: the statement in the draft that the evidence does not contain, quoted'),
  nothing_new: z.boolean().describe('Whether the draft only says that there is nothing new, nothing to report or nothing worth reporting'),
  confidence: z.number().min(0).max(1).describe('How sure you are of both answers, 0 to 1'),
})

export type PostDecision = {
  decision: 'post' | 'skip'
  confidence: number
  reason?: string
  /** The statement the judge quoted as not in the evidence, when that is what it skipped for. */
  notInEvidence?: string
}

const DECISION_PROMPT = [
  'You answer two questions about a draft report from a scheduled family-assistant check, against the evidence it was written from. You do not decide whether it is kept; code does that from your answers.',
  'invented: does the draft state anything about the world that the evidence does not contain? A name, amount, date, time, place, purpose, description or flag that no part of the evidence gives counts, and so does a guess made as a hedge or a question. Quote that statement in not_in_evidence.',
  'nothing_new: does the draft only say that there is nothing new, nothing to report or nothing worth saying?',
  'The evidence is the instruction the writer was given, the household facts it had and what its tools returned. The instruction is there so that wording it asked for counts as in the evidence ("purpose not recorded", a closing line it dictates); whether the writer obeyed it is not asked. An item the instruction says to leave out, such as a promotion, a newsletter, or a collection or event whose time has passed, was the writer\'s call to make: while the evidence contains what the item says, it is not invented. Which items the draft mentions is never the question, only whether what it says of them is in the evidence.',
  'Differences of form do not matter: case, punctuation, currency symbols, a name that is part of a longer string in the evidence. Differences of substance do: a purpose, place, trip, plan or cause is in the evidence only if the evidence names it. Saying that something is not known is not a claim.',
  'Give your confidence in both answers from 0 to 1. Answer with the structured object only.',
].join('\n')

/**
 * Keep or hold back, decided in a fresh context against what the tools
 * actually said. A bare "reply SKIP if there is nothing" leaves the choice to
 * the model that wrote the draft, which is the one least able to see its own
 * embellishments. Keep or hold is all it decides: the draft it approves is
 * kept as written, so a retype cannot flatten the formatting or bring back a
 * figure the claim check never saw. Grounding is all it judges, too, and the
 * judge is never asked to choose: it answers two questions, is anything in
 * the draft not in the evidence and does the draft only say there is nothing
 * new, and code turns the answers into post or skip. A judge asked for a
 * verdict once held a whole brief back over a mail item it took for a
 * promotion, and again over a collection whose time had passed: both were the
 * writer's selection, neither was invented, and a verdict left room to
 * enforce the instruction instead.
 */
export async function decideWatcherPost(input: {
  label: string
  draft: string
  evidence: string
  /** Every statement the claim check pulled out of this draft was checked against this evidence and supported. */
  verified?: boolean
  /** When the decision must be made by, in epoch ms: the tick's, which the platform stops soon after. */
  deadline?: number
}): Promise<PostDecision & { model: string }> {
  return withModelFallback(async (slot) => {
    const r = await traced({ traceName: 'hearth.decision', tags: ['decision'], metadata: { label: input.label, model: slot.name } }, () =>
      generateText({
        model: slot.model,
        system: DECISION_PROMPT,
        prompt: `Job: ${input.label}\n\nDRAFT:\n${input.draft}\n\nEVIDENCE:\n${input.evidence || '(no tool results)'}`,
        output: Output.object({ schema: postAnswersSchema, name: 'post_decision' }),
        temperature: 0.2,
        maxOutputTokens: 600,
        timeout: within(30_000, input.deadline),
        telemetry: callTelemetry('hearth.decision'),
      }),
    )
    return { ...fromAnswers(r.output, input.verified ?? false), model: slot.name }
  }, await structuredChain(), 'hearth.decision', input.deadline)
}

/**
 * How sure the chain must be of its two answers before a report is kept on
 * them. A model's confidence is its own estimate, not a calibrated
 * probability, and one that admits doubt is usually right to: the grey zone
 * is a skip.
 */
export const CHAIN_POST_CONFIDENCE = 0.7

/** Why a draft is held back, for the log and the member's report. */
const POST_REASONS = {
  nothingNew: 'the draft only says there is nothing new',
  invented: 'the draft states something the evidence does not contain',
  unsure: 'the judge was not sure enough of its answers',
} as const

/**
 * The chain's two answers combined in code: nothing new skips, invented
 * skips, doubt skips, the rest posts. `verified` says the claim check has
 * already been through this draft statement by statement against the same
 * evidence and passed every one. This question is asked of the whole draft at
 * once, which is the coarser of the two, so once the finer check has passed,
 * only an answer the judge is sure of overrides it, and its doubt is no longer
 * reason enough on its own.
 */
function fromAnswers(o: z.infer<typeof postAnswersSchema>, verified: boolean): PostDecision {
  if (o.nothing_new) return { decision: 'skip', confidence: o.confidence, reason: POST_REASONS.nothingNew }
  const sure = o.confidence >= CHAIN_POST_CONFIDENCE
  if (o.invented && (sure || !verified)) {
    const quoted = o.not_in_evidence?.trim()
    return quoted
      ? { decision: 'skip', confidence: o.confidence, reason: `${POST_REASONS.invented}: ${quoted}`, notInEvidence: quoted }
      : { decision: 'skip', confidence: o.confidence, reason: POST_REASONS.invented }
  }
  if (!sure && !verified) return { decision: 'skip', confidence: o.confidence, reason: POST_REASONS.unsure }
  return { decision: 'post', confidence: o.confidence }
}

/* -------------------------------------------------------------- draft review */

const MAX_CLAIMS = 6
const claimsSchema = z.object({
  claims: z.array(z.string()).describe('Checkable statements, one short sentence each, self-contained'),
})
const checkSchema = z.object({
  supported: z.boolean(),
  excerpt: z.string().optional().describe('The words in the evidence that establish it, when supported'),
})
const rewriteSchema = z.object({
  message: z.string().describe('The report with the unsupported statements removed and nothing else changed; empty if what remains is not worth reporting'),
})

const EXTRACT_PROMPT = [
  'You list the checkable statements in a short report from a family assistant.',
  'A statement is one fact the report says or suggests about the world, as one short self-contained sentence: an amount, a date or time, who or what was paid or wrote in, where an event is held, a stated purpose, or a flag the report raises (new payee, unusual, duplicate, refund).',
  'A payee or merchant string is one fact, quoted whole and exactly as written: "<Account>: **$<amount>** <PAYEE CITY>, <date>. Purpose not recorded." is three statements: the amount, the payee string <PAYEE CITY>, the date. The city or number inside a payee string is not a place, and the account label is not a flag.',
  'Never combine two facts in one statement: "$<amount> was paid to <payee> for flights to <city>" is three statements (the amount, the payee, the flights).',
  'A category is where a transaction is filed, not what it was for, and one payee can appear more than once: a category is the statement "<payee> $<amount> is filed under <category>", the amount naming which transaction it is.',
  'A guess in a hedge or a question ("looks like someone booked flights", "planning a trip?", "probably the other half") is still a statement: list it as the plain assertion it makes.',
  'Copy names, payee strings, figures and dates exactly as the report writes them; never shorten or normalise them.',
  'Leave out offers to do something, questions that only ask the reader for something, and statements of what is not known, such as "purpose not recorded".',
  'Return an empty list when there is nothing checkable.',
].join(' ')

/**
 * The list is capped to bound the checks, so a long report is spot-checked. The
 * extractor is told which statements to spend the places on: the ones a model
 * invents, not the ones it copies.
 */
const EXTRACT_CAP =
  `List at most ${MAX_CLAIMS} statements. When the report makes more, choose the ones most likely to be wrong: stated purposes, descriptions of payees or senders, flags and anything the report infers, before figures and dates copied from a list.`

const CHECK_PROMPT = [
  'You check one statement against evidence and nothing else.',
  'supported is true when the evidence states the statement or it follows directly from it: a figure that appears, a date that appears, an instruction that says to write exactly this, a sum of listed figures.',
  'Differences of form do not matter: case, punctuation, currency symbols, and a name that is part of a longer string in the evidence (<PAYEE> within <PAYEE CITY> in the feed) all count as the same thing.',
  'Differences of substance do: a purpose, place, trip, plan or cause is supported only if the evidence names it. A payee string is not a place anyone went. A statement with any unsupported part is not supported. Do not use outside knowledge.',
  'Quote the excerpt that establishes a supported statement.',
].join(' ')

const REWRITE_PROMPT = [
  'You edit a short report from a family assistant so that it no longer makes the statements listed as not supported.',
  'Remove each of them wherever it appears and in whatever form: a fact, a hedge, a question, a hint, an aside in brackets. A sentence that only introduced or explained one goes with it.',
  'Everything else stays exactly as written: every other figure, name, date and line, in the original order and formatting. Add nothing.',
  'Return an empty message when what remains says nothing worth reporting.',
].join(' ')

const HEADING = /^\s*\*\*[^*\n]+\*\*:?\s*$/

/** The heading lines in `text` that have a line of their own under them. */
function headingsWithBody(text: string): Set<string> {
  const out = new Set<string>()
  let current: string | null = null
  for (const line of text.split('\n')) {
    if (HEADING.test(line)) current = line.trim()
    else if (current !== null && line.trim() !== '') out.add(current)
  }
  return out
}

/**
 * A part's heading left over nothing once the rewrite has cut the part's only
 * bullet. The rewrite is told to change nothing else, and keeps the heading:
 * a brief once went out with "**Today**" over a blank line, the day's one
 * event having failed the check. Only a heading that had something under it in the
 * draft is dropped, so a title line that sits straight above the first part
 * stays as written.
 */
export function dropEmptiedHeadings(rewritten: string, draft: string): string {
  const had = headingsWithBody(draft)
  const lines = rewritten.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (HEADING.test(lines[i]) && had.has(lines[i].trim())) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j >= lines.length || HEADING.test(lines[j])) {
        i = j - 1
        continue
      }
    }
    kept.push(lines[i])
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export type DraftReview = {
  claims: string[]
  unsupported: string[]
  message: string | null
  /** Why the rewrite could not cut the unsupported claims out; `message` is then null. */
  rewriteFailed?: string
}

/**
 * Whether the evidence supports each statement: the chain is asked one
 * statement per call, in parallel. The checker sees the evidence and one
 * statement, never the draft.
 */
async function checkEach(
  claims: string[],
  evidence: string,
  chain: ModelSlot[],
  meta: (step: string, model: string) => Parameters<typeof traced>[0],
  deadline?: number,
): Promise<boolean[]> {
  return Promise.all(
    claims.map((claim) =>
      withModelFallback((slot) =>
        traced(meta('check', slot.name), () =>
          generateText({
            model: slot.model,
            system: CHECK_PROMPT,
            prompt: `EVIDENCE:\n${evidence}\n\nSTATEMENT TO CHECK:\n${claim}`,
            output: Output.object({ schema: checkSchema, name: 'check' }),
            temperature: 0,
            maxOutputTokens: 300,
            timeout: within(30_000, deadline),
            telemetry: callTelemetry('hearth.verify'),
          }),
        ).then((r) => r.output.supported),
        chain,
        'hearth.verify',
        deadline,
      ),
    ),
  )
}

/**
 * Chain-of-Verification, factored: pull the checkable claims out of the draft,
 * ask about each one in a fresh context that sees only the evidence (never the
 * draft, so the checker cannot be talked into agreeing with it), then remove
 * what failed from the draft and leave the rest as written. The claims list is
 * capped, so a long report is spot-checked rather than rebuilt: rebuilding it
 * from the list dropped every fact the list had no room for. Statements of
 * what is not known are not claims, so "purpose not recorded" passes untouched.
 * With a `deadline` (epoch ms) every call is over by then. A rewrite that
 * cannot finish, cut off by that deadline or failing on every slot, still
 * hands back the verdicts, never a throw that would lose them and leave the
 * caller only the draft they rejected.
 */
export async function reviewDraft(input: { label: string; draft: string; evidence: string; deadline?: number }): Promise<DraftReview> {
  const evidence = input.evidence || '(no tool results)'
  const meta = (step: string, model: string) => ({ traceName: 'hearth.verify', tags: ['verify', step], metadata: { label: input.label, model } })
  const chain = await structuredChain()

  const claims = (
    await withModelFallback((slot) =>
      traced(meta('extract', slot.name), () =>
        generateText({
          model: slot.model,
          system: EXTRACT_PROMPT,
          prompt: `${EXTRACT_CAP}\n\nREPORT:\n${input.draft}`,
          output: Output.object({ schema: claimsSchema, name: 'claims' }),
          temperature: 0,
          maxOutputTokens: 500,
          timeout: within(30_000, input.deadline),
          telemetry: callTelemetry('hearth.verify'),
        }),
      ).then((r) => r.output.claims),
      chain,
      'hearth.verify',
      input.deadline,
    )
  ).slice(0, MAX_CLAIMS)
  if (claims.length === 0) return { claims, unsupported: [], message: input.draft }

  const checks = await checkEach(claims, evidence, chain, meta, input.deadline)
  const unsupported = claims.filter((_, i) => !checks[i])
  if (unsupported.length === 0) return { claims, unsupported, message: input.draft }

  // Even when every listed claim fails the report is edited, not dropped: the
  // list may be the capped few, and what it left out is still the report.
  const supported = claims.filter((_, i) => checks[i])
  const rewritten = await rewriteWithout({ label: input.label, draft: input.draft, unsupported, supported, deadline: input.deadline }, chain).catch(
    (err: unknown) => ({ failed: describeError(err) }),
  )
  if (typeof rewritten !== 'string') return { claims, unsupported, message: null, rewriteFailed: rewritten.failed }
  return { claims, unsupported, message: rewritten || null }
}

/** The draft with the listed statements taken out and nothing else changed; empty when nothing worth reporting is left. */
async function rewriteWithout(
  input: { label: string; draft: string; unsupported: string[]; supported: string[]; deadline?: number },
  chain: ModelSlot[],
): Promise<string> {
  return withModelFallback(
    (slot) =>
      traced({ traceName: 'hearth.verify', tags: ['verify', 'rewrite'], metadata: { label: input.label, model: slot.name } }, () =>
        generateText({
          model: slot.model,
          system: REWRITE_PROMPT,
          prompt:
            `REPORT:\n${input.draft}\n\nNOT SUPPORTED, remove wherever they appear:\n${input.unsupported.map((u) => `- ${u}`).join('\n')}` +
            (input.supported.length ? `\n\nSUPPORTED, keep as written:\n${input.supported.map((c) => `- ${c}`).join('\n')}` : ''),
          output: Output.object({ schema: rewriteSchema, name: 'rewrite' }),
          temperature: 0,
          maxOutputTokens: 800,
          timeout: within(30_000, input.deadline),
          telemetry: callTelemetry('hearth.verify'),
        }),
      ).then((r) => {
        const message = dropEmptiedHeadings(r.output.message.trim(), input.draft)
        // Statements the check passed are still in the report, so an empty
        // rewrite is a model that misread the task, not a verdict that nothing
        // is left worth reporting: the next model in the chain is asked instead.
        if (!message && input.supported.length > 0) throw new Error('the rewrite came back empty with supported statements still in the report')
        return message
      }),
    chain,
    'hearth.verify',
    input.deadline,
  )
}

/**
 * A statement cut from a draft the claim check had passed whole, the way the
 * check cuts a claim that fails it: for the one the decision quotes as not in
 * the evidence, so that the rest can be judged again rather than held with
 * it. Null when nothing worth reporting is left. A rewrite that cannot be
 * made throws, and the caller decides what becomes of the draft then.
 */
export async function cutFromDraft(input: { label: string; draft: string; unsupported: string[]; deadline?: number }): Promise<string | null> {
  const rest = await rewriteWithout({ ...input, supported: [] }, await structuredChain())
  return rest || null
}

/** A structured call that produced no usable object, as opposed to a transport failure. */
export function isStructuredOutputError(err: unknown): boolean {
  return NoObjectGeneratedError.isInstance(err) || NoOutputGeneratedError.isInstance(err)
}
