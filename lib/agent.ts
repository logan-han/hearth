import {
  generateText,
  isStepCount,
  Output,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  type ModelMessage,
  type UserContent,
} from 'ai'
import { z } from 'zod'
import { withModelFallback, gateSlot, type ModelSlot } from './model'
import { buildTools, CUSTOM_AUTOMATION_TOOLS, SWEEP_TOOLS, routeGroups, groupsAfter, activeToolsFor, type ToolName } from './tools'
import type { ToolContext } from './tools/context'
import { recentMessages, listMemories, connectionsFor, allMembersWithLinks, pendingDrafts, pendingProposals, chatSummary } from './db/queries'
import type { Member } from './db/schema'
import { timezone, language, units, reasoningLevel } from './env'
import { traced, callTelemetry } from './telemetry'
import { formatLocal, localDateKey } from './cron'

const MAX_STEPS = 8
const STEP_TIMEOUT_MS = 60_000

/**
 * The three jobs the model does, each with its own prompt, tools and
 * settings. One prompt for all of them was the old shape, and a Flash-Lite
 * class model given forty rules at once follows fewer of them than it is
 * given ten.
 */
export type AgentMode = 'chat' | 'watcher' | 'sweep'

export type AgentInput = {
  chatId: string
  chatType: 'private' | 'group' | 'supergroup' | string
  member: Member | null
  memberName: string
  text: string
  /** Skip history assembly for scheduled runs, which have no conversation. */
  history?: boolean
  /** Id of the stored row for `text`, so it is not replayed twice. */
  excludeMessageId?: number
  /** Photos, scans or voice notes to read alongside the text. */
  attachments?: { bytes: Uint8Array; mediaType: string; filename?: string; kind: string }[]
  /** Which prompt, tools and settings to run with. Defaults to chat. */
  mode?: AgentMode
  /** Narrow the tools the model may call this run. Defaults per mode. */
  tools?: ToolName[]
}

export type AgentResult = {
  text: string
  notices: string[]
  model: string
  /** Watcher runs: what the tools actually returned, for the post decision. */
  evidence?: string
}

/** Memories are cheap to store and expensive to read; the chat sees the newest few dozen. */
const CHAT_MEMORY_LIMIT = 50
const SWEEP_MEMORY_LIMIT = 200

/** Per-mode sampling. Chat keeps the provider default; the rest run cooler. */
const MODE_SETTINGS: Record<AgentMode, { temperature?: number; maxOutputTokens: number }> = {
  chat: { maxOutputTokens: 1500 },
  watcher: { temperature: 0.3, maxOutputTokens: 800 },
  sweep: { temperature: 0.2, maxOutputTokens: 1200 },
}

function defaultTools(mode: AgentMode): ToolName[] | undefined {
  if (mode === 'sweep') return SWEEP_TOOLS
  if (mode === 'watcher') return CUSTOM_AUTOMATION_TOOLS
  return undefined
}

/**
 * Facts the model needs that never come from the conversation itself. A chat
 * turn gets the household and its open business; a watcher gets none of it
 * and looks facts up with `recall` when a payee or sender calls for it; the
 * sweep gets every memory, because deduplicating against them is its job.
 */
type Ambient = { text: string; pendingDrafts: boolean }

async function ambientContext(chatId: string, member: Member | null, mode: AgentMode): Promise<Ambient> {
  if (mode === 'watcher') return { text: '', pendingDrafts: false }
  if (mode === 'sweep') {
    const memories = await listMemories(SWEEP_MEMORY_LIMIT).catch(() => [])
    if (memories.length === 0) return { text: '', pendingDrafts: false }
    return { text: ['Known household facts:', ...memories.map((m) => `- [${m.id}] ${m.content}`)].join('\n'), pendingDrafts: false }
  }

  const [memories, members, connections, drafts, proposals, summary] = await Promise.all([
    listMemories(CHAT_MEMORY_LIMIT).catch(() => []),
    allMembersWithLinks().catch(() => []),
    member ? connectionsFor(member.id).catch(() => []) : Promise.resolve([]),
    pendingDrafts(chatId).catch(() => []),
    pendingProposals(chatId).catch(() => []),
    chatSummary(chatId).catch(() => ({ summary: null, through: 0 })),
  ])

  const lines: string[] = []
  if (summary.summary) {
    // What the raw window no longer holds; the newest messages follow verbatim.
    lines.push('Earlier in this chat, summarised (the latest messages follow in full):')
    lines.push(summary.summary)
  }
  const family = members.filter((m) => m.allowed)
  if (family.length) {
    // Every member's links, not just the speaker's: without this the model
    // invents claims like "her account isn't linked" about accounts it is
    // actively reading.
    lines.push(
      'Family members and their linked accounts: ' +
        family
          .map((m) => `${m.name}${m.linked.length ? ` (${m.linked.map((l) => `${l.provider}: ${l.email ?? 'linked'}`).join(', ')})` : ' (nothing linked)'}`)
          .join('; ') +
        '.',
    )
  }
  if (member && connections.length === 0) {
    lines.push(`${member.name} has no linked email/calendar account yet; suggest /connect if they ask for one.`)
  }
  if (drafts.length) {
    // Tool results do not survive to the next turn, so the ids must live here
    // or "send it" has nothing to act on and the model drafts in circles.
    lines.push('Email drafts awaiting a yes in this chat (send_email with the draft_id once its owner confirms; never draft the same email again):')
    lines.push(...drafts.map((d) => `- draft_id ${d.id}: to ${d.recipients}, "${d.subject}"`))
  }
  if (proposals.length) {
    lines.push('Event proposals awaiting a yes in this chat (settle with accept_event_proposal or reject_event_proposal and the id):')
    lines.push(...proposals.map((p) => `- proposal_id ${p.id}: "${p.title}" at ${formatLocal(p.startsAt)}`))
  }
  if (memories.length) {
    lines.push('Known household facts:')
    lines.push(...memories.map((m) => `- [${m.id}] ${m.content}`))
  }
  return { text: lines.join('\n'), pendingDrafts: drafts.length > 0 }
}

/** A caption-less photo still needs something for the model to act on. */
function describeAttachments(
  attachments: { mediaType: string; kind: string }[],
): string {
  if (attachments.length === 0) return ''
  const kinds = attachments.map((a) =>
    a.kind === 'voice' ? 'a voice note' : a.mediaType === 'application/pdf' ? 'a PDF' : 'a photo',
  )
  return `[sent ${kinds.join(' and ')} with no message]`
}

/**
 * Plain attribute-style lines, one concern each, and a handful of canonical
 * examples in place of a list of prohibitions. Gemini Flash in particular
 * follows plain lines far better than prose once a prompt carries dozens of
 * rules, and every mode here stays well under that.
 */
export function systemPrompt(input: {
  mode?: AgentMode
  chatType: string
  memberName: string
  now: Date
  context: string
}): string {
  const mode = input.mode ?? 'chat'
  const tz = timezone()
  const head = [
    'You are Hearth, the household assistant for one family, on Telegram.',
    `NOW: ${formatLocal(input.now)} (${tz}). TODAY: ${localDateKey(input.now)}.`,
  ]
  const body = mode === 'sweep' ? sweepPrompt() : mode === 'watcher' ? watcherPrompt(tz) : chatPrompt(input, tz)
  return [...head, ...body, input.context ? `\nContext:\n${input.context}` : '']
    .filter((line) => line !== '' || true)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function chatPrompt(input: { chatType: string; memberName: string }, tz: string): string[] {
  const isGroup = input.chatType !== 'private'
  return [
    `SPEAKING WITH: ${input.memberName}, ${
      isGroup
        ? 'in the family group chat; several people are present, and "my calendar" means the calendar of whoever just spoke'
        : 'in a direct message, so their own email and calendar can be discussed freely'
    }.`,
    '',
    'REPLY: a couple of sentences, the answer only. No preamble, no restating the question, no account of what you searched or discarded.',
    `FORMAT: **bold**, *italic*, \`code\` and - bullets only; no headings or tables. Write in ${language()} with ${units()} units, and read and write every time as ${tz}.`,
    'GROUNDING: state only what a tool result, the chat history or a Known household fact says. When a detail is missing, say it is not stated and offer to find it. Search when a current fact matters (hours, prices, news); weather questions go to the weather tool.',
    'TOOLS: when a tool covers a request, call it rather than saying you cannot. If the tool you need is not in your list, call more_tools with its group (mail, personal_calendar, money, notion, jira, automations) and use it in the next step. Email and personal calendar tools act on the person who just spoke. Household-wide events go on the SHARED calendar with add_family_event. Running lists live in the list tools. Open links with read_url and read what is there. An email missing from the inbox may be archived: search with list_email and a query.',
    'FOUND EVENTS: a date you found in an email, photo or page goes through propose_family_event so a person confirms first. A date you were told directly can go straight on.',
    'PHOTOS, SCANS AND VOICE: read what is sent and report what you actually see. If it is unreadable or carries no date, say so.',
    'MONEY: quote figures exactly as the tools give them; PocketSmith for categories, Up for the raw feed. A payee string is a trading name and a registered city, not where the household went. Where a booking goes, or what a payment was for, comes only from a confirmation email or a Known fact; otherwise say the feed does not say.',
    'MEMORY: Known household facts are already in your context, so use them without announcing them. Call remember when someone asks you to remember something, or corrects a Known fact (pass the old id as replaces). Do not file facts on your own initiative; a nightly pass does that.',
    'COMMANDS the app answers before you see them: /watch (money, inbox or morning watchers), /connect, /accounts, /unlink, /calendar, /whoami, /members, /help, and for admins /allow and /deny. Point people at them rather than improvising.',
    "EMAIL is the one irreversible action: draft_email first and show the draft; send_email only in a LATER turn, after the draft's owner says yes, with the draft_id from Context. Never call both in one response. \"Send it\" or \"yes\" from the owner means call send_email NOW with that draft_id; do not draft again or ask again. A revision is a new draft_email with the full text, and the old draft is superseded.",
    '',
    'EXAMPLES',
    'Good: "Sports day is Wed 10 Sep, 9am to 12pm, per the school email. Add it to the family calendar?"',
    'Good: "The feed shows CHEAPTICKETS SEATTLE, $412.30 on 26 Aug. It does not say where the booking goes; I can look for the confirmation email."',
    'Bad: "Looks like someone booked flights to Seattle!" No source names a trip.',
    'Bad: "Let me check the calendar first... Now the answer:" Working shown; give the answer alone.',
  ]
}

function watcherPrompt(tz: string): string[] {
  return [
    'This is a scheduled check, not a conversation. Whatever you write may be posted to the family chat.',
    'WRITE using only the information under DATA, the tool results you fetch, and the instruction you were given. Do not rely on outside knowledge.',
    'POST: one to three short lines a housemate would find useful; names, amounts and dates exactly as given, the key figure in **bold**.',
    'PURPOSE: say what a payment or message is for only when DATA, a Known fact, a calendar event or a fetched email names it, and say which; otherwise write "purpose not recorded".',
    'FLAGS: each transaction under DATA carries flags worked out from the feed (new_payee, unusually_large, possible_duplicate, money_in). Put a flag into plain words only when it is there; an empty list means nothing stood out. money_in is a credit, a refund or a transfer in, and say which only if the description does.',
    'NOTHING TO SAY: when nothing is worth posting, reply with exactly SKIP.',
    'PROBLEMS: if a tool fails, write PROBLEM: and one line of diagnosis, then SKIP on its own line. That reaches the admins, not the family.',
    `FORMAT: plain Telegram text in ${language()}, ${units()} units, times in ${tz}; no headings, no preamble, no handover line, no commentary about tools.`,
    '',
    'EXAMPLES',
    'Good: "2Up: **$412.30** CHEAPTICKETS SEATTLE, Tue 26 Aug. Purpose not recorded."',
    'Bad: "Looks like someone booked flights to Seattle, planning a trip?" No source names a trip.',
    'Bad: "Scoot is a budget airline, so this is probably the other half. Now the post:" Working shown; post alone.',
    'Skip: DATA lists nothing new. Reply SKIP.',
  ]
}

function sweepPrompt(): string[] {
  return [
    "This is the nightly memory pass. You have yesterday's household talk and the Known household facts, each with its id.",
    'FILE with remember any durable fact that is missing: people (family, friends, neighbours, teachers, coaches, doctors, tradies), birthdays and anniversaries, health, allergies and dietary needs, routines and standing arrangements, schools, clubs and activities, pets, vehicles, sizes, codes and account identifiers, house rules, strong preferences and dislikes.',
    'CORRECT: where the talk contradicts a Known fact, call remember with the new fact and replaces set to the old id. The newer statement wins.',
    'LEAVE OUT one-off plans (the calendar holds those), shopping and list items, tasks, and passing chatter. Do not re-file anything already Known.',
    'WRITE each fact self-contained, so it makes sense months from now.',
    'Then reply with exactly SKIP.',
  ]
}

/**
 * Models that think out loud sometimes narrate their reasoning and then hand
 * over with "Now the post:" — which is how "Scooti/Scoot is a known budget
 * airline ... Now the post:" reached the family chat. The instructions already
 * forbid a preamble; this is what happens when one arrives anyway. Only a
 * handover that genuinely follows prose is cut, so a reply that simply opens
 * "Here's the summary:" keeps its first line.
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

/** Everything that keeps a model's working out of the family chat. */
export function cleanReply(raw: string): { text: string; stripped: boolean } {
  const trimmed = raw.trim()
  const text = stripPreamble(stripReasoning(trimmed))
  return { text, stripped: text !== trimmed }
}

async function historyMessages(chatId: string, excludeId?: number): Promise<ModelMessage[]> {
  const rows = await recentMessages(chatId, undefined, excludeId).catch(() => [])
  return rows.map((r) =>
    r.role === 'assistant'
      ? { role: 'assistant' as const, content: r.content }
      : { role: 'user' as const, content: `${r.authorName ?? 'Someone'}: ${r.content}` },
  )
}

const EVIDENCE_ITEM_CHARS = 2_000
const EVIDENCE_TOTAL_CHARS = 12_000

/**
 * What the tools actually said, compactly, so the post decision can check a
 * draft against its sources rather than against the model's memory of them.
 */
type ToolResultLike = { toolName: string; input: unknown; output: unknown }

export function collectEvidence(steps: ReadonlyArray<{ toolResults?: ReadonlyArray<ToolResultLike> }>): string {
  const parts: string[] = []
  let total = 0
  for (const step of steps) {
    for (const r of step.toolResults ?? []) {
      const line = `${r.toolName}(${JSON.stringify(r.input)}) -> ${JSON.stringify(r.output)}`
      const clipped = line.length > EVIDENCE_ITEM_CHARS ? `${line.slice(0, EVIDENCE_ITEM_CHARS)}…` : line
      if (total + clipped.length > EVIDENCE_TOTAL_CHARS) return parts.join('\n')
      parts.push(clipped)
      total += clipped.length
    }
  }
  return parts.join('\n')
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const mode = input.mode ?? 'chat'
  const now = new Date()
  const ctx: ToolContext = {
    chatId: input.chatId,
    member: input.member,
    memberName: input.memberName,
    now,
    notices: [],
  }

  const [ambient, history] = await Promise.all([
    ambientContext(input.chatId, input.member, mode),
    input.history === false
      ? Promise.resolve([] as ModelMessage[])
      : historyMessages(input.chatId, input.excludeMessageId),
  ])

  const attachments = input.attachments ?? []
  const said = input.text || describeAttachments(attachments)
  const content: UserContent = attachments.length
    ? [
        { type: 'text', text: `${input.memberName}: ${said}` },
        ...attachments.map((a) => ({
          type: 'file' as const,
          data: a.bytes,
          mediaType: a.mediaType,
          ...(a.filename ? { filename: a.filename } : {}),
        })),
      ]
    : `${input.memberName}: ${said}`

  const messages: ModelMessage[] = [...history, { role: 'user', content }]
  const context = ambient.text
  const activeTools = input.tools ?? defaultTools(mode)
  // A chat turn routes: the core set plus the groups its wording calls for,
  // widened by any more_tools call the model makes along the way.
  const routing = mode === 'chat' && !input.tools
  const initialGroups = routing ? routeGroups(input.text, { pendingDrafts: ambient.pendingDrafts }) : []
  const settings = MODE_SETTINGS[mode]
  const reasoning = reasoningLevel()

  const result = await withModelFallback(async (slot: ModelSlot) => {
    const r = await traced(
      {
        traceName: `hearth.${mode}`,
        sessionId: input.chatId,
        ...(input.member ? { userId: input.member.telegramUserId } : {}),
        tags: [mode, input.chatType],
        metadata: { model: slot.name, ...(routing ? { tool_groups: initialGroups.join(',') || 'core' } : {}) },
      },
      () =>
        generateText({
          model: slot.model,
          system: systemPrompt({ mode, chatType: input.chatType, memberName: input.memberName, now, context }),
          messages,
          tools: buildTools(ctx),
          ...(activeTools ? { activeTools } : {}),
          ...(routing
            ? { prepareStep: ({ steps }) => ({ activeTools: activeToolsFor(groupsAfter(initialGroups, steps)) }) }
            : {}),
          stopWhen: isStepCount(MAX_STEPS),
          timeout: { stepMs: STEP_TIMEOUT_MS },
          maxOutputTokens: settings.maxOutputTokens,
          ...(settings.temperature !== undefined ? { temperature: settings.temperature } : {}),
          ...(reasoning ? { reasoning } : {}),
          telemetry: callTelemetry(`hearth.${mode}`),
        }),
    )
    const cleaned = cleanReply(r.text)
    if (cleaned.stripped) console.warn(`[agent] ${slot.name} leaked its working into the reply; stripped`)
    // An empty completion usually means the model ended on a tool call it never
    // summarised; treat it as a failure so the fallback model gets a turn.
    if (!cleaned.text && ctx.notices.length === 0) throw new Error(`${slot.name} returned no text`)
    return {
      text: cleaned.text,
      model: slot.name,
      evidence: mode === 'watcher' ? collectEvidence(r.steps ?? []) : undefined,
    }
  })

  return {
    text: result.text || ctx.notices.join('\n'),
    notices: ctx.notices,
    model: result.model,
    ...(result.evidence !== undefined ? { evidence: result.evidence } : {}),
  }
}

/* ------------------------------------------------------------ post decision */

const postDecisionSchema = z.object({
  decision: z.enum(['post', 'skip']),
  confidence: z.number().min(0).max(1).describe('How sure you are that this decision is right, 0 to 1'),
  message: z
    .string()
    .optional()
    .describe('The final text to post. Only names, figures, dates and purposes present in the evidence. Empty when skipping.'),
  reason: z.string().optional().describe('One line on why'),
})

export type PostDecision = z.infer<typeof postDecisionSchema>

const DECISION_PROMPT = [
  'You decide whether a scheduled family-assistant post goes to the family chat.',
  'You receive +1 if the post is accurate and useful to the household, +0.4 if you choose skip, and -1 if the post contains anything not in the evidence or that the household would not need.',
  'The evidence is the instruction that produced the draft and the results the tools returned. Every name, amount, date and stated purpose in the post must appear there. A claim the evidence does not make means either skip, or remove that claim and post the rest as message.',
  'Statements of what is not known ("purpose not recorded") are accurate and welcome. A reminder whose wording comes from the instruction is grounded in the instruction.',
  'Give your confidence from 0 to 1. Answer with the structured object only.',
].join('\n')

/**
 * A payoff-framed, confidence-bearing decision in a fresh context, checking
 * the draft against what the tools actually said. A bare "reply SKIP if there
 * is nothing" leaves the choice to the model that wrote the draft, which is
 * the one least able to see its own embellishments.
 */
export async function decideWatcherPost(input: {
  label: string
  draft: string
  evidence: string
}): Promise<PostDecision & { model: string }> {
  return withModelFallback(async (slot) => {
    const r = await traced({ traceName: 'hearth.decision', tags: ['decision'], metadata: { label: input.label, model: slot.name } }, () =>
      generateText({
        model: slot.model,
        system: DECISION_PROMPT,
        prompt: `Watcher: ${input.label}\n\nDRAFT:\n${input.draft}\n\nEVIDENCE:\n${input.evidence || '(no tool results)'}`,
        output: Output.object({ schema: postDecisionSchema, name: 'post_decision' }),
        temperature: 0.2,
        maxOutputTokens: 600,
        timeout: { stepMs: 30_000 },
        telemetry: callTelemetry('hearth.decision'),
      }),
    )
    return { ...r.output, model: slot.name }
  })
}

/* -------------------------------------------------------------- draft review */

const MAX_CLAIMS = 6
const claimsSchema = z.object({
  claims: z.array(z.string()).max(MAX_CLAIMS).describe('Checkable statements, one short sentence each, self-contained'),
})
const checkSchema = z.object({
  supported: z.boolean(),
  excerpt: z.string().optional().describe('The words in the evidence that establish it, when supported'),
})
const rewriteSchema = z.object({ message: z.string().describe('The post rebuilt from the supported statements only; empty if they amount to nothing worth posting') })

const EXTRACT_PROMPT = [
  'You list the checkable statements in a short post from a family assistant.',
  'One fact per statement, one short self-contained sentence each: a figure, a date or time, a name, a place, a stated purpose, a flag such as new payee, unusual, duplicate or refund. Never combine two facts in one statement: "$412.30 was paid to Cheaptickets for flights to Seattle" is three statements (the amount, the payee, the flights).',
  'Copy names, payee strings, figures and dates exactly as the post writes them; never shorten or normalise them.',
  'Leave out hedges, offers, questions and statements of what is not known, such as "purpose not recorded".',
  'Return an empty list when there is nothing checkable.',
].join(' ')

const CHECK_PROMPT = [
  'You check one statement against evidence and nothing else.',
  'supported is true when the evidence states the statement or it follows directly from it: a figure that appears, a date that appears, an instruction that says to post exactly this, a sum of listed figures.',
  'Differences of form do not matter: case, punctuation, currency symbols, and a name that is part of a longer string in the evidence (CHEAPTICKETS within CHEAPTICKETS SEATTLE) all count as the same thing.',
  'Differences of substance do: a purpose, place, trip, plan or cause is supported only if the evidence names it. A payee string is not a place anyone went. A statement with any unsupported part is not supported. Do not use outside knowledge.',
  'Quote the excerpt that establishes a supported statement.',
].join(' ')

const REWRITE_PROMPT = [
  'You rebuild a short post for a family chat from a list of supported statements.',
  'Use only the supported statements, in the original post\'s style and order, and reuse its wording where the wording is about those statements.',
  'Nothing from the original that is not in the supported list may appear, however it is phrased: not as a hedge, a question, or a hint.',
  'Return an empty message when the supported statements amount to nothing worth posting.',
].join(' ')

export type DraftReview = { claims: string[]; unsupported: string[]; message: string | null }

/**
 * Chain-of-Verification, factored: pull the checkable claims out of the draft,
 * ask about each one in a fresh context that sees only the evidence (never the
 * draft, so the checker cannot be talked into agreeing with it), then strip
 * what failed. Statements of what is not known are not claims, so a draft
 * that says "purpose not recorded" passes untouched.
 */
export async function reviewDraft(input: { label: string; draft: string; evidence: string }): Promise<DraftReview> {
  const evidence = input.evidence || '(no tool results)'
  const meta = (step: string, model: string) => ({ traceName: 'hearth.verify', tags: ['verify', step], metadata: { label: input.label, model } })

  const claims = (
    await withModelFallback((slot) =>
      traced(meta('extract', slot.name), () =>
        generateText({
          model: slot.model,
          system: EXTRACT_PROMPT,
          prompt: `POST:\n${input.draft}`,
          output: Output.object({ schema: claimsSchema, name: 'claims' }),
          temperature: 0,
          maxOutputTokens: 500,
          timeout: { stepMs: 30_000 },
          telemetry: callTelemetry('hearth.verify'),
        }),
      ).then((r) => r.output.claims),
    )
  ).slice(0, MAX_CLAIMS)
  if (claims.length === 0) return { claims, unsupported: [], message: input.draft }

  const checks = await Promise.all(
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
            timeout: { stepMs: 30_000 },
            telemetry: callTelemetry('hearth.verify'),
          }),
        ).then((r) => r.output),
      ),
    ),
  )
  const unsupported = claims.filter((_, i) => !checks[i].supported)
  if (unsupported.length === 0) return { claims, unsupported, message: input.draft }
  if (unsupported.length === claims.length) return { claims, unsupported, message: null }

  const supported = claims.filter((_, i) => checks[i].supported)
  const rewritten = await withModelFallback((slot) =>
    traced(meta('rewrite', slot.name), () =>
      generateText({
        model: slot.model,
        system: REWRITE_PROMPT,
        prompt: `ORIGINAL POST (for style only):\n${input.draft}\n\nSUPPORTED STATEMENTS:\n${supported.map((c) => `- ${c}`).join('\n')}\n\nNOT SUPPORTED, must not appear in any form:\n${unsupported.map((u) => `- ${u}`).join('\n')}`,
        output: Output.object({ schema: rewriteSchema, name: 'rewrite' }),
        temperature: 0,
        maxOutputTokens: 600,
        timeout: { stepMs: 30_000 },
        telemetry: callTelemetry('hearth.verify'),
      }),
    ).then((r) => r.output.message.trim()),
  )
  return { claims, unsupported, message: rewritten || null }
}

/** A structured call that produced no usable object, as opposed to a transport failure. */
export function isStructuredOutputError(err: unknown): boolean {
  return NoObjectGeneratedError.isInstance(err) || NoOutputGeneratedError.isInstance(err)
}

/* ------------------------------------------------------------ ambient gate */

const GATE_CHOICES = ['reply', 'stay_silent', 'unsure'] as const
type GateChoice = (typeof GATE_CHOICES)[number]

/** For providers that answer in prose anyway: only an unmistakable yes counts. */
function readGateChoice(text: string): GateChoice {
  return /\b(?:reply|yes)\b/i.test(text) ? 'reply' : 'stay_silent'
}

const GATE_RULES = [
  'You decide whether a family assistant bot should reply to a group chat message.',
  'Choose reply only if the message asks a question the assistant can answer, requests an action (reminder, calendar, email, lookup), or clearly addresses the assistant.',
  'Choose stay_silent for banter, reactions, messages between family members, and anything already answered.',
  'Choose unsure when you cannot tell; unsure is treated as silence.',
].join(' ')

/**
 * One typed choice from the gate model. The question is asked from either
 * side, because a forced choice leans towards whatever it was asked about:
 * "should it reply?" over-counts replies, "should it stay silent?" over-counts
 * silence, and only a message that survives both deserves an answer.
 */
async function askGate(
  slot: ModelSlot,
  history: ModelMessage[],
  input: { chatId: string; text: string; memberName: string },
  polarity: 'reply' | 'silence',
): Promise<GateChoice> {
  const question = polarity === 'reply' ? 'Should the assistant reply?' : 'Should the assistant stay silent?'
  const out = await traced({ traceName: 'hearth.gate', sessionId: input.chatId, tags: ['gate', polarity], metadata: { model: slot.name } }, () =>
    generateText({
      model: slot.model,
      system: GATE_RULES,
      messages: [...history, { role: 'user', content: `${input.memberName}: ${input.text}\n\n${question}` }],
      output: Output.choice({ options: [...GATE_CHOICES], name: 'gate' }),
      // Thinking tokens can count against the output budget on some
      // providers, so leave room for them; the answer itself is one word.
      maxOutputTokens: 64,
      temperature: 0.2,
      timeout: { stepMs: 10_000 },
      telemetry: callTelemetry('hearth.gate'),
    }),
  )
  const picked: GateChoice = out.output ?? readGateChoice(out.text)
  console.info(`[gate] ${slot.name} asked:${polarity} -> ${picked} chat=${input.chatId}`)
  return picked
}

/**
 * Cheap gate for ambient group chatter: should the bot chime in at all?
 * Runs on the primary model only, fails closed (stay quiet) on any error, and
 * replies only when the question answered from both sides agrees. Most
 * chatter is settled by the first call; the second is only spent on a
 * message the first call wanted to answer.
 */
export async function shouldChimeIn(input: {
  chatId: string
  text: string
  memberName: string
  excludeMessageId?: number
}): Promise<boolean> {
  const history = (await historyMessages(input.chatId, input.excludeMessageId)).slice(-6)
  try {
    return await withModelFallback(
      async (slot) => {
        const first = await askGate(slot, history, input, 'reply')
        if (first !== 'reply') return false
        const second = await askGate(slot, history, input, 'silence')
        return second === 'reply'
      },
      // Gate on the cheapest model only; falling through the whole chain would
      // spend the day's quota on a coin flip.
      [gateModel()],
    )
  } catch {
    return false
  }
}

function gateModel(): ModelSlot {
  const slot = gateSlot()
  if (!slot) throw new Error('No LLM configured')
  return slot
}
