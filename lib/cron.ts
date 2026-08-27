import { Cron } from 'croner'
import { timezone } from './env'

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
 * in `tz` and return the corresponding UTC instant.
 */
export function localToUtc(local: string, tz: string = timezone()): Date {
  const m = local
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) throw new Error(`Unparseable local datetime: ${local}`)
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
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
