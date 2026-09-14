import { Cron } from 'croner'
import { formatLocal, isValidCron, timezone, tzOffsetMs } from './cron'
import { getSetting } from './db/queries'

/**
 * What the app knows about when its scheduler actually runs.
 *
 * The scheduler is QStash calling /api/tick on a cron of its own, and an
 * automation fires at the first tick on or after its time. A schedule that
 * does not land on a tick therefore runs late, and one finer than the ticks
 * runs at the ticks' pace. Nothing here is configured: the tick route keeps
 * the last two QStash calls, and their gap and timing are the grid every
 * schedule is judged against, so the app follows whatever QStash is set to.
 * Hourly is the expected shape, since on Neon's free plan each tick keeps the
 * database awake for five minutes and a five-minute schedule never lets it
 * sleep.
 */

/** Ticks land at `anchor` and every `everyMinutes` before and after it. */
export type TickGrid = { everyMinutes: number; anchor: Date }

const MINUTE = 60_000
const floorMinute = (d: Date) => Math.floor(d.getTime() / MINUTE)
const pad = (n: number) => String(n).padStart(2, '0')

/** The grid the last two ticks imply, or null before there are two. */
export function tickCadence(lastTickAt: string | null, prevTickAt: string | null): TickGrid | null {
  if (!lastTickAt || !prevTickAt) return null
  const last = new Date(lastTickAt)
  const gap = Math.round((last.getTime() - new Date(prevTickAt).getTime()) / MINUTE)
  if (!Number.isFinite(gap) || gap < 1) return null
  return { everyMinutes: gap, anchor: last }
}

/** The grid as the tick route has recorded it. */
export async function tickGrid(): Promise<TickGrid | null> {
  const [last, prev] = await Promise.all([getSetting('last_tick_at'), getSetting('prev_tick_at')])
  return tickCadence(last, prev)
}

/** Minutes from the tick before `at` (or on it) to `at`. */
function pastTick(grid: TickGrid, at: Date): number {
  const every = grid.everyMinutes
  return (((floorMinute(at) - floorMinute(grid.anchor)) % every) + every) % every
}

/** Whether a tick lands in the minute of `at`. */
export function onGrid(grid: TickGrid, at: Date): boolean {
  return pastTick(grid, at) === 0
}

/** The first tick on or after `at`. */
export function nextTickOnOrAfter(grid: TickGrid, at: Date): Date {
  const past = pastTick(grid, at)
  return new Date((floorMinute(at) + (past === 0 ? 0 : grid.everyMinutes - past)) * MINUTE)
}

export type GridFit = { fits: true } | { fits: false; due: Date; runs: Date }

/**
 * Whether a cron's coming fires all land on ticks. The next few are checked;
 * a schedule that misses is reported from its first miss, with the tick it
 * would really run at.
 */
export function fitsGrid(grid: TickGrid, cronExpr: string, from: Date = new Date(), tz: string = timezone(), samples = 8): GridFit {
  const job = new Cron(cronExpr, { timezone: tz, paused: true })
  const fires = job.nextRuns(samples, from)
  job.stop()
  for (const due of fires) {
    if (!onGrid(grid, due)) return { fits: false, due, runs: nextTickOnOrAfter(grid, due) }
  }
  return { fits: true }
}

/**
 * The minutes past the hour, in the household's clock, on which ticks land.
 * Null when the grid does not repeat within an hour, or does not divide it.
 */
function gridMinutes(grid: TickGrid, tz: string): number[] | null {
  const every = grid.everyMinutes
  if (every > 60 || 60 % every !== 0) return null
  const local = Math.floor((grid.anchor.getTime() + tzOffsetMs(grid.anchor, tz)) / MINUTE) % 60
  const out: number[] = []
  for (let m = local % every; m < 60; m += every) out.push(m)
  return out
}

/** The grid in words, for the tool's refusal and the pages. */
export function describeGrid(grid: TickGrid, tz: string = timezone()): string {
  const minutes = gridMinutes(grid, tz)
  const every = grid.everyMinutes
  if (minutes && every === 60) return minutes[0] === 0 ? 'hourly, on the hour' : `hourly, at ${pad(minutes[0])} past`
  if (minutes) return `every ${every} minutes, at ${minutes.map((m) => `:${pad(m)}`).join(', ')}`
  return `every ${every} minutes, last at ${formatLocal(grid.anchor, tz)}`
}

/**
 * The nearest cron to `cronExpr` that lands on the grid, or null when there is
 * no simple one. A plain minute is moved up to the next tick minute (rolling
 * the hour when that is safe), or failing that down; anything finer or fancier
 * in the minute field becomes the tick minutes themselves.
 */
export function suggestAligned(grid: TickGrid, cronExpr: string, from: Date = new Date(), tz: string = timezone()): string | null {
  const minutes = gridMinutes(grid, tz)
  if (!minutes) return null
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dom, month, dow] = fields
  const withMinute = (m: number | string, h: string = hour) => [m, h, dom, month, dow].join(' ')

  const candidates: string[] = []
  if (/^\d+$/.test(minute)) {
    const m = Number(minute)
    const up = minutes.find((g) => g >= m)
    if (up !== undefined) candidates.push(withMinute(up))
    // Past the last tick minute of the hour: the next hour, when no day field
    // would silently move the reminder to another day.
    else if (/^\d+$/.test(hour) && dom === '*' && dow === '*') candidates.push(withMinute(minutes[0], String((Number(hour) + 1) % 24)))
    const down = [...minutes].reverse().find((g) => g <= m)
    if (down !== undefined) candidates.push(withMinute(down))
  } else {
    candidates.push(withMinute(minutes.join(',')))
  }
  return candidates.find((c) => c !== cronExpr && isValidCron(c, tz) && fitsGrid(grid, c, from, tz).fits) ?? null
}

/**
 * Three missed ticks is a scheduler that has stopped, at whatever cadence it
 * runs. Until a second tick has landed, five minutes is assumed; two ticks
 * close together (a manual one beside the schedule) must not make the
 * judgement hair-trigger, so the cadence is never taken as under five.
 */
const ASSUMED_TICK_MINUTES = 5
const MISSED_TICKS = 3

export type SchedulerPulse = {
  lastTick: string | null
  minutesAgo: number | null
  /** The observed cadence, once two ticks have been seen. */
  everyMinutes: number | null
  stale: boolean
}

export function schedulerPulse(lastTickAt: string | null, prevTickAt: string | null, now: Date): SchedulerPulse {
  if (!lastTickAt) return { lastTick: null, minutesAgo: null, everyMinutes: null, stale: true }
  const at = new Date(lastTickAt)
  const minutesAgo = Math.max(0, Math.round((now.getTime() - at.getTime()) / MINUTE))
  const cadence = tickCadence(lastTickAt, prevTickAt)
  const everyMinutes = cadence ? Math.max(ASSUMED_TICK_MINUTES, cadence.everyMinutes) : null
  return {
    lastTick: formatLocal(at),
    minutesAgo,
    everyMinutes,
    stale: minutesAgo > MISSED_TICKS * (everyMinutes ?? ASSUMED_TICK_MINUTES),
  }
}
