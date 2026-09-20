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

export function buildTools(ctx: ToolContext) {
  return {
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
  }
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

