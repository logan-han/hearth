/**
 * The morning brief's DATA, put together in code from what the tick
 * fetched for it.
 */
import { formatLocalDate, localDateKey, localToUtc } from './cron'

export const errorOf = (r: Record<string, unknown>): string | null => (typeof r.error === 'string' ? r.error : null)
/** Optional integrations answer "not configured"; that is a setting, not a fault. */
export const isUnconfigured = (err: string | null) => Boolean(err && /not configured/i.test(err))
/** Nobody having linked a mailbox or calendar yet is a setting too; one that will not answer is a fault. */
export const isUnlinked = (err: string | null) => Boolean(err && /linked a (?:mailbox|calendar)|no (?:email account|calendar) linked/i.test(err))

/**
 * An account as a post names it: by whose it is, under member. The names the
 * tools also give it ("Rowan's Gmail", "Rowan's Google Calendar") are the app
 * as well as the person, and a brief handed them copied them onto every line.
 * An admin's fault message still names the mailbox, from the tool's own result.
 */
const byMember = ({ mailbox: _mailbox, calendar: _calendar, ...acct }: Record<string, unknown>) => acct

/**
 * A sweep's mailboxes as the writer is handed them: by member, and only those
 * that answered. One that failed is reported in code. Left in DATA, its error
 * reads to the writer as a tool that failed, which it answers with PROBLEM and
 * SKIP, so one mailbox timing out would cost the household the whole post.
 */
export const accountsByMember = (r: Record<string, unknown>) =>
  Array.isArray(r.accounts)
    ? { ...r, accounts: (r.accounts as Record<string, unknown>[]).filter((acct) => !errorOf(acct)).map(byMember) }
    : r

/** The local day an event as list_calendar shows it starts on: its date for an all-day one, its instant's day for a timed one. */
function startDay(e: Record<string, unknown>): string | null {
  const start = typeof e.start === 'string' ? e.start : ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start
  const at = new Date(start)
  return start && !Number.isNaN(at.getTime()) ? localDateKey(at) : null
}

/**
 * The calendars read for the look-ahead in one look, split by when each event
 * starts: an account's events that began by `day` are today's, whatever began
 * earlier and runs on included; those that start on `next` are its tomorrow;
 * and the rest of the fortnight is coming. An account that answered with an
 * error is in none of them, as a mailbox that did is left out of the mail;
 * `accounts` keeps it, for the run to report.
 */
function splitCalendars(r: Record<string, unknown>, day: string, next: string) {
  const accounts = Array.isArray(r.accounts) ? (r.accounts as Record<string, unknown>[]) : []
  const today: Record<string, unknown>[] = []
  const tomorrow: Record<string, unknown>[] = []
  const coming: Record<string, unknown>[] = []
  let onToday = 0
  let comingCount = 0
  for (const acct of accounts) {
    if (!Array.isArray(acct.events)) continue
    const events = acct.events as Record<string, unknown>[]
    // An event with no readable start counts as today, as it always has.
    const startsOn = (e: Record<string, unknown>) => startDay(e) ?? day
    const on = events.filter((e) => startsOn(e) <= day)
    const starting = events.filter((e) => startsOn(e) === next)
    const later = events.filter((e) => startsOn(e) > next)
    onToday += on.length
    comingCount += later.length
    today.push({ ...acct, events: on })
    if (starting.length) tomorrow.push({ ...acct, events: starting })
    if (later.length) coming.push({ ...acct, events: later })
  }
  return { accounts, today, tomorrow, coming, onToday, comingCount }
}

export type Reminder = { label: string; at: string; date: string }

export type Fetched = {
  data: Record<string, unknown>
  empty: boolean
  problems: string[]
  /** Questions the nightly pass left for the family, put to them by this run. */
  asked?: number[]
}

/**
 * The brief from what the tick fetched: what failed goes to problems and is
 * left out, and a day with nothing to tell comes back empty.
 */
export function assembleBrief(input: {
  day: string
  next: string
  horizon: string
  events: Record<string, unknown>
  tomorrowEvents: Record<string, unknown>
  comingEvents: Record<string, unknown>
  calendars: Record<string, unknown>
  mail: Record<string, unknown>
  board: Record<string, unknown>
  weather: Record<string, unknown>
  proposals: Record<string, unknown>
  questions: readonly { id: number; question: string }[]
  reminders: readonly Reminder[]
}): Fetched {
  const { day, next, horizon, events, tomorrowEvents, comingEvents, calendars, mail, board, weather, proposals, questions, reminders } = input
  const problems: string[] = []
  const eventsErr = errorOf(events)
  if (eventsErr) problems.push(`list_family_events: ${eventsErr}`)
  const tomorrowErr = errorOf(tomorrowEvents)
  if (tomorrowErr && tomorrowErr !== eventsErr) problems.push(`list_family_events (tomorrow): ${tomorrowErr}`)
  const comingErr = errorOf(comingEvents)
  if (comingErr && comingErr !== eventsErr && comingErr !== tomorrowErr) problems.push(`list_family_events (coming): ${comingErr}`)
  const calendarsErr = errorOf(calendars)
  if (calendarsErr && !isUnlinked(calendarsErr)) problems.push(`list_calendar: ${calendarsErr}`)
  const days = splitCalendars(calendars, day, next)
  for (const acct of days.accounts) {
    const e = errorOf(acct)
    if (e) problems.push(`list_calendar (${String(acct.calendar ?? acct.provider)}): ${e}`)
  }
  const mailErr = errorOf(mail)
  if (mailErr && !isUnlinked(mailErr)) problems.push(`new_mail: ${mailErr}`)
  const accounts = Array.isArray(mail.accounts) ? (mail.accounts as Record<string, unknown>[]) : []
  let arrived = 0
  for (const acct of accounts) {
    const e = errorOf(acct)
    if (e) problems.push(`new_mail (${String(acct.mailbox)}): ${e}`)
    if (Array.isArray(acct.messages)) arrived += acct.messages.length
  }
  for (const [name, r] of [['jira_board_summary', board], ['weather', weather]] as const) {
    const e = errorOf(r)
    if (e && !isUnconfigured(e)) problems.push(`${name}: ${e}`)
  }
  const todays = Array.isArray(events.events) ? (events.events as Record<string, unknown>[]) : []
  // Tomorrow is what starts then: a camp on both days is already under today.
  const onToday = new Set(todays.map((e) => e.id))
  const tomorrowAll = Array.isArray(tomorrowEvents.events) ? (tomorrowEvents.events as Record<string, unknown>[]) : []
  const startsTomorrow = tomorrowAll.filter((e) => !onToday.has(e.id))
  // Listed once, under the first day it is on: a camp already under today or tomorrow is not repeated under coming.
  const listed = new Set([...onToday, ...tomorrowAll.map((e) => e.id)])
  const comingFamily = (Array.isArray(comingEvents.events) ? (comingEvents.events as Record<string, unknown>[]) : []).filter(
    (e) => !listed.has(e.id),
  )
  const overdue = Array.isArray(board.overdue) ? board.overdue : []
  const dueToday = Array.isArray(board.due_today) ? board.due_today : []
  const waiting = Array.isArray(proposals.proposals) ? proposals.proposals : []
  // The board's next due dates, soonest first, kept to the fortnight from tomorrow on.
  const dueNext = Array.isArray(board.due_next) ? (board.due_next as { due?: string }[]) : []
  const dueSoon = dueNext.filter((i) => i.due !== undefined && i.due >= next && i.due <= horizon)
  const todaysReminders = reminders.filter((r) => r.date === day).map(({ label, at }) => ({ label, at }))
  const laterReminders = reminders.filter((r) => r.date !== day).map(({ label, at }) => ({ label, at }))
  // Coming is a reason to post, as a due date is; a reminder speaks for itself when it goes off, so on its own it only rides along.
  const ahead = comingFamily.length + days.comingCount + dueSoon.length
  // What failed is reported above and left out, so the rest of the brief still goes.
  const data: Record<string, unknown> = eventsErr ? {} : { events }
  if (!calendarsErr) data.calendars = { ...calendars, accounts: days.today.map(byMember) }
  if (startsTomorrow.length || days.tomorrow.length) {
    data.tomorrow = {
      date: formatLocalDate(localToUtc(next)),
      ...(startsTomorrow.length ? { events: startsTomorrow } : {}),
      ...(days.tomorrow.length ? { calendars: days.tomorrow.map(byMember) } : {}),
    }
  }
  if (!mailErr) data.mail = accountsByMember(mail)
  // The board's due dates within the fortnight are under coming, so its own list of next dues is left out here.
  if (!errorOf(board)) data.board = { ...board, due_next: undefined }
  if (todaysReminders.length) data.reminders = todaysReminders
  if (ahead || laterReminders.length) {
    data.coming = {
      through: formatLocalDate(localToUtc(horizon)),
      ...(comingFamily.length ? { events: comingFamily } : {}),
      ...(days.coming.length ? { calendars: days.coming.map(byMember) } : {}),
      ...(dueSoon.length ? { board: dueSoon } : {}),
      ...(laterReminders.length ? { reminders: laterReminders } : {}),
    }
  }
  if (waiting.length) data.proposals = waiting
  if (!errorOf(weather)) data.weather = weather
  if (questions.length) data.questions = questions.map((qn) => ({ id: qn.id, question: qn.question }))
  // A day with nothing on anyone's calendar, nothing coming up in the
  // fortnight, no new mail, nothing due and nothing to ask gets no brief.
  // The weather, tomorrow, a reminder that will speak for itself and a
  // proposal Home already lists are context for a brief, not news to wake
  // the household for.
  return {
    data,
    empty:
      todays.length === 0 &&
      days.onToday === 0 &&
      arrived === 0 &&
      overdue.length === 0 &&
      dueToday.length === 0 &&
      questions.length === 0 &&
      ahead === 0,
    problems,
    asked: questions.map((qn) => qn.id),
  }
}
