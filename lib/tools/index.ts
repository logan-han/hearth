import { searchTools } from './search'
import { mailTools } from './mail'
import { calendarTools } from './calendar'
import { familyCalendarTools } from './familycal'
import { proposalTools } from './proposals'
import { listTools } from './lists'
import { moneyTools } from './money'
import { notionTools } from './notion'
import { jiraTools } from './jira'
import { memoryTools } from './memory'
import { automationTools } from './automation'
import { weatherTools } from './weather'
import { browseTools } from './browse'
import { routerTools, CORE_TOOLS, TOOL_GROUPS } from './router'
import type { ToolContext } from './context'

/** Tools whose results carry text written outside the household. See ToolContext.readUntrusted. */
const UNTRUSTED_SOURCES = new Set([
  'web_search', 'read_url',
  'list_email', 'new_mail', 'read_email', 'read_attachment',
  'list_calendar',
  'notion_search', 'notion_read_page', 'notion_query_database',
  'jira_search', 'jira_board_summary', 'jira_read_issue',
])

export function buildTools(ctx: ToolContext) {
  return instrument(ctx, {
    ...searchTools,
    ...mailTools(ctx),
    ...calendarTools(ctx),
    ...familyCalendarTools(ctx),
    ...proposalTools(ctx),
    ...listTools(ctx),
    ...moneyTools(ctx),
    ...notionTools(ctx),
    ...jiraTools(ctx),
    ...memoryTools(ctx),
    ...automationTools(ctx),
    ...weatherTools(ctx),
    ...browseTools(ctx),
    ...routerTools(),
  })
}

/**
 * Writes that would happen twice if the turn were run again: nothing in them
 * checks for an earlier copy. Every other write tool supersedes, dedupes or
 * claims before it writes (see ToolContext.wrote).
 */
const UNREPEATABLE: ReadonlySet<string> = new Set([
  'add_to_list', 'create_automation', 'create_calendar_event',
  'jira_create_issue', 'jira_comment', 'jira_attach_email_file', 'notion_append_to_page',
])

/** A link as it would be written anywhere: no scheme, no closing slash. */
const linkKey = (url: string) => url.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '')

/**
 * What no written link holds: whitespace and control characters, which
 * `new URL` encodes or drops, and the quotes, angle brackets and backslash
 * that end a link in text or escape a line break in a tool's JSON. An
 * address with one in it runs on from a link into the words beside it.
 */
const NOT_IN_A_LINK = /[\s\x00-\x1f\x7f"<>\\]/

/**
 * Whether `key` stands in `text` as a whole link: starting where a host
 * starts (after a scheme or an @, or after something no link holds, such as
 * an escaped line break in a tool's JSON), not partway into a longer host or
 * path, and not as the start of a longer one.
 */
function standsIn(text: string, key: string): boolean {
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + 1)) {
    const before = text.slice(Math.max(0, at - 2), at)
    const starts = before.endsWith('//') || /\\[nrt]$/.test(before) || !/[\w\-.~%/?#=&+:]$/.test(before)
    const next = text.slice(at + key.length).replace(/^\//, '')
    if (starts && !/^[\w\-~%/?#=&+@]/.test(next)) return true
  }
  return false
}

/**
 * Whether a link was in something the turn was given or read, before the
 * model had written it into a call of its own: a result that only echoes
 * the model's own words back (a search answer, a note it just saved) vouches
 * for nothing. Scheme, host case and a closing slash may differ.
 */
function linkSeen(ctx: ToolContext, url: string): boolean {
  if (NOT_IN_A_LINK.test(url.trim())) return false
  let href = url
  try {
    href = new URL(url).href
  } catch {
    // Judged as written; read_url turns it away itself.
  }
  const keys = [...new Set([linkKey(url), linkKey(href)])].filter(Boolean)
  const typed = ctx.typed ?? []
  return (ctx.seen ?? []).some((s) =>
    keys.some((k) => standsIn(s.text, k) && !typed.slice(0, s.typed).some((t) => t.includes(k))),
  )
}

/** What a second call to an unrepeatable write gets, once an earlier one this turn may have gone through. */
const unconfirmedAgain = (name: string) =>
  `Not tried again: ${name} ran out of time earlier this turn and may have gone through, so a second call could do it twice. ` +
  'Say it may not have happened and what to check.'

const UNSEEN_LINK =
  'Not opened: this turn has read mail, a page or a file from outside the household, and this address does not ' +
  'appear in anything it was given or read. Open a link only exactly as it appears there; if it was in a photo or ' +
  'a scan, ask for it to be sent as text.'

/**
 * Wrap every tool so the turn keeps its record: what the model wrote into
 * each call and what came back (see ToolContext.seen). An outside-content
 * tool also marks the turn as having read something untrusted, and a write
 * records itself once it has succeeded (a result with an `error` changed
 * nothing), or once it may have: one with `maybe_done` ran out of time and
 * could have gone through all the same, and is kept apart from those that
 * did. Once something untrusted has been read, read_url opens only a link
 * that was there to be read. An unrepeatable write that may have gone
 * through is not called again in the same turn, whatever the prompt says:
 * nothing in it would notice the copy.
 */
function instrument<T extends Record<string, { execute?: (...args: never[]) => unknown }>>(ctx: ToolContext, tools: T): T {
  const out: Record<string, unknown> = { ...tools }
  for (const [name, t] of Object.entries(tools)) {
    const untrusted = UNTRUSTED_SOURCES.has(name)
    const writes = WRITE_TOOLS.has(name as ToolName)
    const unrepeatable = UNREPEATABLE.has(name)
    if (!t.execute) continue
    const execute = t.execute
    out[name] = {
      ...t,
      execute: async (...args: never[]) => {
        const input: unknown = args[0]
        const typed = (ctx.typed ??= [])
        typed.push(JSON.stringify(input) ?? '')
        if (unrepeatable && ctx.unconfirmed?.includes(name)) return { error: unconfirmedAgain(name) }
        if (name === 'read_url') {
          const url = String((input as { url?: unknown } | undefined)?.url ?? '')
          if (ctx.readUntrusted && !linkSeen(ctx, url)) return { error: UNSEEN_LINK }
          // Opened before anything untrusted was read, it came from the family's words alone, and may be read again.
          if (!ctx.readUntrusted) (ctx.seen ??= []).push({ text: url, typed: 0 })
        }
        if (untrusted) ctx.readUntrusted = true
        const result = await execute(...args)
        ;(ctx.seen ??= []).push({ text: JSON.stringify(result) ?? '', typed: typed.length })
        const failed = typeof result === 'object' && result !== null && 'error' in result
        const maybe = failed && (result as { maybe_done?: unknown }).maybe_done === true
        if (writes && !failed) (ctx.changed ??= []).push(name)
        if (writes && maybe) (ctx.maybeChanged ??= []).push(name)
        if (unrepeatable && (!failed || maybe)) (ctx.wrote ??= []).push(name)
        if (unrepeatable && maybe) (ctx.unconfirmed ??= []).push(name)
        return result
      },
    }
  }
  return out as T
}

export type { ToolContext }
export { TOOL_GROUPS, CORE_TOOLS, SITUATIONAL_TOOLS, routeGroups, groupsAfter, activeToolsFor, type ToolGroup } from './router'

export type ToolName = keyof ReturnType<typeof buildTools>

/**
 * What a member's own scheduled instruction may reach for: read, look up and
 * propose. Nothing that sends, deletes or reschedules, because a run happens
 * with nobody watching and cannot ask for a yes.
 */
export const CUSTOM_AUTOMATION_TOOLS: ToolName[] = [
  'web_search', 'read_url', 'weather', 'recall',
  'list_email', 'new_mail', 'read_email', 'read_attachment',
  'list_calendar', 'list_family_events', 'propose_family_event', 'list_event_proposals',
  'show_list', 'show_lists', 'add_to_list',
  'list_bank_accounts', 'list_transactions', 'spending_summary', 'new_transactions', 'budget_summary',
  'notion_search', 'notion_read_page', 'notion_query_database',
  'jira_search', 'jira_board_summary', 'jira_read_issue',
]

/** The nightly memory pass files and corrects facts, and asks about the ones it cannot stand behind. */
export const SWEEP_TOOLS: ToolName[] = ['remember', 'forget', 'recall', 'unsure']

/**
 * What an MCP client is handed: everything, less the two that mean nothing
 * down that pipe. `more_tools` exists so a small model can be routed to a
 * short list and widen it; an MCP client is given the whole set at once.
 * `import_calendar_file` reads a file attached to the message being answered,
 * and here there is no message.
 */
export const MCP_TOOLS: ToolName[] = [
  ...CORE_TOOLS.filter((t) => t !== 'more_tools'),
  ...Object.values(TOOL_GROUPS).flat(),
  'unsure',
] as ToolName[]

/**
 * Tools that change something: the calendar, a list, memory, mail, the board,
 * a schedule. A reply that says one of these happened has to be backed by a
 * call to one of them, or the reply is describing work that was never done.
 */
export const WRITE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'add_family_event', 'update_family_event', 'cancel_family_event', 'import_calendar_file',
  'propose_family_event', 'accept_event_proposal', 'reject_event_proposal',
  'add_to_list', 'check_off_list', 'remove_from_list', 'clear_list',
  'remember', 'forget', 'unsure', 'answer_question',
  'draft_email', 'send_email', 'cancel_draft', 'create_calendar_event',
  'notion_append_to_page', 'jira_create_issue', 'jira_update_issue', 'jira_move_issue', 'jira_comment', 'jira_attach_email_file',
  'create_automation', 'delete_automation', 'pause_automation',
])

/**
 * Writes that only put something to a person: a draft waits on its owner's
 * yes, a proposal on anyone's. Until then the email is unsent and the
 * calendar unchanged, so neither backs a reply that says it was done.
 */
export const PENDING_WRITES: ReadonlySet<ToolName> = new Set<ToolName>(['draft_email', 'propose_family_event'])

