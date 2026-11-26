/**
 * The morning brief and the money snapshot, gathered in code as on-demand
 * reads and handed to the member's MCP client to give in its own words.
 */
import { formatLocalDate, localDateKey, localToUtc, dayAfter, daysAfter, formatLocal, formatLocalTime } from './cron'
import { listAutomations, unaskedQuestions, markQuestionsAsked } from './db/queries'
import type { ToolContext } from './tools/context'

export const errorOf = (r: Record<string, unknown>): string | null => (typeof r.error === 'string' ? r.error : null)
/** Optional integrations answer "not configured"; that is a setting, not a fault. */
export const isUnconfigured = (err: string | null) => Boolean(err && /not configured/i.test(err))
/** Nobody having linked a calendar yet is a setting too; one that will not answer is a fault. */
export const isUnlinked = (err: string | null) => Boolean(err && /no calendar linked/i.test(err))

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
 * error is in none of them; `accounts` keeps it, for the run to report.
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
  /** Questions still open for the family, put to them by this brief. */
  asked?: number[]
}

/**
 * The brief from what was fetched: what failed goes to problems and is left
 * out, and a day with nothing to tell comes back empty.
 */
export function assembleBrief(input: {
  day: string
  next: string
  horizon: string
  events: Record<string, unknown>
  tomorrowEvents: Record<string, unknown>
  comingEvents: Record<string, unknown>
  calendars: Record<string, unknown>
  board: Record<string, unknown>
  weather: Record<string, unknown>
  proposals: Record<string, unknown>
  questions: readonly { id: number; question: string }[]
  reminders: readonly Reminder[]
}): Fetched {
  const { day, next, horizon, events, tomorrowEvents, comingEvents, calendars, board, weather, proposals, questions, reminders } = input
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
  // Coming is news, as a due date is; a reminder speaks for itself when it goes off, so on its own it only rides along.
  const ahead = comingFamily.length + days.comingCount + dueSoon.length
  // What failed is reported above and left out, so the rest of the brief still goes.
  const data: Record<string, unknown> = eventsErr ? {} : { events }
  if (!calendarsErr) data.calendars = { ...calendars, accounts: days.today }
  if (startsTomorrow.length || days.tomorrow.length) {
    data.tomorrow = {
      date: formatLocalDate(localToUtc(next)),
      ...(startsTomorrow.length ? { events: startsTomorrow } : {}),
      ...(days.tomorrow.length ? { calendars: days.tomorrow } : {}),
    }
  }
  // The board's due dates within the fortnight are under coming, so its own list of next dues is left out here.
  if (!errorOf(board)) data.board = { ...board, due_next: undefined }
  if (todaysReminders.length) data.reminders = todaysReminders
  if (ahead || laterReminders.length) {
    data.coming = {
      through: formatLocalDate(localToUtc(horizon)),
      ...(comingFamily.length ? { events: comingFamily } : {}),
      ...(days.coming.length ? { calendars: days.coming } : {}),
      ...(dueSoon.length ? { board: dueSoon } : {}),
      ...(laterReminders.length ? { reminders: laterReminders } : {}),
    }
  }
  if (waiting.length) data.proposals = waiting
  if (!errorOf(weather)) data.weather = weather
  if (questions.length) data.questions = questions.map((qn) => ({ id: qn.id, question: qn.question }))
  // A day with nothing on any calendar, nothing coming up in the fortnight,
  // nothing due and nothing to ask is a quiet one, and says so.
  // The weather, tomorrow, a reminder and a proposal Home already lists are
  // context for a brief, not news.
  return {
    data,
    empty:
      todays.length === 0 &&
      days.onToday === 0 &&
      overdue.length === 0 &&
      dueToday.length === 0 &&
      questions.length === 0 &&
      ahead === 0,
    problems,
    asked: questions.map((qn) => qn.id),
  }
}

/**
 * How far past today the brief looks, in days: to the end of the fortnight,
 * today included, so next Monday and this Friday are in view on any day of
 * the week.
 */
export const LOOK_AHEAD_DAYS = 13

/**
 * The reminders a member has set that go off from now to `last`, for the
 * brief to mention: today's by time, the rest of the fortnight's by day and
 * time as well. A watch that runs until it finds something is a check, not a
 * reminder: hourly, it would be in every brief at its next hour, saying nothing.
 */
export async function remindersBetween(memberId: number, now: Date, last: string): Promise<Reminder[]> {
  const day = localDateKey(now)
  return (await listAutomations(memberId))
    .filter((r) => r.enabled && r.repeat !== 'until' && r.nextRunAt > now && localDateKey(r.nextRunAt) <= last)
    .map((r) => {
      const date = localDateKey(r.nextRunAt)
      return { label: r.label, at: date === day ? formatLocalTime(r.nextRunAt) : formatLocal(r.nextRunAt), date }
    })
}

type Run = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>

/**
 * Today at a glance for one member: the family calendar and their own, what
 * starts tomorrow and what is coming over the fortnight, the board, their
 * reminders, the proposals waiting on a yes, the weather, and the questions
 * still open. The questions it carries count as asked, so Home holds them from
 * then on.
 */
export async function gatherBrief(ctx: ToolContext, run: Run): Promise<Fetched> {
  const day = localDateKey(ctx.now)
  const next = dayAfter(day)
  const after = dayAfter(next)
  const horizon = daysAfter(day, LOOK_AHEAD_DAYS)
  const memberId = ctx.member?.id
  const [events, tomorrowEvents, comingEvents, calendars, board, weather, questions, proposals, reminders] = await Promise.all([
    // The whole day, and anything on during it: day three of a camp is news too.
    run('list_family_events', { from: day, to: day, include_cancelled: false }),
    run('list_family_events', { from: next, to: next, include_cancelled: false }),
    // The rest of the fortnight, so next Monday and this Friday are in view from any day of the week.
    run('list_family_events', { from: after, to: horizon, include_cancelled: false }),
    // Today to the end of the fortnight in one look, split by day in assembleBrief.
    run('list_calendar', { from: day, to: horizon }),
    run('jira_board_summary', {}),
    run('weather', {}),
    unaskedQuestions().catch(() => []),
    // Context for the brief, never the reason for one: a lookup that fails leaves it out.
    run('list_event_proposals', {}).catch((): Record<string, unknown> => ({})),
    memberId ? remindersBetween(memberId, ctx.now, horizon).catch((): Reminder[] => []) : Promise.resolve([] as Reminder[]),
  ])
  const brief = assembleBrief({ day, next, horizon, events, tomorrowEvents, comingEvents, calendars, board, weather, questions, proposals, reminders })
  if (brief.asked?.length) await markQuestionsAsked(brief.asked)
  return brief
}

/**
 * The week's and the month's money: the past seven days and the month so far
 * from PocketSmith, with the month's budget. A week in which no money moved
 * comes back empty.
 */
export async function gatherSnapshot(ctx: ToolContext, run: Run): Promise<Fetched> {
  const today = localDateKey(ctx.now)
  const weekStart = localDateKey(new Date(ctx.now.getTime() - 6 * 86_400_000))
  const [week, month, budget] = await Promise.all([
    run('spending_summary', { from: weekStart, to: today }),
    run('spending_summary', {}),
    run('budget_summary', {}),
  ])
  const problems: string[] = []
  for (const [name, r] of [['spending_summary (week)', week], ['spending_summary (month)', month], ['budget_summary', budget]] as const) {
    const e = errorOf(r)
    if (e && !isUnconfigured(e)) problems.push(`${name}: ${e}`)
  }
  const data: Record<string, unknown> = { week: `${weekStart} to ${today}` }
  if (!errorOf(week)) data.this_week = week
  if (!errorOf(month)) data.month_so_far = month
  if (!errorOf(budget)) data.budget = budget
  // No bank connected is a setting, not a fault, and a week in which no
  // money moved has nothing to say either.
  const moved = Number(week.transactions ?? 0) + Number(month.transactions ?? 0)
  return { data, empty: moved === 0, problems }
}
