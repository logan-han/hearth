/**
 * Subscriptions and bills found in the bank feed: a payee paid again and
 * again at a steady interval. Worked out here rather than by a model, which
 * reads a list of transactions as a story and finds a pattern in two
 * coincidences; this wants three payments (two for a quarterly or yearly
 * one) a steady distance apart before it calls anything recurring.
 */

export type Payment = { date: string; payee: string; amount: number }

export type Cadence = 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'yearly'

export type Recurring = {
  payee: string
  cadence: Cadence
  /** Payments seen in the window, oldest first. */
  count: number
  first: string
  last: string
  lastAmount: number
  /** The middle amount paid, what it usually costs. */
  typical: number
  /** The amount before the last, when the last differed from it by more than a rounding. */
  previousAmount?: number
  /** When the next one is due by its own rhythm, YYYY-MM-DD. */
  next: string
  /** What it comes to in an average month. */
  monthly: number
  /** The next one is overdue by more than half an interval: cancelled, moved, or late. */
  overdue: boolean
  /** The day it counts as overdue from: half an interval after it was due, YYYY-MM-DD. */
  overdueSince: string
  /** Seen just often enough to count: this is the first look that finds it. */
  fresh: boolean
}

/** Each cadence: the days between payments it allows, and how many a month it makes. */
const CADENCES: { cadence: Cadence; min: number; max: number; days: number; perMonth: number; least: number }[] = [
  { cadence: 'weekly', min: 6, max: 8, days: 7, perMonth: 52 / 12, least: 3 },
  { cadence: 'fortnightly', min: 13, max: 15, days: 14, perMonth: 26 / 12, least: 3 },
  { cadence: 'monthly', min: 26, max: 34, days: 30, perMonth: 1, least: 3 },
  { cadence: 'quarterly', min: 85, max: 97, days: 91, perMonth: 1 / 3, least: 2 },
  { cadence: 'yearly', min: 350, max: 380, days: 365, perMonth: 1 / 12, least: 2 },
]

const DAY_MS = 86_400_000
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const cents = (n: number) => Math.round(n * 100) / 100

/**
 * A payee as the same business however the feed spells it on the day:
 * case, punctuation, a card or reference number and a trailing location
 * code all come and go.
 */
export function payeeKey(payee: string): string {
  return payee
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 3)
    .join(' ')
}

/** What is paid on a rhythm, largest monthly cost first. `today` is YYYY-MM-DD. */
export function findRecurring(payments: readonly Payment[], today: string): Recurring[] {
  const byPayee = new Map<string, Payment[]>()
  for (const p of payments) {
    const key = payeeKey(p.payee)
    if (!key || p.amount <= 0) continue
    byPayee.set(key, [...(byPayee.get(key) ?? []), p])
  }
  const out: Recurring[] = []
  for (const group of byPayee.values()) {
    const paid = [...group].sort((a, b) => a.date.localeCompare(b.date))
    // Two charges on one day (a retry, a split) are one payment for the rhythm.
    const days = paid.filter((p, i) => i === 0 || p.date !== paid[i - 1].date)
    if (days.length < 2) continue
    const gaps = days.slice(1).map((p, i) => daysBetween(days[i].date, p.date))
    const gap = median(gaps)
    const fit = CADENCES.find((c) => gap >= c.min && gap <= c.max)
    if (!fit || days.length < fit.least) continue
    // Steady: nearly every gap fits the same cadence, so a few coincidences make none.
    const steady = gaps.filter((g) => g >= fit.min && g <= fit.max).length
    if (steady < Math.ceil(gaps.length * 0.7)) continue
    const amounts = days.map((p) => p.amount)
    const last = days.at(-1)!
    const before = days.at(-2)!
    const changed = Math.abs(last.amount - before.amount) > Math.max(0.05, before.amount * 0.02)
    const next = addDays(last.date, fit.days)
    const overdueSince = addDays(next, Math.floor(fit.days / 2) + 1)
    out.push({
      payee: last.payee,
      cadence: fit.cadence,
      count: days.length,
      first: days[0].date,
      last: last.date,
      lastAmount: cents(last.amount),
      typical: cents(median(amounts)),
      ...(changed ? { previousAmount: cents(before.amount) } : {}),
      next,
      monthly: cents(median(amounts) * fit.perMonth),
      overdue: today >= overdueSince,
      overdueSince,
      fresh: days.length === fit.least,
    })
  }
  return out.sort((a, b) => b.monthly - a.monthly)
}

/** How far back a monthly look counts a change: a month and a few days, so none falls between two runs. */
export const MONTH_OF_CHANGES = 35

/**
 * The recurring payments that changed over the past month, as
 * recurring_payments lists them: a new price at a payment in that time, one
 * found for the first time, and one that became overdue in that time. Each is
 * a change once, in the month it happened, not again every month after.
 */
export function changedLately<T extends { last_paid_on?: unknown; price_change?: unknown; new?: unknown; overdue_since?: unknown }>(rows: readonly T[], today: string): T[] {
  const lately = (d: unknown) => typeof d === 'string' && daysBetween(d, today) >= 0 && daysBetween(d, today) <= MONTH_OF_CHANGES
  return rows.filter((r) => (r.price_change && lately(r.last_paid_on)) || r.new || lately(r.overdue_since))
}
