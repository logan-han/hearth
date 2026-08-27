import { tool } from 'ai'
import { z } from 'zod'
import * as up from '../providers/up'
import * as ps from '../providers/pocketsmith'
import { readCursor, writeCursor } from './cursor'
import { localToUtc, formatLocal, localDateKey } from '../cron'
import { timezone } from '../env'
import type { ToolContext } from './context'

const money = (n: number, currency = 'AUD') =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(n)

const DATE = z.string().describe(`Date as YYYY-MM-DD, in ${timezone()}`)

/** First and last day of the month containing `now`, as local date keys. */
function currentMonth(now: Date): { start: string; end: string } {
  const key = localDateKey(now)
  const [y, m] = key.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { start: `${key.slice(0, 7)}-01`, end: `${key.slice(0, 7)}-${String(lastDay).padStart(2, '0')}` }
}

export function moneyTools(ctx: ToolContext) {
  return {
    list_bank_accounts: tool({
      description:
        'Show the household bank accounts and their balances. Up Bank accounts marked JOINT are the shared 2Up ones.',
      inputSchema: z.object({}),
      execute: async () => {
        const out: Record<string, unknown> = {}
        if (up.upConfigured()) {
          try {
            out.up = (await up.listAccounts()).map((a) => ({
              name: a.name, type: a.type, ownership: a.ownership,
              balance: money(a.balance, a.currency), shared: a.ownership === 'JOINT',
            }))
          } catch (e) {
            out.up = { error: describe(e) }
          }
        }
        if (ps.pocketsmithConfigured()) {
          try {
            out.pocketsmith = (await ps.listAccounts()).map((a) => ({
              name: a.name, type: a.type,
              balance: a.balance === null ? null : money(a.balance, a.currency.toUpperCase()),
              as_at: a.balanceDate,
            }))
          } catch (e) {
            out.pocketsmith = { error: describe(e) }
          }
        }
        return Object.keys(out).length ? out : { error: 'No bank integration is configured.' }
      },
    }),

    list_transactions: tool({
      description:
        'List recent Up Bank transactions, optionally for one account. Use this for "what did we buy", "show the last few transactions on 2Up".',
      inputSchema: z.object({
        account: z.string().optional().describe('Account name or "2up" for the shared account'),
        from: DATE.optional(),
        to: DATE.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: async ({ account, from, to, limit }) => {
        if (!up.upConfigured()) return { error: 'Up Bank is not configured.' }
        try {
          const acct = account ? await up.findAccount(account) : undefined
          if (account && !acct) return { error: `No Up account matching "${account}".` }

          const txns = await up.listTransactions({
            accountId: acct?.id,
            since: from ? localToUtc(from) : undefined,
            until: to ? localToUtc(`${to}T23:59:59`) : undefined,
            limit,
          })
          return {
            account: acct?.name ?? 'all accounts',
            transactions: txns.map((t) => ({
              description: t.description,
              amount: money(t.amount, t.currency),
              when: formatLocal(new Date(t.createdAt)),
              status: t.status,
              by: t.performedBy,
              message: t.message,
            })),
          }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    spending_summary: tool({
      description:
        'Total money in and out over a period, broken down by category. Defaults to the current month. Use this for "how much have we spent this month".',
      inputSchema: z.object({
        from: DATE.optional().describe('Defaults to the first of this month'),
        to: DATE.optional().describe('Defaults to the last day of this month'),
        source: z
          .enum(['pocketsmith', 'up'])
          .default('pocketsmith')
          .describe('PocketSmith has categories; Up is the raw account feed'),
      }),
      execute: async ({ from, to, source }) => {
        const month = currentMonth(ctx.now)
        const start = from ?? month.start
        const end = to ?? month.end

        try {
          if (source === 'up') {
            if (!up.upConfigured()) return { error: 'Up Bank is not configured.' }
            const txns = await up.listTransactions({
              since: localToUtc(start),
              until: localToUtc(`${end}T23:59:59`),
              limit: 300,
            })
            const spent = txns.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0)
            const received = txns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)
            return {
              source: 'up', from: start, to: end, transactions: txns.length,
              spent: money(Math.abs(spent)), received: money(received),
              net: money(received + spent),
              largest: [...txns]
                .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
                .slice(0, 6)
                .map((t) => ({
                  description: t.description,
                  amount: money(Math.abs(t.amount)),
                  direction: t.amount < 0 ? 'out' : 'in',
                  when: formatLocal(new Date(t.createdAt)),
                })),
            }
          }

          if (!ps.pocketsmithConfigured()) return { error: 'PocketSmith is not configured.' }
          const txns = await ps.listTransactions({ startDate: start, endDate: end, limit: 1000 })
          // Transfers move money between our own accounts (or square up a
          // reimbursement); counting them would double the total and make
          // every summary wrong. PocketSmith marks them two ways: a flag on
          // the transaction, or the whole category being a transfer bucket.
          const real = txns.filter((t) => !t.isTransfer && !t.categoryIsTransfer)
          const spent = real.filter((t) => t.amount < 0)
          const byCategory = new Map<string, number>()
          for (const t of spent) {
            const key = t.category ?? 'Uncategorised'
            byCategory.set(key, (byCategory.get(key) ?? 0) + Math.abs(t.amount))
          }
          const total = spent.reduce((s, t) => s + Math.abs(t.amount), 0)
          const received = real.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)

          return {
            source: 'pocketsmith', from: start, to: end, transactions: real.length,
            spent: money(total), received: money(received), net: money(received - total),
            by_category: [...byCategory]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 12)
              .map(([category, amount]) => ({
                category, amount: money(amount), share_of_spend: `${Math.round((amount / total) * 100)}%`,
              })),
            // The payee is what turns "$1,198 Medical" into "the AHM premium",
            // and shows up a debit filed under an income category for what it is.
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
              })),
            // Salary credits are the income source, not news; this list exists
            // so a genuinely unusual credit (a refund, a payout) is visible.
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
              })),
          }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    new_transactions: tool({
      description:
        'Up Bank transactions that have appeared since the last time this chat checked. Built for scheduled announcements: it advances its own marker, so nothing is ever posted twice. Returns an empty list when there is nothing new.',
      inputSchema: z.object({
        account: z.string().default('2up').describe('Account name, or "2up" for the shared account'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ account, limit }) => {
        if (!up.upConfigured()) return { error: 'Up Bank is not configured.' }
        try {
          const acct = await up.findAccount(account)
          if (!acct) return { error: `No Up account matching "${account}".` }

          const key = `up_cursor:${ctx.chatId}:${acct.id}`
          const cursor = await readCursor(key)
          // First run has no marker. Look back only a little, so switching this
          // on does not dump months of history into the chat.
          const since = cursor ? new Date(cursor.at) : new Date(ctx.now.getTime() - 24 * 3600_000)

          const found = await up.listTransactions({ accountId: acct.id, since, limit: limit + 10 })
          // `since` is inclusive, so a transaction at exactly the marker comes
          // back again; the remembered ids are what actually stop a repost.
          const seen = new Set(cursor?.ids ?? [])
          const fresh = found
            .filter((t) => !seen.has(t.id) && new Date(t.createdAt) >= since)
            .slice(0, limit)

          if (fresh.length > 0) {
            const newest = fresh.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b))
            await writeCursor(key, newest.createdAt, fresh.map((t) => t.id), cursor)
          } else if (!cursor) {
            // Nothing to report, but remember we looked, so the next run is
            // incremental rather than another 24-hour sweep.
            await writeCursor(key, ctx.now.toISOString(), [], null)
          }

          return {
            account: acct.name,
            first_check: !cursor,
            count: fresh.length,
            transactions: fresh.map((t) => ({
              description: t.description,
              amount: money(t.amount, t.currency),
              when: formatLocal(new Date(t.createdAt)),
              status: t.status,
              by: t.performedBy,
              message: t.message,
            })),
          }
        } catch (e) {
          return { error: describe(e) }
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
            budget_by_category: perCategory
              .filter((c) => c.forecast !== 0 || c.actual !== 0)
              .sort((a, b) => b.overBy - a.overBy)
              .slice(0, 12)
              .map((c) => ({
                category: c.title,
                actual: money(c.actual, cur),
                forecast: money(c.forecast, cur),
                budget_period: `${c.from} to ${c.to}`,
                position:
                  c.forecast === 0
                    ? 'unbudgeted'
                    : c.overBy > 0
                      ? `over by ${money(c.overBy, cur)}`
                      : c.underBy > 0
                        ? `under by ${money(c.underBy, cur)}`
                        : 'on budget',
              })),
          }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
