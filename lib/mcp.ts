/**
 * Hearth's tools, offered over the Model Context Protocol.
 *
 * An MCP client is the only way in besides the dashboard, and it gets every
 * tool at once: a capable client picks well from a long list. Every call runs
 * as the member whose key it carries: their mailbox, their calendar, their
 * name on what it writes.
 *
 * Nothing here imports the MCP SDK. The transport lives in the route; this
 * file only turns a tool name and some input into an answer, so it can be
 * tested without standing a server up.
 */
import { z } from 'zod'
import { buildTools, allToolNames } from './tools'
import type { ToolContext } from './tools/context'
import {
  listMemories, openQuestions, connectionsFor, allMembersWithLinks, pendingDrafts, pendingProposals, goalsIn,
  listHelpers, listRoutines, reportsFor,
} from './db/queries'
import { goalSummary } from './tools/goals'
import { spanLabel } from './tools/familycal'
import { reportView } from './tools/automation'
import { roleInBrief } from './helpers'
import { hydrateSecrets } from './settings'
import { formatLocal } from './cron'
import { timezone, appUrl } from './env'
import { describeError } from './errors'
import { commitCursors } from './tools/cursor'
import type { Member } from './db/schema'

export const SERVER_INFO = { name: 'hearth', version: '2.0.0' }

/** The name of the tool that carries what a client needs before its first call. */
export const CONTEXT_TOOL = 'hearth_context'

/** What the client is told about this server before it calls anything. */
export const INSTRUCTIONS = [
  "Hearth is one household's assistant: a shared family calendar, shared lists, the facts the",
  "household keeps, each member's own mail and calendar, the money feed, Notion and the family",
  'board. You are calling as one member of that family, and every change is made in their name.',
  '',
  `Call ${CONTEXT_TOOL} first. It says who you are acting as, the household clock, the family and`,
  'their linked accounts, the facts on file, and whatever is still open, with the ids the other',
  'tools take. morning_brief and money_snapshot gather the day and the money in one call each.',
  '',
  'Nothing is posted anywhere: what you are told is for you to pass on. Nothing is sent or added',
  "behind the household's back either. draft_email writes an email and leaves it until send_email",
  'is called with its id after a yes, and propose_family_event puts an event to the family rather',
  'than adding it.',
].join('\n')

/** The one line that adds a key to Claude Code. */
export function connectLine(key: string): string {
  return `claude mcp add --transport http hearth ${appUrl()}/api/mcp --header "Authorization: Bearer ${key}"`
}

/** A tool as an MCP client sees it, before anyone has said who is calling. */
export type Descriptor = { name: string; description: string; inputSchema: z.ZodType }

/**
 * Descriptions and schemas are the same whoever asks, so they can be read off
 * a context-free build; only the call itself needs to know who is calling.
 */
const BLANK: ToolContext = { member: null, memberName: '', now: new Date(0) }

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
        'Who you are acting as, the household clock, the family and their linked accounts, the facts on file, ' +
        'your email drafts and the event proposals awaiting a yes, the questions still open, your goals, the helpers and routines, ' +
        'and the latest reports from your scheduled jobs. Read it before your first call; the ids the other tools take come from here.',
      inputSchema: z.object({}),
    },
    ...allToolNames().map((name) => ({
      name,
      description: built[name].description ?? '',
      inputSchema: built[name].inputSchema,
    })),
  ]
}

/** The member a call runs as, and which of their keys it came with: each key keeps its own "what's new" markers. */
export type Caller = { member: Member; keyId: number }

export type McpResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const answer = (text: string, isError = false): McpResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
})

/** Run one tool as this member. Every failure comes back as a result, never as a throw. */
export async function callTool(name: string, input: unknown, caller: Caller): Promise<McpResult> {
  const { member } = caller
  try {
    // The keys the tools reach for are stored, not deployed, so they have to be
    // in the environment before the first one runs.
    await hydrateSecrets()
    if (name === CONTEXT_TOOL) return answer(await context(member))

    // What this key has seen is its own, so one client never spends what
    // another of the member's clients, or their morning brief, has not shown.
    const ctx: ToolContext = { member, memberName: member.name, now: new Date(), cursorScope: `key:${caller.keyId}`, via: 'mcp' }
    const entry = registry(ctx)[name]
    if (!entry?.execute) return answer(`Hearth has no tool called ${name}.`, true)
    const result = await entry.execute(input as never, { toolCallId: `mcp-${name}`, messages: [] } as never)
    // The client has the result in hand, so what it reported as new is seen.
    await commitCursors(ctx.pendingCursors)
    return answer(render(result))
  } catch (err) {
    return answer(describeError(err), true)
  }
}

/** Facts are cheap to keep and costly to read; the context carries the newest few dozen, recall the rest. */
const FACTS_IN_CONTEXT = 50
/** How far back the context looks for reports from the member's scheduled jobs. */
const REPORT_DAYS = 3
const REPORTS_IN_CONTEXT = 5

/**
 * Everything a client needs before its first call: who it acts as, the
 * household clock, the family and their linked accounts, what is waiting on
 * a yes, the open questions, the member's own goals, the helpers and
 * routines, the latest reports and the facts on file. Another member's
 * drafts, goals and reports are never in it.
 */
export async function context(member: Member, now: Date = new Date()): Promise<string> {
  const [memories, questions, members, connections, drafts, proposals, goals, crew, routines, reports] = await Promise.all([
    listMemories(FACTS_IN_CONTEXT).catch(() => []),
    openQuestions().catch(() => []),
    allMembersWithLinks().catch(() => []),
    connectionsFor(member.id).catch(() => []),
    pendingDrafts(member.id).catch(() => []),
    pendingProposals(now).catch(() => []),
    goalsIn({ memberId: member.id })
      .then((rows) => Promise.all(rows.map((g) => goalSummary(g, now))))
      .catch(() => []),
    listHelpers().catch(() => []),
    listRoutines().catch(() => []),
    reportsFor(member.id, { since: new Date(now.getTime() - REPORT_DAYS * 86_400_000), limit: REPORTS_IN_CONTEXT }).catch(() => []),
  ])

  const lines = [
    `You are acting as ${member.name}${member.isAdmin ? ', an admin of this household' : ''}.`,
    `NOW: ${formatLocal(now)} (${timezone()}).`,
  ]
  const family = members.filter((m) => m.allowed)
  if (family.length) {
    // Every member's links, not just the caller's: without this a client
    // invents claims like "her account isn't linked" about accounts that are.
    lines.push(
      'Family members and their linked accounts: ' +
        family
          .map((m) => `${m.name}${m.linked.length ? ` (${m.linked.map((l) => `${l.provider}: ${l.email ?? 'linked'}${l.readOnly ? ', read only' : ''}`).join(', ')})` : ' (nothing linked)'}`)
          .join('; ') +
        '. Mail and personal calendars are read as the caller alone; nobody else\'s is ever opened.',
    )
  }
  if (connections.length === 0) {
    lines.push(`${member.name} has no linked email or calendar account yet; they can link one at ${appUrl()}/connect.`)
  }
  if (drafts.length) {
    lines.push('Your email drafts awaiting a yes (send_email with the draft_id once you have it; never draft the same email again):')
    lines.push(...drafts.map((d) => `- draft_id ${d.id}: to ${d.recipients}, "${d.subject}"`))
  }
  if (proposals.length) {
    lines.push('Event proposals awaiting a yes from anyone in the family (accept_event_proposal or reject_event_proposal with the id):')
    lines.push(...proposals.map((p) => `- proposal_id ${p.id}: "${p.title}" at ${spanLabel(p.startsAt, p.endsAt, p.allDay)}`))
  }
  if (questions.length) {
    lines.push('Questions put to the family, still open (answer_question with the id: the fact in their words for a yes or a correction, nothing for a no):')
    lines.push(...questions.map((qn) => `- question_id ${qn.id}: ${qn.question} (would keep: "${qn.candidate}")`))
  }
  if (goals.length) {
    lines.push('Your goals in progress (goal_status for the detail; update_goal to tick steps off or add them, log progress, move the target or close one):')
    lines.push(
      ...goals.map(
        (g) =>
          `- goal_id ${g.goal_id}: "${g.title}", ${g.steps_done} of ${g.steps_total} steps done` +
          (g.target_date ? `, target ${g.target_date} (${g.days_left} days)` : '') +
          (g.next_step ? `, next: ${g.next_step}` : ''),
      ),
    )
  }
  if (crew.length) {
    lines.push('Helpers (hand_off gives one a job to do in the background; asked to talk to one, take its role up):')
    lines.push(...crew.map((h) => `- ${h.name}: ${roleInBrief(h.role)}`))
  }
  if (routines.length) {
    lines.push(`Routines kept (run_routine by name when one is asked for, then carry out its steps): ${routines.map((r) => r.name).join('; ')}.`)
  }
  if (reports.length) {
    lines.push(`Reports from your scheduled jobs in the last ${REPORT_DAYS} days, newest first (list_reports for more):`)
    lines.push(
      ...reports.map((r) => {
        const v = reportView(r)
        return `- ${v.when}, ${v.from}${v.helper ? ` (${v.helper})` : ''}, ${v.status}: ${v.report.replace(/\s+/g, ' ').slice(0, 300)}${v.detail ? ` [${v.detail}]` : ''}`
      }),
    )
  }
  if (memories.length) {
    lines.push('Known household facts:')
    lines.push(...memories.map((m) => `- [${m.id}] ${m.content}`))
  }
  return lines.join('\n')
}

const render = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)
