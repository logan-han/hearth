import type { UpTransaction } from './providers/up'

/**
 * The flags a money watcher may raise, computed from the feed rather than
 * guessed by a model: whether the payee has been seen before, whether the
 * amount is out of scale for the account, whether the same charge appears
 * twice, and whether money came in rather than out. The model is only asked
 * to put these into words.
 */
export type TransactionFlag = 'new_payee' | 'unusually_large' | 'possible_duplicate' | 'money_in'

/** How far back to look for what is normal on the account. */
export const HISTORY_DAYS = 90
/** Prior transactions needed before "new" or "unusual" means anything. */
const MIN_HISTORY = 10
const MIN_DEBITS_FOR_SCALE = 5
const LARGE_RATIO = 3
const LARGE_FLOOR = 50
const DUPLICATE_WINDOW_MS = 48 * 3600_000

/**
 * Merchant strings carry store numbers and suburbs ("WOOLWORTHS 3061
 * NORTHCOTE"); the payee is the leading word, or two when the first is a
 * short processor prefix like "SQ" or "PP".
 */
export function payeeKey(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return description.trim().toLowerCase()
  return words[0].length <= 3 && words.length > 1 ? `${words[0]} ${words[1]}` : words[0]
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export type FlagReport = {
  flags: Map<string, TransactionFlag[]>
  /** The account's median debit over the window, or null without enough history. */
  typicalDebit: number | null
  historyCount: number
}

export function flagTransactions(fresh: UpTransaction[], history: UpTransaction[]): FlagReport {
  const freshIds = new Set(fresh.map((t) => t.id))
  const prior = history.filter((t) => !freshIds.has(t.id))
  const knownPayees = new Set(prior.map((t) => payeeKey(t.description)))
  const debits = prior.filter((t) => t.amount < 0).map((t) => -t.amount)
  const typicalDebit = debits.length >= MIN_DEBITS_FOR_SCALE ? median(debits) : null
  const everything = [...prior, ...fresh]

  const flags = new Map<string, TransactionFlag[]>()
  for (const t of fresh) {
    const out: TransactionFlag[] = []
    if (t.amount > 0) out.push('money_in')
    if (prior.length >= MIN_HISTORY && !knownPayees.has(payeeKey(t.description))) out.push('new_payee')
    if (typicalDebit !== null && t.amount < 0 && -t.amount >= LARGE_FLOOR && -t.amount >= LARGE_RATIO * typicalDebit) {
      out.push('unusually_large')
    }
    const at = new Date(t.createdAt).getTime()
    const twin = everything.find(
      (o) =>
        o.id !== t.id &&
        o.amount === t.amount &&
        payeeKey(o.description) === payeeKey(t.description) &&
        Math.abs(new Date(o.createdAt).getTime() - at) <= DUPLICATE_WINDOW_MS,
    )
    if (twin) out.push('possible_duplicate')
    flags.set(t.id, out)
  }
  return { flags, typicalDebit, historyCount: prior.length }
}
