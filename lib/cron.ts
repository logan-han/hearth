import { Cron } from 'croner'
import { timezone } from './env'

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export { timezone }

/**
 * Next fire time for a 5-field cron expression, evaluated in `tz`
 * (Australia/Melbourne by default, so DST shifts are handled for us).
 * Returns null when the expression never fires again.
 */
export function nextRun(cronExpr: string, from: Date = new Date(), tz: string = timezone()): Date | null {
  const job = new Cron(cronExpr, { timezone: tz, paused: true })
  const next = job.nextRun(from)
  job.stop()
  return next ?? null
}

/** True when the expression parses as a cron croner accepts. */
export function isValidCron(cronExpr: string, tz: string = timezone()): boolean {
  try {
    const job = new Cron(cronExpr, { timezone: tz, paused: true })
    const ok = job.nextRun() !== null
    job.stop()
    return ok
  } catch {
    return false
  }
}

/** Human-ish rendering of a date in the family timezone, for prompts and replies. */
export function formatLocal(d: Date, tz: string = timezone()): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

/** The date after a YYYY-MM-DD date, by the calendar rather than by adding 24 hours across a clock change. */
export function dayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

/**
 * The end of a range someone gave as local time. A date alone means the whole
 * of that day, so it ends at the next local midnight: 'to 27 September'
 * includes Sunday's soccer. A time is taken as given.
 */
export function rangeEnd(to: string, tz: string = timezone()): Date {
  const t = to.trim()
  return DATE_ONLY.test(t) ? localToUtc(dayAfter(t), tz) : localToUtc(t, tz)
}

/** The local midnight after `d`'s local day: the exclusive end of an all-day event that starts then. */
export function nextLocalMidnight(d: Date, tz: string = timezone()): Date {
  return localToUtc(dayAfter(localDateKey(d, tz)), tz)
}

/** The last local day an all-day span covers, its end being the midnight after that day. */
export function lastDay(startsAt: Date, endsAt: Date, tz: string = timezone()): string {
  return localDateKey(new Date(Math.max(startsAt.getTime(), endsAt.getTime() - 1)), tz)
}

/**
 * Read a start and optional end the way the model gives them, for every tool
 * that makes an event. A date with no time IS an all-day event: the model
 * omitted the time because it does not know one, and midnight would be an
 * invention. An all-day end is the last day the event covers, as people say
 * it: "the 9th to the 11th" includes the 11th, and an end on the start day is
 * that one day. It is stored as the local midnight after that day, by the
 * calendar: the day the clocks go back is 25 hours long, and 24 would end it
 * where it began.
 */
export function resolveSpan(input: { start: string; end?: string; allDay: boolean }): {
  startsAt: Date
  endsAt: Date
  allDay: boolean
} {
  const start = input.start.trim()
  if (input.allDay || DATE_ONLY.test(start)) {
    const first = start.slice(0, 10)
    const until = input.end?.trim().slice(0, 10)
    return { startsAt: localToUtc(first), endsAt: localToUtc(dayAfter(until && until > first ? until : first)), allDay: true }
  }
  const startsAt = localToUtc(start)
  const endsAt = input.end ? localToUtc(input.end) : new Date(startsAt.getTime() + 60 * 60 * 1000)
  return { startsAt, endsAt, allDay: false }
}

/** ISO-8601 date (YYYY-MM-DD) for `d` as seen in `tz`. */
export function localDateKey(d: Date, tz: string = timezone()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/**
 * Interpret a wall-clock local string ("2026-09-01T09:00" or "2026-09-01 09:00")
 * in `tz` and return the corresponding UTC instant. A time that carries its
 * own Z or offset, as a provider's raw start does when the model copies one
 * across, is that instant instead. Anything else after the time is refused
 * rather than ignored: an ignored offset moves the time by that much.
 */
export function localToUtc(local: string, tz: string = timezone()): Date {
  const m = local
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i)
  if (!m) throw new Error(`Unparseable local datetime: ${local}`)
  const [, y, mo, d, h = '0', mi = '0', s = '0', zone] = m
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  if (zone) {
    // Z is UTC itself; +11:00 is eleven hours ahead of it.
    const o = zone.match(/^([+-])(\d{2}):?(\d{2})$/)
    const ahead = o ? (o[1] === '-' ? -1 : 1) * (+o[2] * 60 + +o[3]) * 60_000 : 0
    return new Date(asUtc - ahead)
  }
  // Offset is itself a function of the instant, so resolve it twice for DST edges.
  let guess = asUtc - tzOffsetMs(new Date(asUtc), tz)
  guess = asUtc - tzOffsetMs(new Date(guess), tz)
  return new Date(guess)
}

/** Milliseconds that `tz` is ahead of UTC at instant `at`. */
export function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = Object.fromEntries(
    dtf.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<string, string>
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  )
  return asUtc - at.getTime()
}

/** A date with no time, for all-day events where "12:00 am" is noise. */
export function formatLocalDate(d: Date, tz: string = timezone()): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  }).format(d)
}
