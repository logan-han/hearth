import { recordActivity } from './db/queries'
import { describeError } from './errors'

/**
 * The household's record of what the bot changed. Every write a tool makes
 * that goes through is kept as one line a person can read, with who asked and
 * where, so anyone can look back over what was done instead of taking the
 * bot's word for it: Home lists the latest, and /activity a chat's own.
 */

/** Where a change was asked for: a chat turn, a scheduled run, the nightly pass, a member's MCP client, or a click on Home. */
export type ActivityVia = 'chat' | 'watcher' | 'sweep' | 'mcp' | 'web'

type Fields = Record<string, unknown>

const MAX_SUMMARY = 200

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const quoted = (v: unknown) => `"${text(v).slice(0, 80)}"`
const several = (v: unknown) => (Array.isArray(v) ? v.map(text).filter(Boolean).join(', ') : text(v))
const listName = (v: unknown) => text(v) || 'shopping'

/**
 * How each write reads, from what it was asked and what came back. A tool
 * that posts a line in the chat has already said it in the household's
 * words, and that line is used instead; these cover the rest.
 */
const LINES: Record<string, (input: Fields, result: Fields) => string> = {
  update_family_event: (i, r) => `changed ${quoted(r.title ?? i.title ?? `event ${text(i.id)}`)} on the family calendar`,
  cancel_family_event: (i, r) => `cancelled ${quoted(r.title ?? `event ${text(i.id)}`)} on the family calendar`,
  propose_family_event: (i) => `proposed ${quoted(i.title)} for the family calendar, waiting on a yes`,
  accept_event_proposal: (i, r) => `put ${quoted(r.title ?? `proposal ${text(i.proposal_id)}`)} on the family calendar`,
  reject_event_proposal: (i) => `declined proposal ${text(i.proposal_id)}`,
  add_to_list: (i, r) => `added ${several(r.added ?? i.items)} to the ${text(r.list) || listName(i.list)} list`,
  check_off_list: (i, r) =>
    i.undo ? `put ${several(r.unticked ?? i.items)} back on the ${text(r.list) || listName(i.list)} list` : `ticked off ${several(r.ticked_off ?? i.items)} on the ${text(r.list) || listName(i.list)} list`,
  remove_from_list: (i, r) => `removed ${several(r.removed) || 'items'} from the ${text(r.list) || listName(i.list)} list`,
  clear_list: (i, r) => `cleared ${text(r.cleared) || 'the ticked'} item(s) from the ${text(r.list) || listName(i.list)} list`,
  remember: (i) => `remembered ${quoted(i.fact)}`,
  forget: (i) => `forgot fact ${text(i.id)}`,
  unsure: (i) => `asked the family ${quoted(i.question)}`,
  answer_question: (i, r) => (r.kept ? `kept ${quoted(r.kept)}` : `settled question ${text(i.id)}`),
  draft_email: (i) => `drafted an email to ${several(i.to)}, ${quoted(i.subject)}, waiting on a yes`,
  send_email: (i, r) => `sent the email to ${text(r.to) || `draft ${text(i.draft_id)}`}, ${quoted(r.subject)}`,
  cancel_draft: (i) => `discarded email draft ${text(i.draft_id)}`,
  create_calendar_event: (i) => `added ${quoted(i.title)} to a personal calendar`,
  notion_append_to_page: () => 'added to a Notion page',
  jira_update_issue: (i) => `changed ${text(i.key)} on the board`,
  jira_move_issue: (i) => `moved ${text(i.key)} to ${text(i.status)}`,
  jira_comment: (i) => `commented on ${text(i.key)}`,
  jira_attach_email_file: (i) => `attached ${text(i.filename)} to ${text(i.key)}`,
  create_automation: (i, r) => `set up ${quoted(i.label)}${r.next_run_local ? `, first ${text(r.next_run_local)}` : ''}`,
  delete_automation: (i) => `deleted automation ${text(i.id)}`,
  create_goal: (i, r) => `started the goal ${quoted(r.title ?? i.title)}${Array.isArray(i.steps) && i.steps.length ? ` with ${i.steps.length} steps` : ''}`,
  update_goal: (i, r) => `goal ${quoted(r.title ?? i.id)}: ${several(r.changed) || 'changed'}`,
  create_helper: (i, r) => `added the helper ${text(r.helper) || text(i.name)}`,
  remove_helper: (i, r) => `removed the helper ${text(r.removed) || text(i.name)}`,
  hand_off: (i, r) => `handed ${quoted(i.task)} to ${text(r.handed_to) || text(i.helper)}${r.runs_local ? `, for ${text(r.runs_local)}` : ''}`,
  save_routine: (i, r) => `${r.replaced ? 'changed' : 'kept'} the routine ${quoted(r.routine ?? i.name)}`,
  delete_routine: (i, r) => `forgot the routine ${quoted(r.deleted ?? i.name)}`,
  pause_automation: (i) => `${i.enabled ? 'resumed' : 'paused'} automation ${text(i.id)}`,
}

/** A posted line as plain words: the chat's bold and code marks are for the chat. */
const plain = (line: string) => line.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()

export function describeWrite(tool: string, input: unknown, result: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Fields
  const r = (result && typeof result === 'object' ? result : {}) as Fields
  const said = typeof r.posted === 'string' ? plain(r.posted) : ''
  const line = said || LINES[tool]?.(i, r) || tool.replace(/_/g, ' ')
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line
}

/**
 * Keep one write on record. Best effort: the change has already been made,
 * and a record that cannot be written is no reason to fail the turn that made it.
 */
export async function noteActivity(entry: { chatId: string; memberId: number | null; via: ActivityVia; tool: string; input: unknown; result: unknown }): Promise<void> {
  try {
    await recordActivity({
      chatId: entry.chatId,
      memberId: entry.memberId,
      via: entry.via,
      tool: entry.tool,
      summary: describeWrite(entry.tool, entry.input, entry.result),
    })
  } catch (err) {
    console.warn(`[activity] could not record ${entry.tool}:`, describeError(err))
  }
}
