import { tool } from 'ai'
import { z } from 'zod'
import type { ToolName } from './index'

/**
 * Which tools a chat turn sees. A small model picks the right tool far more
 * often from twenty than from forty-six, so the everyday set is always in
 * reach and the rest sit behind groups: switched on by cues in the message,
 * or unlocked by the model itself through `more_tools` when a cue was missed.
 * Watchers and the sweep never route; they get an explicit list.
 */
export const TOOL_GROUPS = {
  mail: ['list_email', 'new_mail', 'read_email', 'draft_email', 'send_email', 'cancel_draft'],
  personal_calendar: ['list_calendar', 'create_calendar_event'],
  money: ['list_bank_accounts', 'list_transactions', 'spending_summary', 'new_transactions', 'budget_summary'],
  notion: ['notion_search', 'notion_read_page', 'notion_query_database', 'notion_append_to_page'],
  jira: ['jira_search', 'jira_board_summary', 'jira_read_issue', 'jira_create_issue', 'jira_move_issue', 'jira_comment'],
  automations: ['create_automation', 'list_automations', 'delete_automation', 'pause_automation'],
} as const

export type ToolGroup = keyof typeof TOOL_GROUPS
export const GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[]

const GROUP_HELP: Record<ToolGroup, string> = {
  mail: 'read, search, draft and send email',
  personal_calendar: "a member's own calendar, as opposed to the shared family one",
  money: 'the bank feed, spending and budgets',
  notion: 'Notion pages and databases',
  jira: 'the household board of jobs',
  automations: 'reminders and watchers on a schedule',
}

/** Always in reach: questions, lists, the shared calendar and its proposals, memory, and the way to the rest. */
export const CORE_TOOLS = [
  'web_search', 'read_url', 'weather',
  'recall', 'remember', 'forget',
  'list_family_events', 'add_family_event', 'cancel_family_event', 'family_calendar_link',
  'propose_family_event', 'list_event_proposals', 'accept_event_proposal', 'reject_event_proposal',
  'add_to_list', 'show_list', 'check_off_list', 'remove_from_list', 'clear_list', 'show_lists',
  'more_tools',
] as const

/**
 * Words that make a group likely. Over-matching costs a few extra tool
 * definitions; under-matching costs a more_tools round trip, so these lean
 * generous. An issue key such as HTL-344 counts as a board cue.
 */
const CUES: Record<ToolGroup, RegExp> = {
  mail: /\b(e-?mails?|mail(?:box)?|inbox|gmail|outlook|drafts?|send (?:it|that|this|the)|reply(?:ing)? to|newsletters?|invoice|receipt)\b/i,
  personal_calendar: /\b(my (?:calendar|day|week|schedule|diary)|appointments?|meetings?|calendar|am i (?:free|busy)|free (?:on|at|this|tomorrow)|busy)\b/i,
  money: /\b(spen[dt]|spending|transactions?|bank|2 ?up|budgets?|pocketsmith|paid|payments?|purchases?|bought|costs?|balance|money|refunds?|charge[sd]?|bills?)\b|\$\s?\d/i,
  notion: /\b(notion|reading list|travel plans?|wiki|notes? page)\b/i,
  jira: /\b(jira|board|tasks?|overdue|tickets?|to-?dos?|due|chores?|jobs)\b|\b[A-Z]{2,6}-\d+\b/,
  automations:
    /\b(every (?:day|morning|evening|night|week|month|weekday|hour|\d+ ?(?:min(?:ute)?s?|hours?)|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|daily|weekly|hourly|remind(?:er|ers|ing)?|schedule[ds]?|automations?|watch(?:er|ers|ing)?|stop (?:posting|reminding|watching)|pause|unpause|resume)\b/i,
}

function isGroup(value: unknown): value is ToolGroup {
  return typeof value === 'string' && (GROUP_NAMES as string[]).includes(value)
}

/** The groups a message calls for before the model has said anything. */
export function routeGroups(text: string, opts: { pendingDrafts?: boolean } = {}): ToolGroup[] {
  const groups = new Set<ToolGroup>()
  for (const g of GROUP_NAMES) if (CUES[g].test(text)) groups.add(g)
  // "Send it" needs the mail tools whatever the wording; the draft is the cue.
  if (opts.pendingDrafts) groups.add('mail')
  return [...groups]
}

/** The initial groups plus every group the model has unlocked with more_tools so far. */
export function groupsAfter(
  initial: readonly ToolGroup[],
  steps: ReadonlyArray<{ toolCalls?: ReadonlyArray<{ toolName: string; input: unknown }> }>,
): ToolGroup[] {
  const groups = new Set(initial)
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      if (call.toolName !== 'more_tools') continue
      const group = (call.input as { group?: unknown } | undefined)?.group
      if (isGroup(group)) groups.add(group)
    }
  }
  return [...groups]
}

export function activeToolsFor(groups: Iterable<ToolGroup>): ToolName[] {
  const out = new Set<string>(CORE_TOOLS)
  for (const g of groups) for (const t of TOOL_GROUPS[g]) out.add(t)
  return [...out] as ToolName[]
}

export function routerTools() {
  return {
    more_tools: tool({
      description:
        'Unlock a group of tools that is not in your list right now: ' +
        GROUP_NAMES.map((g) => `${g} (${GROUP_HELP[g]})`).join('; ') +
        '. Call it as soon as a request needs one of these, then use the tools it unlocks in your next step.',
      inputSchema: z.object({
        group: z.enum(GROUP_NAMES as [ToolGroup, ...ToolGroup[]]).describe('The group to unlock'),
      }),
      execute: async ({ group }) => ({ unlocked: group, tools: TOOL_GROUPS[group] }),
    }),
  }
}
