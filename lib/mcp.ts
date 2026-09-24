/**
 * Hearth's tools, offered over the Model Context Protocol.
 *
 * The same tool objects the agent loop is handed: an MCP client gets the whole
 * set at once rather than the routed subset a small model sees, because a
 * capable client picks well from a long list and has no `more_tools` step to
 * spend a round trip on.
 *
 * Nothing here imports the MCP SDK. The transport lives in the route; this
 * file only turns a tool name and some input into an answer, so it can be
 * tested without standing a server up.
 */
import { z } from 'zod'
import { buildTools, MCP_TOOLS } from './tools'
import type { ToolContext } from './tools/context'
import { ambientContext } from './agent'
import { groupChats } from './db/queries'
import { hydrateSecrets } from './settings'
import { formatLocal } from './cron'
import { timezone } from './env'
import { describeError } from './errors'
import { send } from './telegram'
import { unaccountedIn } from './headcount'
import { commitCursors } from './tools/cursor'
import { isGroupChat } from './watchers'
import type { Member } from './db/schema'

export const SERVER_INFO = { name: 'hearth', version: '1.0.0' }

/** The name of the tool that stands in for the context a chat turn gets free. */
export const CONTEXT_TOOL = 'hearth_context'

/** What the client is told about this server before it calls anything. */
export const INSTRUCTIONS = [
  "Hearth is one household's assistant: a shared family calendar, shared lists, the facts the",
  "household keeps, each member's own mail and calendar, the money feed, Notion and the family",
  'board. You are calling as one member of that family, and every change is made in their name.',
  '',
  `Call ${CONTEXT_TOOL} first. It carries what Hearth tells its own model before any conversation:`,
  'who you are acting as, the room your posts land in, the household clock, the family and their',
  'linked accounts, the facts on file, and whatever is still open. Dates and ids in the other',
  'tools mean little without it.',
  '',
  'Some tools speak to the family themselves: anything that comes back as `posted` has already',
  "been said in the household's chat, so say it again only if you are adding to it.",
  '',
  "Nothing is sent or added behind the household's back. draft_email writes an email and leaves it",
  'until send_email is called with its id, and propose_family_event puts an event to the family',
  'rather than adding it.',
].join('\n')

/** A tool as an MCP client sees it, before anyone has said who is calling. */
export type Descriptor = { name: string; description: string; inputSchema: z.ZodType }

/**
 * Descriptions and schemas are the same whoever asks, so they can be read off
 * a context-free build; only the call itself needs to know who is calling.
 */
const BLANK: ToolContext = { chatId: '', member: null, memberName: '', now: new Date(0), notices: [] }

type Executable = {
  description?: string
  inputSchema: z.ZodType
  execute?: (input: never, options: never) => Promise<unknown>
}

const registry = (ctx: ToolContext) => buildTools(ctx) as unknown as Record<string, Executable>

export function descriptors(): Descriptor[] {
  const built = registry(BLANK)
  return [
    {
      name: CONTEXT_TOOL,
      description:
        'Who you are acting as, the room anything you post lands in, the household clock, and everything ' +
        'Hearth tells its own model before a conversation: the family and their linked accounts, the facts ' +
        'on file, the email drafts and event proposals awaiting a yes, and the questions still open. ' +
        'Read it before your first call; the ids the other tools take come from here.',
      inputSchema: z.object({}),
    },
    ...MCP_TOOLS.map((name) => ({
      name,
      description: built[name].description ?? '',
      inputSchema: built[name].inputSchema,
    })),
  ]
}

/**
 * The room an MCP call acts in, which decides where a posted line goes and
 * which chat a draft, proposal or reminder belongs to. The household's own
 * group, or, while someone unrecognised is in it — that room is not the
 * household's — the member's own chat with the bot, whose id is theirs.
 */
export async function mcpChat(member: Member): Promise<string> {
  const rooms = await groupChats().catch(() => [])
  return rooms.find((r) => r.strangers.length === 0)?.chatId ?? member.telegramUserId
}

export type McpResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const answer = (text: string, isError = false): McpResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
})

/** Run one tool as this member. Every failure comes back as a result, never as a throw. */
export async function callTool(name: string, input: unknown, member: Member): Promise<McpResult> {
  try {
    // The keys the tools reach for are stored, not deployed, so they have to be
    // in the environment before the first one runs.
    await hydrateSecrets()
    const chatId = await mcpChat(member)
    if (name === CONTEXT_TOOL) return answer(await context(member, chatId))

    if (!(MCP_TOOLS as string[]).includes(name)) return answer(`Hearth has no tool called ${name}.`, true)
    const ctx: ToolContext = { chatId, member, memberName: member.name, now: new Date(), notices: [] }
    const entry = registry(ctx)[name]
    if (!entry?.execute) return answer(`Hearth has no tool called ${name}.`, true)

    const result = await entry.execute(input as never, { toolCallId: `mcp-${name}`, messages: [] } as never)
    // The client has the result in hand, so what it reported as new is seen.
    await commitCursors(ctx.pendingCursors)
    const trouble = await speak(ctx)
    return answer([render(result), trouble].filter(Boolean).join('\n\n'))
  } catch (err) {
    return answer(describeError(err), true)
  }
}

/**
 * A tool that asked Hearth to say something says it to the family, the same as
 * it would on a chat turn. A client that cannot reach Telegram still gets its
 * result, with the promise the tool made withdrawn in as many words.
 */
async function speak(ctx: ToolContext): Promise<string> {
  if (ctx.notices.length === 0) return ''
  try {
    // Nobody in the room asked for this line, so it is held to the watchers'
    // rule: the group only while Telegram's head count is all family, and
    // otherwise the member's own chat, where it still gets said.
    const own = ctx.member?.telegramUserId
    const room = own && isGroupChat(ctx.chatId) && (await unaccountedIn(ctx.chatId)) !== 0 ? own : ctx.chatId
    await send(room, ctx.notices.join('\n'))
    return room === ctx.chatId
      ? ''
      : 'Hearth posted this in your own chat rather than the family group, which has people in it I cannot account for.'
  } catch (err) {
    return `Hearth could not post this in the family chat (${describeError(err)}), so nobody there has been told. Say it yourself.`
  }
}

async function context(member: Member, chatId: string): Promise<string> {
  const ambient = await ambientContext(chatId, member, 'chat')
  const room = chatId === member.telegramUserId ? 'your own chat with Hearth' : 'the family group'
  return [
    `You are acting as ${member.name}${member.isAdmin ? ', an admin of this household' : ''}.`,
    `Anything Hearth posts on your behalf lands in ${room}.`,
    `NOW: ${formatLocal(new Date())} (${timezone()}).`,
    ambient.text,
  ]
    .filter(Boolean)
    .join('\n')
}

const render = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)
