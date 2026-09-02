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
import { routerTools } from './router'
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
export { TOOL_GROUPS, CORE_TOOLS, routeGroups, groupsAfter, activeToolsFor, type ToolGroup } from './router'

export type ToolName = keyof ReturnType<typeof buildTools>

/**
 * What a member's own scheduled instruction may reach for: read, look up and
 * propose. Nothing that sends, deletes or reschedules, because a run happens
 * with nobody watching and cannot ask for a yes.
 */
export const CUSTOM_AUTOMATION_TOOLS: ToolName[] = [
  'web_search', 'read_url', 'weather', 'recall',
  'list_email', 'new_mail', 'read_email',
  'list_calendar', 'list_family_events', 'propose_family_event', 'list_event_proposals',
  'show_list', 'show_lists', 'add_to_list',
  'list_bank_accounts', 'list_transactions', 'spending_summary', 'new_transactions', 'budget_summary',
  'notion_search', 'notion_read_page', 'notion_query_database',
  'jira_search', 'jira_board_summary', 'jira_read_issue',
]

/** The nightly memory pass only files and corrects facts. */
export const SWEEP_TOOLS: ToolName[] = ['remember', 'forget', 'recall']

