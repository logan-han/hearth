import { tool } from 'ai'
import { z } from 'zod'
import type { ToolName } from './index'

/**
 * Which tools a chat turn sees. A small model picks the right tool far more
 * often from two dozen than from all of them at once, so the everyday set is
 * always in reach and the rest sit behind groups: switched on by cues in the
 * message, or unlocked by the model itself through `more_tools` when a cue
 * was missed. Watchers and the sweep never route; they get an explicit list.
 */
export const TOOL_GROUPS = {
  mail: ['list_email', 'new_mail', 'read_email', 'read_attachment', 'draft_email', 'send_email', 'cancel_draft'],
  personal_calendar: ['list_calendar', 'find_free_time', 'create_calendar_event'],
  money: ['list_bank_accounts', 'list_transactions', 'spending_summary', 'budget_summary', 'recurring_payments'],
  notion: ['notion_search', 'notion_read_page', 'notion_query_database', 'notion_append_to_page'],
  jira: ['jira_search', 'jira_board_summary', 'jira_read_issue', 'jira_create_issue', 'jira_update_issue', 'jira_move_issue', 'jira_comment', 'jira_attach_email_file'],
  automations: ['create_automation', 'list_automations', 'delete_automation', 'pause_automation', 'recent_activity'],
  goals: ['create_goal', 'list_goals', 'goal_status', 'update_goal'],
  helpers: ['create_helper', 'list_helpers', 'remove_helper', 'hand_off'],
  routines: ['save_routine', 'run_routine', 'list_routines', 'delete_routine'],
  kitchen: ['read_recipe'],
} as const

export type ToolGroup = keyof typeof TOOL_GROUPS
export const GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[]

const GROUP_HELP: Record<ToolGroup, string> = {
  mail: 'read, search, draft and send email',
  personal_calendar: "a member's own calendar, as opposed to the shared family one, and finding a time when people are free",
  money: 'transactions, spending, budgets, and subscriptions and bills paid regularly, from PocketSmith',
  notion: 'Notion pages and databases',
  jira: 'the household board of jobs',
  automations: 'reminders, watchers and jobs for later, and a record of what has been changed',
  goals: 'goals worked towards over weeks, each with a plan of steps and a weekly check-in',
  helpers: 'named helpers the family talks to, and handing a job to one to do in the background',
  routines: 'routines kept once and run again by name',
  kitchen: 'reading a recipe from a link, for the shopping list or a meal plan',
}

/** Always in reach: questions, lists, the shared calendar and its proposals, memory, and the way to the rest. */
export const CORE_TOOLS = [
  'web_search', 'read_url', 'weather',
  'recall', 'remember', 'forget', 'answer_question',
  'list_family_events', 'add_family_event', 'update_family_event', 'cancel_family_event', 'family_calendar_link',
  'propose_family_event', 'list_event_proposals', 'accept_event_proposal', 'reject_event_proposal',
  'add_to_list', 'show_list', 'check_off_list', 'remove_from_list', 'clear_list', 'show_lists',
  'more_tools',
] as const

/**
 * Offered only when the situation carries what they act on: a calendar file
 * attached to this very message, or the nightly pass, which alone is handed
 * `unsure`. Listed so every tool is accounted for, even though no cue or
 * group ever switches these on.
 */
export const SITUATIONAL_TOOLS = ['import_calendar_file', 'unsure'] as const

/**
 * Words that make a group likely. Over-matching costs a few extra tool
 * definitions; under-matching costs a more_tools round trip, so these lean
 * generous, and they ignore case: "Jira" or "Tasks" opening a sentence is
 * the common way to say it.
 */
const CUES: Record<ToolGroup, RegExp> = {
  mail: /\b(e-?mails?|mail(?:box)?|inbox|gmail|outlook|drafts?|send (?:it|that|this|the)|reply(?:ing)? to|newsletters?|invoice|receipt|attach(?:ed|ment|ments)|pdf)\b/i,
  personal_calendar: /\b(my (?:calendar|day|week|schedule|diary)|appointments?|meetings?|calendar|am i (?:free|busy)|free (?:on|at|this|tomorrow)|busy|a time (?:that|when)|when (?:are|is) (?:we|everyone|\w+) free|find (?:a )?time|book (?:in|a time)|suits everyone)\b/i,
  money: /\b(spen[dt]|spending|transactions?|bank|2 ?up|budgets?|pocketsmith|paid|payments?|purchases?|bought|costs?|balance|money|refunds?|charge[sd]?|bills?|subscri(?:be[ds]?|ptions?)|recurring|direct debits?|went up|price rise|cancel (?:it|that|the))\b|\$\s?\d/i,
  notion: /\b(notion|reading list|travel plans?|wiki|notes? page)\b/i,
  jira: /\b(jira|board|tasks?|overdue|tickets?|to-?dos?|due|chores?|jobs)\b/i,
  goals: /\b(goals?|aim(?:ing)? (?:to|for)|targets?|sav(?:e|ing) (?:up )?for|milestones?|progress|check[- ]?ins?|resolutions?|plan(?:s|ning)? (?:for|to))\b/i,
  helpers: /\b(helpers?|hand (?:it |this |that )?(?:off|over) to|handoff|delegate|chef|treasurer|planner|researcher|coach)\b/i,
  kitchen: /\b(recipes?|ingredients?|cook(?:ing)?|bak(?:e|ing)|dinners?|meals?|menus?|lunch(?:es|box)?|what (?:can|should) (?:i|we) (?:make|cook|have))\b/i,
  routines: /\b(routines?|the usual|same as (?:last time|usual|always)|like (?:last time|always)|every time we|keep (?:that|this|it) as)\b/i,
  automations:
    /\b(every (?:day|morning|evening|night|week|month|weekday|hour|\d+ ?(?:min(?:ute)?s?|hours?)|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|daily|weekly|hourly|remind(?:er|ers|ing)?|schedule[ds]?|automations?|watch(?:er|ers|ing)?|stop (?:posting|reminding|watching)|pause|unpause|resume|let (?:me|us) know when|tell (?:me|us) when|keep an eye|later today|tonight|tomorrow at|what (?:have|did) you (?:do|done|change|changed)|activity)\b/i,
}

/**
 * An issue key such as HTL-344 counts as a board cue. It is matched apart
 * from the words because it alone must keep its case: in lower case it would
 * take "covid-19" for a ticket.
 */
const ISSUE_KEY = /\b[A-Z]{2,6}-\d+\b/

/** Whether a name stands in the text as a word of its own, in any case. */
function mentions(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return Boolean(escaped) && new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text)
}

function isGroup(value: unknown): value is ToolGroup {
  return typeof value === 'string' && (GROUP_NAMES as string[]).includes(value)
}

/** The groups a message calls for before the model has said anything. */
export function routeGroups(
  text: string,
  opts: { pendingDrafts?: boolean; activeGoals?: boolean; helperNames?: readonly string[]; routineNames?: readonly string[] } = {},
): ToolGroup[] {
  const groups = new Set<ToolGroup>()
  for (const g of GROUP_NAMES) if (CUES[g].test(text)) groups.add(g)
  // "Ask Chef to plan dinners" names a helper the family made up, which no fixed cue can know;
  // "do the Sunday reset" names a routine the same way.
  if (opts.helperNames?.some((name) => mentions(text, name))) groups.add('helpers')
  if (opts.routineNames?.some((name) => mentions(text, name))) groups.add('routines')
  if (ISSUE_KEY.test(text)) groups.add('jira')
  // "Send it" needs the mail tools whatever the wording; the draft is the cue.
  if (opts.pendingDrafts) groups.add('mail')
  // "We booked the venue" is progress on a goal in context, however it is said.
  if (opts.activeGoals) groups.add('goals')
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
