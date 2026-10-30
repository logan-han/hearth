import { tool } from 'ai'
import { z } from 'zod'
import * as ps from '../providers/pocketsmith'
import type { PsCategoryBudget, PsTransaction } from '../providers/pocketsmith'
import { localDateKey } from '../cron'
import { findRecurring, daysBetween, MONTH_OF_CHANGES } from '../recurring'
import { timezone } from '../env'
import type { ToolContext } from './context'
import { describeError } from '../errors'

const money = (n: number, currency = 'AUD') =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(n)

const DATE = z.string().describe(`Date as YYYY-MM-DD, in ${timezone()}`)

type BudgetLine = Pick<PsCategoryBudget, 'budgeted' | 'rollsOver' | 'forecast' | 'overBy' | 'underBy'>

/**
 * Where a category stands, in PocketSmith's own reckoning. Its allowance for
 * a month is the budget after rollover, so a category overspent in earlier
 * months can be allowed nothing this month and still be budgeted: that is
 * over by whatever was spent, never "unbudgeted". Only a category with no
 * budget at all is called that, in words that say so.
 */
export function budgetPosition(c: BudgetLine, currency: string): string {
  if (!c.budgeted) return 'no budget set'
  if (c.overBy > 0) return `over by ${money(c.overBy, currency)}`
  if (c.underBy > 0) return `under by ${money(c.underBy, currency)}`
  return 'on budget'
}

export const ROLLOVER_NOTE = 'nothing left this month after rollover'

/** Why a budgeted category is allowed nothing this month, when it is. */
export function budgetNote(c: BudgetLine): string | undefined {
  if (!c.budgeted || c.forecast !== 0) return undefined
  return c.rollsOver ? ROLLOVER_NOTE : 'nothing budgeted for this month'
}

/** First and last day of the month containing `now`, as local date keys. */
function currentMonth(now: Date): { start: string; end: string } {
  const key = localDateKey(now)
  const [y, m] = key.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${key.slice(0, 7)}-01`, end: `${key.slice(0, 7)}-${String(lastDay).padStart(2, '0')}` }
}

/**
 * Beside a summary whose read stopped at the provider's bound: the range
 * can hold more than was summed, and a total given as the whole would be short.
 */
const readShort = (read: number) =>
  `the read stopped at the most one summary takes (${read} transactions), so the range may hold more than these figures count; a shorter range counts them all`

/**
 * Everything a search looks in. "The ones marked with a name" means what the
 * household wrote on them, in a note or a label, which a summary showed only
 * for its six largest; and PocketSmith's own search skips the memo, so the
 * match is made here, on every field, ignoring case.
 */
const searchable = (t: PsTransaction) =>
  [t.payee, t.originalPayee, t.note, t.memo, ...t.labels, t.category, t.account].filter(Boolean).join('\n').toLowerCase()

/** The same day `months` earlier, as YYYY-MM-DD; the 31st of a shorter month runs into the next, which a look-back can bear. */
function monthsBack(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10)
}


export function moneyTools(ctx: ToolContext) {
  return {
    recurring_payments: tool({
      description:
        'Subscriptions and regular bills found in the PocketSmith feed: each payee paid on a steady rhythm, how often, what it usually costs and comes to a month, when the next is due, ' +
        'whether its price changed at the last payment, whether it is new, and whether the next is overdue (cancelled, moved or late). ' +
        'Use it for "what subscriptions do we have", "what do we pay every month", "did that go up", "anything we could cut". Found in code, not guessed: quote it as given.',
      inputSchema: z.object({
        months: z.number().int().min(3).max(18).default(12).describe('How far back to look'),
        search: z.string().optional().describe('Only payees containing this'),
      }),
      execute: async ({ months, search }) => {
        if (!ps.pocketsmithConfigured()) return { error: 'PocketSmith is not configured.' }
        const end = localDateKey(ctx.now)
        const start = monthsBack(end, months ?? 12)
        try {
          const txns = await ps.listTransactions({ startDate: start, endDate: end, limit: ps.MAX_TRANSACTIONS })
          // Money out, not moved between the household's own accounts.
          const paid = txns
            .filter((t) => t.amount < 0 && !t.isTransfer && !t.categoryIsTransfer)
            .map((t) => ({ date: t.date, payee: t.payee, amount: -t.amount }))
          const needle = search?.trim().toLowerCase()
          const found = findRecurring(paid, end).filter((r) => !needle || r.payee.toLowerCase().includes(needle))
          const live = found.filter((r) => !r.overdue)
          return {
            from: start,
            to: end,
            ...(txns.length >= ps.MAX_TRANSACTIONS ? { incomplete: readShort(txns.length) } : {}),
            monthly_total: money(live.reduce((sum, r) => sum + r.monthly, 0)),
            recurring: found.map((r) => ({
              payee: r.payee,
              how_often: r.cadence,
              usually: money(r.typical),
              a_month: money(r.monthly),
              last_paid_on: r.last,
              last_amount: money(r.lastAmount),
              next_due: r.next,
              payments_seen: r.count,
              ...(r.previousAmount !== undefined ? { price_change: `${money(r.previousAmount)} to ${money(r.lastAmount)} at the last payment` } : {}),
              // New in the month it was first seen often enough to count, whatever its rhythm.
              ...(r.fresh && daysBetween(r.last, end) <= MONTH_OF_CHANGES ? { new: `first paid ${r.first}` } : {}),
              ...(r.overdue
                ? { overdue: `due by ${r.next} and not seen since; it may have been cancelled, moved, or be late`, overdue_since: r.overdueSince }
                : {}),
            })),
            note: 'monthly_total adds up the ones not overdue, each at what it usually costs, worked out in code: quote it as given.',
          }
        } catch (e) {
          return { error: describeError(e) }
        }
      },
    }),

    list_bank_accounts: tool({
      description: 'Show the household bank accounts connected to PocketSmith and their balances.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!ps.pocketsmithConfigured()) return { error: 'PocketSmith is not configured.' }
        try {
          return {
            accounts: (await ps.listAccounts()).map((a) => ({
              name: a.name, type: a.type,
              balance: a.balance === null ? null : money(a.balance, a.currency.toUpperCase()),
              as_at: a.balanceDate,
            })),
          }
        } catch (e) {
          return { error: describeError(e) }
        }
      },
    }),

    list_transactions: tool({
      description:
        'List PocketSmith transactions one by one, across every account connected there: payee, amount, date, category, account, and the note, memo and labels written on each. ' +
        'Use this for "what did we buy on the 16th", "show the ones with <name> in the note", "did that charge go through". ' +
        'search keeps only those whose payee, note, memo, labels, category or account contain it. total_in, total_out and net sum every match, transfers included, so what a set of transactions comes to is read from them, not added up.',
      inputSchema: z.object({
        from: DATE.optional().describe('Defaults to the first of this month'),
        to: DATE.optional().describe('Defaults to today'),
        search: z.string().optional().describe('A word or name to look for, such as one written in the notes; case is ignored'),
        account: z.string().optional().describe('Only the accounts whose name contains this'),
        limit: z.number().int().min(1).max(100).default(50).describe('How many to list; the totals count every match'),
      }),
      execute: async ({ from, to, search, account, limit }) => {
        if (!ps.pocketsmithConfigured()) return { error: 'PocketSmith is not configured.' }
        // A range given only its end starts that month, not this one, which may come after it.
        const start = from ?? (to ? `${to.slice(0, 7)}-01` : currentMonth(ctx.now).start)
        const end = to ?? localDateKey(ctx.now)
        try {
          const txns = await ps.listTransactions({ startDate: start, endDate: end, limit: ps.MAX_TRANSACTIONS })
          const where = account?.trim().toLowerCase()
          const inAccount = where ? txns.filter((t) => (t.account ?? '').toLowerCase().includes(where)) : txns
          if (where && inAccount.length === 0) {
            const names = [...new Set(txns.map((t) => t.account).filter(Boolean))]
            return { error: `No transactions from ${start} to ${end} in an account matching "${account}". Accounts with transactions then: ${names.join(', ') || 'none'}.` }
          }
          const needle = search?.trim().toLowerCase()
          const matched = (needle ? inAccount.filter((t) => searchable(t).includes(needle)) : inAccount).sort((a, b) =>
            b.date.localeCompare(a.date),
          )
          const totalIn = matched.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)
          const totalOut = matched.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0)
          const shown = matched.slice(0, limit)
          return {
            from: start, to: end,
            ...(search ? { search } : {}),
            ...(account ? { account } : {}),
            matched: matched.length,
            ...(txns.length >= ps.MAX_TRANSACTIONS ? { incomplete: readShort(txns.length) } : {}),
            total_in: money(totalIn), total_out: money(totalOut), net: money(totalIn - totalOut),
            ...(shown.length < matched.length ? { more_not_shown: matched.length - shown.length } : {}),
            transactions: shown.map((t) => ({
              date: t.date,
              payee: t.payee,
              amount: money(t.amount),
              category: t.category ?? 'Uncategorised',
              account: t.account,
              ...(t.note ? { note: t.note } : {}),
              ...(t.memo ? { memo: t.memo } : {}),
              ...(t.labels.length ? { labels: t.labels } : {}),
              ...(t.isTransfer || t.categoryIsTransfer ? { transfer: true } : {}),
            })),
          }
        } catch (e) {
          return { error: describeError(e) }
        }
      },
    }),

    spending_summary: tool({
      description:
        'Total money in and out over a period, broken down by category, from PocketSmith. Defaults to the current month. Use this for "how much have we spent this month"; for the transactions themselves, list_transactions. ' +
        'Spend is what left the expense categories, net of refunds. A debit filed under an income category (a tax payment, a levy) is a deduction from income, not spend: it is reported under deductions and never in the category breakdown.',
      inputSchema: z.object({
        from: DATE.optional().describe('Defaults to the first of this month'),
        to: DATE.optional().describe('Defaults to the last day of this month'),
      }),
      execute: async ({ from, to }) => {
        if (!ps.pocketsmithConfigured()) return { error: 'PocketSmith is not configured.' }
        const month = currentMonth(ctx.now)
        const start = from ?? month.start
        const end = to ?? month.end

        try {
          const txns = await ps.listTransactions({ startDate: start, endDate: end, limit: ps.MAX_TRANSACTIONS })
          // Transfers move money between our own accounts (or square up a
          // reimbursement); counting them would double the total and make
          // every summary wrong. PocketSmith marks them two ways: a flag on
          // the transaction, or the whole category being a transfer bucket.
          const real = txns.filter((t) => !t.isTransfer && !t.categoryIsTransfer)
          // Each side of the ledger is the category's, as PocketSmith keeps
          // it, not the sign's: a tax payment filed under income is a
          // deduction from income, a rebate filed under an expense comes off
          // the spend. Only an uncategorised transaction goes by its sign.
          // That is how PocketSmith's own totals are reckoned, so the figures
          // here agree with the budget's.
          const sideOf = (t: PsTransaction) => t.categoryKind ?? (t.amount < 0 ? 'expense' : 'income')
          const expenses = real.filter((t) => sideOf(t) === 'expense')
          const incomeSide = real.filter((t) => sideOf(t) === 'income')
          const byCategory = new Map<string, number>()
          for (const t of expenses) {
            const key = t.category ?? 'Uncategorised'
            byCategory.set(key, (byCategory.get(key) ?? 0) - t.amount)
          }
          const total = expenses.reduce((s, t) => s - t.amount, 0)
          const received = incomeSide.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)
          const deductions = incomeSide.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0)
          const isDeduction = (t: PsTransaction) => t.amount < 0 && sideOf(t) === 'income'

          return {
            source: 'pocketsmith', from: start, to: end, transactions: real.length,
            ...(txns.length >= ps.MAX_TRANSACTIONS ? { incomplete: readShort(txns.length) } : {}),
            spent: money(total), received: money(received),
            ...(deductions > 0 ? { deductions: money(deductions), net_income: money(received - deductions) } : {}),
            net: money(received - deductions - total),
            by_category: [...byCategory]
              .filter(([, amount]) => amount > 0)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 12)
              .map(([category, amount]) => ({
                category, amount: money(amount), share_of_spend: `${Math.round((amount / total) * 100)}%`,
              })),
            // The payee is what turns "$1,198 Medical" into "the AHM premium".
            // A deduction is still a payment the household made, so it is
            // listed among the largest, and says what it counts as.
            largest: real
              .filter((t) => t.amount < 0)
              .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
              .slice(0, 6)
              .map((t) => ({
                payee: t.payee,
                amount: money(Math.abs(t.amount)),
                category: t.category ?? 'Uncategorised',
                date: t.date,
                note: t.note ?? t.memo,
                ...(isDeduction(t) ? { counts_as: 'a deduction from income, not spend' } : {}),
              })),
            // Salary credits are the income source, not news; this list exists
            // so a genuinely unusual credit (a refund, a payout) is visible. A
            // credit filed under an expense came off that spend above, and
            // says so: without the word, a post that called one a refund was
            // cut as saying what the evidence did not.
            largest_credits: real
              .filter((t) => t.amount > 0)
              .sort((a, b) => b.amount - a.amount)
              .slice(0, 3)
              .map((t) => ({
                payee: t.payee,
                amount: money(t.amount),
                category: t.category ?? 'Uncategorised',
                date: t.date,
                note: t.note ?? t.memo,
                ...(sideOf(t) === 'expense' ? { counts_as: 'a refund, taken off the spend in its category' } : {}),
              })),
          }
        } catch (e) {
          return { error: describeError(e) }
        }
      },
    }),

    budget_summary: tool({
      description:
        'PocketSmith budget for a month: what was forecast against what actually happened.',
      inputSchema: z.object({ from: DATE.optional(), to: DATE.optional() }),
      execute: async ({ from, to }) => {
        if (!ps.pocketsmithConfigured()) return { error: 'PocketSmith is not configured.' }
        const month = currentMonth(ctx.now)
        try {
          const [s, perCategory] = await Promise.all([
            ps.budgetSummary({ startDate: from ?? month.start, endDate: to ?? month.end }),
            ps.budgetByCategory({ startDate: from ?? month.start, endDate: to ?? month.end }),
          ])
          const cur = s.expense.currency.toUpperCase()

          // Pacing, precomputed so the snapshot quotes it: how much of the
          // budget is used, and (within one month) how far through it we are.
          const usedPct =
            s.expense.totalForecast !== 0
              ? `${Math.round((Math.abs(s.expense.totalActual) / Math.abs(s.expense.totalForecast)) * 100)}%`
              : null
          const startDate = from ?? month.start
          const endDate = to ?? month.end
          let monthProgress: string | null = null
          if (startDate.slice(0, 7) === endDate.slice(0, 7)) {
            const [y, m] = startDate.split('-').map(Number)
            const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
            // Elapsed is measured from today, clamped into the range, so asking
            // about the whole current month reads "24 of 31 days", not 31.
            const today = localDateKey(ctx.now)
            const endDay = Number(endDate.slice(8))
            const elapsed =
              today < startDate ? 0 : Math.min(today > endDate ? endDay : Number(today.slice(8)), endDay) - Number(startDate.slice(8)) + 1
            monthProgress = `${elapsed} of ${daysInMonth} days (${Math.round((elapsed / daysInMonth) * 100)}% of the month)`
          }

          // The budgeted categories come first, most over budget at the top;
          // spending with no budget behind it is listed after them.
          const listed = perCategory
            .filter((c) => c.forecast !== 0 || c.actual !== 0)
            .sort((a, b) => Number(b.budgeted) - Number(a.budgeted) || b.overBy - a.overBy)
            .slice(0, 12)
          // Named once, together, so a post can say it in one line rather than beside every row.
          const rolledOut = listed.filter((c) => budgetNote(c) === ROLLOVER_NOTE).map((c) => c.title)

          return {
            from: startDate,
            to: endDate,
            ...(monthProgress ? { period_progress: monthProgress } : {}),
            income: { actual: money(s.income.totalActual, cur), forecast: money(s.income.totalForecast, cur) },
            expenses: {
              actual: money(s.expense.totalActual, cur),
              forecast: money(s.expense.totalForecast, cur),
              ...(usedPct ? { used: usedPct } : {}),
            },
            // PocketSmith precomputes over/under per category; quote these
            // positions verbatim rather than doing arithmetic in prose.
            budget_by_category: listed.map((c) => {
              const note = budgetNote(c)
              return {
                category: c.title,
                actual: money(c.actual, cur),
                forecast: money(c.forecast, cur),
                budget_period: `${c.from} to ${c.to}`,
                position: budgetPosition(c, cur),
                ...(note ? { note } : {}),
              }
            }),
            ...(rolledOut.length ? { rollover_used_up: rolledOut } : {}),
          }
        } catch (e) {
          return { error: describeError(e) }
        }
      },
    }),
  }
}
