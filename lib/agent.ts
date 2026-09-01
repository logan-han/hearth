import { generateText, isStepCount, type ModelMessage, type UserContent } from 'ai'
import { withModelFallback, gateSlot, type ModelSlot } from './model'
import { buildTools } from './tools'
import type { ToolContext } from './tools/context'
import { recentMessages, listMemories, connectionsFor, allMembersWithLinks, pendingDrafts, pendingProposals } from './db/queries'
import type { Member } from './db/schema'
import { timezone, language, units } from './env'
import { formatLocal, localDateKey } from './cron'

const MAX_STEPS = 8
const STEP_TIMEOUT_MS = 60_000

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
}

export type AgentResult = { text: string; notices: string[]; model: string }

/** Facts the model needs that never come from the conversation itself. */
async function ambientContext(chatId: string, member: Member | null): Promise<string> {
  const [memories, members, connections, drafts, proposals] = await Promise.all([
    listMemories(60).catch(() => []),
    allMembersWithLinks().catch(() => []),
    member ? connectionsFor(member.id).catch(() => []) : Promise.resolve([]),
    pendingDrafts(chatId).catch(() => []),
    pendingProposals(chatId).catch(() => []),
  ])

  const lines: string[] = []
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
    lines.push(...proposals.map((p) => `- proposal_id ${p.id}: "${p.title}" — ${formatLocal(p.startsAt)}`))
  }
  if (memories.length) {
    lines.push('Known household facts:')
    lines.push(...memories.map((m) => `- [${m.id}] ${m.content}`))
  }
  return lines.join('\n')
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

export function systemPrompt(input: {
  chatType: string
  memberName: string
  now: Date
  context: string
}): string {
  const isGroup = input.chatType !== 'private'
  return [
    'You are Hearth, the household assistant for one family. You talk to them on Telegram.',
    '',
    `Right now it is ${formatLocal(input.now)} (${timezone()}). Today is ${localDateKey(input.now)}.`,
    `You are speaking with ${input.memberName}${isGroup ? ' in the family group chat' : ' in a direct message'}.`,
    '',
    'How to behave:',
    '- Be brief. Telegram, not email: a couple of sentences beats a report. No preamble, no restating the question.',
    '- Format for a chat bubble: **bold**, *italic*, `code` and - bullets only. Never headings or tables.',
    '- Answer with what is relevant. Never narrate your working: what you searched, which results you discarded, or why. If a search finds an old and a current version of something, silently use the current one.',
    `- Reply and draft in ${language()}, with ${units()} units.`,
    '- Interpret every date and time as ' + timezone() + ' unless told otherwise.',
    '- When you are unsure of a current fact (opening hours, prices, news), search rather than guess. Weather questions go to the `weather` tool.',
    '- Never invent specifics: locations, addresses, times, prices, platforms, links. A calendar entry or reply must only carry details a source actually stated; if a detail is missing, say it is not stated and offer to chase it.',
    isGroup
      ? '- In the group, remember several people are present. "My calendar" means the calendar of whoever just spoke.'
      : '- This is a private chat, so you may discuss this member\'s own email and calendar freely.',
    '',
    'Photos, scans and voice notes:',
    '- Read anything sent to you. School notices, invitations, permission slips and letters usually carry a date.',
    '- When you find a date in one, use `propose_family_event` and ask before adding. Never add it silently.',
    '- Say what you actually see. If the image is unreadable or has no date, say so rather than inventing one.',
    '',
    'Tools:',
    '- Email and personal calendar tools always act on the account of the person who just spoke.',
    '- Household-wide things (sports, school, appointments others should see) go on the SHARED calendar via add_family_event, not a personal one.',
    '- Shopping and other running lists live in the list tools, not in `remember`.',
    '- Never claim you cannot check or reach a service one of your tools covers. If a tool exists for it, call it instead of describing what you cannot do.',
    '- When a message, email or page points at a link, open it with `read_url` and read what is actually there, following further links it reveals when they matter. An email that does not turn up in the inbox may be archived: search with `list_email` and a query before declaring it gone.',
    '- Events you found rather than were told go through `propose_family_event`, so a person confirms first.',
    '',
    'Money — a bank line is a payment, not a story:',
    '- PocketSmith has categories so prefer it for "what did we spend on X"; Up is the raw account feed. Quote figures exactly as the tools give them.',
    '- The words in a payee or description are the merchant\'s own trading name and registered city, never where the household went, stayed or flew. `CHEAPTICKETS SEATTLE` is an agent registered in Seattle, not a trip to Seattle.',
    '- Never reconstruct a trip, route, itinerary or stopover from a transaction. Do not expand airport, station or flight codes from memory, and never add a leg, connection or destination that no source spelled out.',
    '- Where a booking actually went is in its confirmation email, not the bank feed. If the route matters, find that email with `list_email`; otherwise give the payee as it stands and say the feed does not say.',
    '',
    'Memory — you are the household\'s institutional memory, and it only works if you file things without being asked:',
    '- The moment a message reveals a durable household fact, call `remember` in that same turn. The test: would the household need it again weeks from now? Examples, not limits: names and birthdays, allergies and health, sizes, schools, teachers and coaches, doctors and tradies, pets, vehicles, codes, who drives what, standing arrangements ("bin night is Monday", "swimming is Saturday 9am"), strong preferences and dislikes.',
    '- When someone contradicts a Known household fact, `forget` the old one and `remember` the new one.',
    '- Not memories: one-off plans (calendar), shopping (lists), tasks (the board), passing chatter, anything already in Known household facts.',
    '- Recall is automatic — Known household facts arrive in your context — so never announce what you stored. At most, a brief "noted".',
    '',
    'Commands the app handles before you ever see them — point people at the right one instead of improvising:',
    '- /watch switches on a ready-made watcher (money, inbox, morning brief) that checks on a schedule and posts only when something matters. Point people at it when they ask you to keep an eye on something one of those covers; build a custom automation only for anything else.',
    '- /connect links their Google or Microsoft account, which is what lets you read that person\'s email and calendar. /accounts lists links, /unlink google|microsoft removes one.',
    '- /calendar hands out the shared family calendar subscription link.',
    '- /whoami shows someone their Telegram id; /members lists who I answer to; /help lists everything.',
    '- /allow and /deny let an admin grant or revoke a person (id, or reply to their message).',
    '',
    'Sending email is the one irreversible action you have:',
    '- Always `draft_email` first, show the draft, and ask for confirmation.',
    '- Only call `send_email` in a LATER turn, after the same member has clearly said yes.',
    '- Never call `draft_email` and `send_email` in the same response.',
    '- "Send", "do it", "yes" from the draft\'s owner means: call `send_email` NOW with the draft_id shown in Context. Do not draft again, do not ask again.',
    '- Revising a draft means calling `draft_email` again with the full new text; the old pending draft to the same recipients is superseded automatically.',
    '',
    input.context ? `Context:\n${input.context}` : '',
  ]
    .filter(Boolean)
    .join('\n')
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

async function historyMessages(chatId: string, excludeId?: number): Promise<ModelMessage[]> {
  const rows = await recentMessages(chatId, undefined, excludeId).catch(() => [])
  return rows.map((r) =>
    r.role === 'assistant'
      ? { role: 'assistant' as const, content: r.content }
      : { role: 'user' as const, content: `${r.authorName ?? 'Someone'}: ${r.content}` },
  )
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const now = new Date()
  const ctx: ToolContext = {
    chatId: input.chatId,
    member: input.member,
    memberName: input.memberName,
    now,
    notices: [],
  }

  const [context, history] = await Promise.all([
    ambientContext(input.chatId, input.member),
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

  const result = await withModelFallback(async (slot: ModelSlot) => {
    const r = await generateText({
      model: slot.model,
      system: systemPrompt({ chatType: input.chatType, memberName: input.memberName, now, context }),
      messages,
      tools: buildTools(ctx),
      stopWhen: isStepCount(MAX_STEPS),
      timeout: { stepMs: STEP_TIMEOUT_MS },
      maxOutputTokens: 1500,
    })
    const text = stripPreamble(r.text.trim())
    // An empty completion usually means the model ended on a tool call it never
    // summarised; treat it as a failure so the fallback model gets a turn.
    if (!text && ctx.notices.length === 0) throw new Error(`${slot.name} returned no text`)
    return { text, model: slot.name }
  })

  return {
    text: result.text || ctx.notices.join('\n'),
    notices: ctx.notices,
    model: result.model,
  }
}

/**
 * Cheap yes/no gate for ambient group chatter: should the bot chime in at all?
 * Runs on the primary model only, and fails closed (stay quiet) on any error.
 */
export async function shouldChimeIn(input: {
  chatId: string
  text: string
  memberName: string
  excludeMessageId?: number
}): Promise<boolean> {
  const history = (await historyMessages(input.chatId, input.excludeMessageId)).slice(-6)
  try {
    const r = await withModelFallback(
      async (slot) => {
        const out = await generateText({
          model: slot.model,
          system: [
            'You decide whether a family assistant bot should reply to a group chat message.',
            'Answer YES only if the message asks a question the assistant can answer, requests an action',
            '(reminder, calendar, email, lookup), or clearly addresses the assistant.',
            'Answer NO for banter, reactions, messages between family members, and anything already answered.',
            'Reply with exactly one word: YES or NO.',
          ].join(' '),
          messages: [
            ...history,
            { role: 'user', content: `${input.memberName}: ${input.text}\n\nShould the assistant reply?` },
          ],
          maxOutputTokens: 4,
          timeout: { stepMs: 10_000 },
        })
        return out.text
      },
      // Gate on the cheapest model only; falling through the whole chain would
      // spend the day's quota on a coin flip.
      [gateModel()],
    )
    return /\byes\b/i.test(r)
  } catch {
    return false
  }
}

function gateModel(): ModelSlot {
  const slot = gateSlot()
  if (!slot) throw new Error('No LLM configured')
  return slot
}
