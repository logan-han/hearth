import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import { getSetting } from '@/lib/db/queries'
import { commitCursors } from '@/lib/tools/cursor'
import type { ToolContext } from '@/lib/tools/context'

const { moneyTools, budgetPosition, budgetNote } = await import('@/lib/tools/money')
const ps = await import('@/lib/providers/pocketsmith')

const fetchMock = vi.fn()
let client: PGlite
let ctx: ToolContext

const NOW = new Date('2026-08-27T02:00:00Z') // 27 Aug, midday in Melbourne

/**
 * Route arguments through the tool's own schema first, the way the AI SDK does
 * when it hands a model's tool call over. That is what applies zod defaults, so
 * calling execute directly would test a path production never takes.
 */
const call = (name: string, args: unknown) => {
  const tools = moneyTools(ctx) as Record<string, { execute: unknown; inputSchema: { parse: (a: unknown) => unknown } }>
  const parsed = tools[name].inputSchema.parse(args)
  return (tools[name].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(parsed, {})
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.POCKETSMITH_DEVELOPER_KEY = 'ps-key'
  ps.resetUserCache()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  client = (await freshDb()).client
  ctx = { chatId: '-100', member: null, memberName: 'Rowan', now: NOW, notices: [] }
})
afterEach(async () => { vi.unstubAllGlobals(); await closeDb(client) })

describe('configuration', () => {
  it('says so rather than throwing when PocketSmith is not configured', async () => {
    delete process.env.POCKETSMITH_DEVELOPER_KEY
    expect(ps.pocketsmithConfigured()).toBe(false)
    for (const name of ['list_bank_accounts', 'list_transactions', 'spending_summary', 'budget_summary', 'recurring_payments']) {
      expect(String((await call(name, {})).error)).toBe('PocketSmith is not configured.')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('has no tool left for a feed it no longer reads', () => {
    expect(Object.keys(moneyTools(ctx)).sort()).toEqual(['budget_summary', 'list_bank_accounts', 'list_transactions', 'recurring_payments', 'spending_summary'])
  })
})

describe('accounts', () => {
  const serve = (accounts: unknown) =>
    fetchMock.mockImplementation(async (url: URL) => (String(url).endsWith('/me') ? json({ id: 42 }) : json(accounts)))

  it('lists the PocketSmith accounts with their balances formatted', async () => {
    serve([{ id: 1, title: 'NAB', type: 'bank', current_balance: 1500.5, currency_code: 'aud', current_balance_date: '2026-08-27' }])
    const r = await call('list_bank_accounts', {})
    expect(r.accounts).toEqual([{ name: 'NAB', type: 'bank', balance: '$1,500.50', as_at: '2026-08-27' }])
  })

  it('reports a null balance as null, not a formatted currency string', async () => {
    serve([{ id: 1, title: 'Wise', type: 'bank', current_balance: null, currency_code: 'usd', current_balance_date: null }])
    const r = await call('list_bank_accounts', {})
    expect((r.accounts as { name: string; balance: string | null }[])[0]).toMatchObject({ name: 'Wise', balance: null })
  })

  it('surfaces a provider error instead of throwing', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).endsWith('/me') ? json({ id: 42 }) : { ok: false, status: 500, text: async () => 'ps down' },
    )
    expect(String((await call('list_bank_accounts', {})).error)).toContain('500')
  })
})

describe('spending_summary via PocketSmith', () => {
  // Categories as PocketSmith marks them: an expense category's credits are
  // refunds, an income category's debits are deductions.
  const expense = (title: string) => ({ title, refund_behaviour: 'credits_are_refunds' })
  const income = (title: string) => ({ title, refund_behaviour: 'debits_are_deductions' })
  const psTxns = [
    { id: 1, date: '2026-08-02', payee: 'Coles', amount: -100, category: expense('Supermarket'), is_transfer: false },
    { id: 2, date: '2026-08-03', payee: 'Woolies', amount: -50, category: expense('Supermarket'), is_transfer: false },
    { id: 3, date: '2026-08-04', payee: 'Petrol', amount: -50, category: expense('Transport'), is_transfer: false },
    { id: 4, date: '2026-08-05', payee: 'Salary', amount: 1000, category: income('Income'), is_transfer: false },
    { id: 5, date: '2026-08-06', payee: 'Move to savings', amount: -900, category: null, is_transfer: true },
    { id: 6, date: '2026-08-07', payee: 'Unknown', amount: -25, category: null, is_transfer: false },
    { id: 7, date: '2026-08-08', payee: 'Anz Cards', amount: -500, category: { title: 'Transfers', is_transfer: true }, is_transfer: false },
    // A tax payment the household files under income on purpose: off the income, not spend.
    { id: 8, date: '2026-08-09', payee: 'ZIPPAY* P910', amount: -60, category: income('Income'), is_transfer: false, note: 'Card ending 7031 - BAS' },
    // A rebate filed under the expense it refunds: off the spend, not income.
    { id: 9, date: '2026-08-10', payee: 'Medicare rebate', amount: 40, category: expense('Medical'), is_transfer: false },
    { id: 10, date: '2026-08-10', payee: 'Clinic', amount: -90, category: expense('Medical'), is_transfer: false },
  ]

  const serve = (txns: unknown[]) =>
    fetchMock.mockImplementation(async (url: URL) => {
      const u = String(url)
      if (u.endsWith('/me')) return json({ id: 42 })
      if (u.includes('/transactions')) return json(txns)
      return json([])
    })

  beforeEach(() => {
    serve(psTxns)
  })

  it('defaults to the current month in Melbourne', async () => {
    const r = await call('spending_summary', {})
    expect(r.from).toBe('2026-08-01')
    expect(r.to).toBe('2026-08-31')
  })

  it('excludes transfers, which would otherwise double the total', async () => {
    const r = await call('spending_summary', {})
    expect(r.transactions).toBe(8)
    expect(r.spent).toBe('$275.00')
    expect(r.received).toBe('$1,000.00')
    expect(r.net).toBe('$665.00')
  })

  it('keeps a debit filed under income out of the spend: a deduction from income, said as such', async () => {
    const r = await call('spending_summary', {})
    expect(r.deductions).toBe('$60.00')
    expect(r.net_income).toBe('$940.00')
    const cats = r.by_category as { category: string }[]
    expect(cats.map((c) => c.category)).not.toContain('Income')
    const largest = r.largest as { payee: string; counts_as?: string }[]
    expect(largest.find((t) => t.payee.startsWith('ZIPPAY'))?.counts_as).toBe('a deduction from income, not spend')
    expect(largest.find((t) => t.payee === 'Coles')?.counts_as).toBeUndefined()
  })

  it('nets a refund against the expense it refunds rather than counting it as income', async () => {
    const r = await call('spending_summary', {})
    const cats = r.by_category as { category: string; amount: string }[]
    expect(cats.find((c) => c.category === 'Medical')).toMatchObject({ amount: '$50.00' })
    expect(r.received).toBe('$1,000.00')
  })

  it('says a credit filed under an expense is a refund, so a post may call it one', async () => {
    const r = await call('spending_summary', {})
    const credits = r.largest_credits as { payee: string; counts_as?: string }[]
    expect(credits.find((c) => c.payee === 'Medicare rebate')?.counts_as).toBe('a refund, taken off the spend in its category')
    expect(credits.find((c) => c.payee === 'Salary')?.counts_as).toBeUndefined()
  })

  it('says nothing about deductions when there are none', async () => {
    serve(psTxns.filter((t) => t.id !== 8))
    const r = await call('spending_summary', {})
    expect(r.deductions).toBeUndefined()
    expect(r.net_income).toBeUndefined()
    expect(r.net).toBe('$725.00')
  })

  it('excludes transfer-category transactions without a trace, since their sum means nothing', async () => {
    const r = await call('spending_summary', {})
    const cats = r.by_category as { category: string }[]
    expect(cats.map((c) => c.category)).not.toContain('Transfers')
    expect(r.transfers_excluded).toBeUndefined()
    const largest = r.largest as { payee: string }[]
    expect(largest.map((x) => x.payee)).not.toContain('Anz Cards')
  })

  it('breaks spending down by category, largest first', async () => {
    const r = await call('spending_summary', {})
    const cats = r.by_category as { category: string; amount: string; share_of_spend: string }[]
    expect(cats[0]).toEqual({ category: 'Supermarket', amount: '$150.00', share_of_spend: '55%' })
    // No category kind to go by: a debit is spend.
    expect(cats.map((c) => c.category)).toContain('Uncategorised')
  })

  it('lists the largest outgoings with payee, category and note, salaries kept apart', async () => {
    const r = await call('spending_summary', {})
    const largest = r.largest as { payee: string; amount: string; category: string; note: string | null }[]
    expect(largest[0]).toMatchObject({ payee: 'Coles', amount: '$100.00' })
    const zip = largest.find((t) => t.payee.startsWith('ZIPPAY'))
    expect(zip).toMatchObject({ note: 'Card ending 7031 - BAS', category: 'Income' })
    const credits = r.largest_credits as { payee: string; amount: string }[]
    expect(credits[0]).toMatchObject({ payee: 'Salary', amount: '$1,000.00' })
    expect(credits.map((c) => c.payee)).toEqual(['Salary', 'Medicare rebate'])
  })

  it('honours an explicit range', async () => {
    const r = await call('spending_summary', { from: '2026-07-01', to: '2026-07-31' })
    expect(r.from).toBe('2026-07-01')
    const url = new URL(String(fetchMock.mock.calls.find(([u]) => String(u).includes('/transactions'))![0]))
    expect(url.searchParams.get('start_date')).toBe('2026-07-01')
  })

  it('asks for a page size the API will accept', async () => {
    await call('spending_summary', {})
    const url = new URL(String(fetchMock.mock.calls.find(([u]) => String(u).includes('/transactions'))![0]))
    expect(Number(url.searchParams.get('per_page'))).toBeGreaterThanOrEqual(10)
    expect(Number(url.searchParams.get('per_page'))).toBeLessThanOrEqual(1000)
  })

  it('resolves the user id once and reuses it', async () => {
    await call('spending_summary', {})
    await call('spending_summary', {})
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/me'))).toHaveLength(1)
  })

  describe('a range longer than one page', () => {
    const row = (id: number) => ({ id, date: '2026-08-15', payee: 'Coles', amount: -1, category: expense('Supermarket'), is_transfer: false })
    const pages: number[] = []
    const serveRows = (total: number) => {
      pages.length = 0
      fetchMock.mockImplementation(async (url: URL) => {
        const u = new URL(String(url))
        if (u.pathname.endsWith('/me')) return json({ id: 42 })
        const page = Number(u.searchParams.get('page'))
        const perPage = Number(u.searchParams.get('per_page'))
        pages.push(page)
        const first = (page - 1) * perPage
        return json(Array.from({ length: Math.max(0, Math.min(perPage, total - first)) }, (_, i) => row(first + i)))
      })
    }

    it('reads every page, not just the first thousand', async () => {
      serveRows(1400)
      const r = await call('spending_summary', { from: '2026-07-01', to: '2026-09-23' })
      expect(pages).toEqual([1, 2])
      expect(r.transactions).toBe(1400)
      expect(r.spent).toBe('$1,400.00')
      expect(r.incomplete).toBeUndefined()
    })

    it('asks once more when the last page is exactly full, to see there is nothing after it', async () => {
      serveRows(1000)
      const r = await call('spending_summary', {})
      expect(pages).toEqual([1, 2])
      expect(r.transactions).toBe(1000)
    })

    it('stops at the most one summary reads, and says the figures may fall short', async () => {
      serveRows(8000)
      const r = await call('spending_summary', { from: '2025-07-01', to: '2026-06-30' })
      expect(pages).toEqual([1, 2, 3, 4, 5])
      expect(r.transactions).toBe(ps.MAX_TRANSACTIONS)
      expect(String(r.incomplete)).toContain(`${ps.MAX_TRANSACTIONS} transactions`)
    })
  })

  it('treats an uncategorised credit as income, not spend, and labels it Uncategorised among the largest credits', async () => {
    serve([{ id: 20, date: '2026-08-11', payee: 'Refund misc', amount: 30, category: null, is_transfer: false }])
    const r = await call('spending_summary', {})
    expect(r.received).toBe('$30.00')
    expect(r.by_category).toEqual([])
    const credits = r.largest_credits as { payee: string; category: string }[]
    expect(credits[0]).toMatchObject({ payee: 'Refund misc', category: 'Uncategorised' })
  })
})

describe('list_transactions', () => {
  // What the household writes on a transaction lives in its note, memo and
  // labels; a search finds it there as well as in the payee.
  const psTxns = [
    { id: 1, date: '2026-08-03', payee: 'Sugar Cafe', original_payee: 'SUGAR CAFE RINGWOOD', amount: -42.5, category: { title: 'Restaurants/Dining' }, transaction_account: { name: 'Spending' }, is_transfer: false, note: 'for Ada', labels: [] },
    { id: 2, date: '2026-08-16', payee: 'Ada Fixture', amount: 42.5, category: { title: 'Reimbursements', is_transfer: true }, transaction_account: { name: 'Spending' }, is_transfer: false, note: null, labels: [] },
    { id: 3, date: '2026-08-10', payee: 'Coles', amount: -80, category: { title: 'Supermarket' }, transaction_account: { name: '2Up Spending' }, is_transfer: false, memo: 'split with ada', labels: ['groceries'] },
    { id: 4, date: '2026-08-12', payee: 'Petrol', amount: -60, category: { title: 'Transport' }, transaction_account: { name: 'Amex' }, is_transfer: false, labels: ['ADA'] },
    { id: 5, date: '2026-08-20', payee: 'Bunnings', amount: -15, category: null, transaction_account: { name: 'Amex' }, is_transfer: false },
  ]
  const serve = (txns: unknown[]) =>
    fetchMock.mockImplementation(async (url: URL) => {
      const u = String(url)
      if (u.endsWith('/me')) return json({ id: 42 })
      if (u.includes('/transactions')) return json(txns)
      return json([])
    })
  const asked = () => new URL(String(fetchMock.mock.calls.find(([u]) => String(u).includes('/transactions'))![0]))

  beforeEach(() => {
    serve(psTxns)
  })

  it('lists the month so far one by one, newest first, with what was written on each and nothing it lacks', async () => {
    const r = await call('list_transactions', {})
    expect(r).toMatchObject({ from: '2026-08-01', to: '2026-08-27', matched: 5 })
    expect(asked().searchParams.get('start_date')).toBe('2026-08-01')
    expect(asked().searchParams.get('end_date')).toBe('2026-08-27')
    const txns = r.transactions as Record<string, unknown>[]
    expect(txns.map((t) => t.payee)).toEqual(['Bunnings', 'Ada Fixture', 'Petrol', 'Coles', 'Sugar Cafe'])
    expect(txns[4]).toEqual({ date: '2026-08-03', payee: 'Sugar Cafe', amount: '-$42.50', category: 'Restaurants/Dining', account: 'Spending', note: 'for Ada' })
    expect(txns[3]).toMatchObject({ memo: 'split with ada', labels: ['groceries'] })
    expect(txns[0]).toMatchObject({ category: 'Uncategorised', amount: '-$15.00' })
    expect(txns[1]).toMatchObject({ amount: '$42.50', transfer: true })
  })

  it('finds a name wherever it was written, ignoring case, and sums every match, transfers included', async () => {
    const r = await call('list_transactions', { search: 'Ada' })
    expect(r).toMatchObject({ search: 'Ada', matched: 4, total_in: '$42.50', total_out: '$182.50', net: '-$140.00' })
    expect((r.transactions as { payee: string }[]).map((t) => t.payee)).toEqual(['Ada Fixture', 'Petrol', 'Coles', 'Sugar Cafe'])
    // The bank's own wording counts too, though only the tidied payee is shown.
    expect((await call('list_transactions', { search: 'ringwood' })).matched).toBe(1)
    expect((await call('list_transactions', { search: 'nobody' })).matched).toBe(0)
  })

  it('totals every match even when the list is cut short, and says how many it left out', async () => {
    const r = await call('list_transactions', { limit: 2 })
    expect(r.transactions).toHaveLength(2)
    expect(r).toMatchObject({ matched: 5, more_not_shown: 3, total_in: '$42.50', total_out: '$197.50', net: '-$155.00' })
    expect((await call('list_transactions', {})).more_not_shown).toBeUndefined()
  })

  it('starts a range given only its end at the first of that month', async () => {
    const r = await call('list_transactions', { to: '2026-07-31' })
    expect(r).toMatchObject({ from: '2026-07-01', to: '2026-07-31' })
    expect(asked().searchParams.get('start_date')).toBe('2026-07-01')
  })

  it('narrows to an account by part of its name, and names the accounts there are when none matches', async () => {
    const r = await call('list_transactions', { account: '2up' })
    expect(r).toMatchObject({ account: '2up', matched: 1 })
    expect((r.transactions as { payee: string }[])[0].payee).toBe('Coles')
    const none = await call('list_transactions', { account: 'joint' })
    expect(String(none.error)).toContain('"joint"')
    expect(String(none.error)).toContain('Spending, 2Up Spending, Amex')
  })

  it('stops at the most one read takes, and says the range may hold more', async () => {
    const row = (id: number) => ({ id, date: '2026-08-15', payee: 'Coles', amount: -1, category: null, is_transfer: false })
    fetchMock.mockImplementation(async (url: URL) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith('/me')) return json({ id: 42 })
      return json(Array.from({ length: Number(u.searchParams.get('per_page')) }, (_, i) => row(i)))
    })
    const r = await call('list_transactions', { from: '2025-07-01', to: '2026-06-30' })
    expect(r.matched).toBe(ps.MAX_TRANSACTIONS)
    expect(String(r.incomplete)).toContain(`${ps.MAX_TRANSACTIONS} transactions`)
  })

  it('surfaces a provider error instead of throwing', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).endsWith('/me') ? json({ id: 42 }) : { ok: false, status: 502, text: async () => 'bad gateway' },
    )
    expect(String((await call('list_transactions', {})).error)).toContain('PocketSmith API 502')
  })
})

describe('pocketsmith client', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (url: URL) => {
      const u = String(url)
      if (u.endsWith('/me')) return json({ id: 42 })
      if (u.includes('/accounts')) {
        return json([
          { id: 1, title: 'NAB', type: 'bank', current_balance: 12.5, currency_code: 'aud', current_balance_date: '2026-08-27' },
          { id: 2, title: 'Wise', type: 'bank', current_balance: null, currency_code: 'usd', current_balance_date: null },
        ])
      }
      if (u.includes('/categories')) return json([{ title: 'Supermarket' }, { title: 'Transport' }])
      if (u.includes('/budget_summary')) {
        return json({
          income: { total_actual_amount: 1000, total_forecast_amount: 900, currency_code: 'aud' },
          expense: { total_actual_amount: -500, total_forecast_amount: -600, currency_code: 'aud' },
        })
      }
      if (u.includes('/budget')) {
        return json([
          { category: { title: 'Medical' }, is_budgeted: true, is_transfer: false, income: false, expense: { total_actual_amount: -300, total_forecast_amount: -100, total_over_by: 200, total_under_by: 0, start_date: '2026-08-01', end_date: '2026-08-31' } },
          { category: { title: 'Supermarket' }, is_budgeted: true, is_transfer: false, income: false, expense: { total_actual_amount: -200, total_forecast_amount: -500, total_over_by: 0, total_under_by: 300, start_date: '2026-08-01', end_date: '2026-08-31' } },
          { category: { title: 'Transfers', is_transfer: true }, is_transfer: false, income: false, expense: { total_actual_amount: -5000, total_forecast_amount: 0, total_over_by: 5000, total_under_by: 0, start_date: '2026-08-01', end_date: '2026-08-31' } },
          // Budgeted with rollover, and overspent earlier in the year: PocketSmith allows nothing this month.
          { category: { title: 'Shopping', rollover_type: 'above' }, is_budgeted: true, is_transfer: false, income: false, expense: { total_actual_amount: -177.43, total_forecast_amount: 0, total_over_by: 177.43, total_under_by: 0, start_date: '2026-08-01', end_date: '2026-08-31' } },
          // Budgeted on another cadence, nothing falling in this month.
          { category: { title: 'Car rego' }, is_budgeted: true, is_transfer: false, income: false, expense: { total_actual_amount: -20, total_forecast_amount: 0, total_over_by: 20, total_under_by: 0, start_date: '2026-08-01', end_date: '2026-08-31' } },
          // No budget at all, but spending: listed last, and never "over".
          { category: { title: 'Pets' }, is_budgeted: false, is_transfer: false, income: false, expense: { total_actual_amount: -900, total_forecast_amount: 0, total_over_by: 900, total_under_by: 0, start_date: '2026-08-01', end_date: '2026-08-31' } },
        ])
      }
      return json([])
    })
  })

  it('sends the developer key as a header, not a query param', async () => {
    await ps.listAccounts()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['X-Developer-Key']).toBe('ps-key')
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('ps-key')
  })

  it('normalises accounts, including one with no balance', async () => {
    const rows = await ps.listAccounts()
    expect(rows[0]).toMatchObject({ name: 'NAB', balance: 12.5, currency: 'aud' })
    expect(rows[1].balance).toBeNull()
  })

  it('lists category titles', async () => {
    expect(await ps.listCategories()).toEqual(['Supermarket', 'Transport'])
  })

  it('reports budget actual against forecast', async () => {
    const r = await call('budget_summary', {})
    expect(r.income).toEqual({ actual: '$1,000.00', forecast: '$900.00' })
    expect(r.expenses).toEqual({ actual: '-$500.00', forecast: '-$600.00', used: '83%' })
    expect(r.from).toBe('2026-08-01')
  })

  it('reports pacing: budget used, and days elapsed as of today', async () => {
    // ctx.now is 27 Aug; a whole-month range reads as progress, not 31/31.
    const r = await call('budget_summary', { from: '2026-08-01', to: '2026-08-31' })
    expect(r.period_progress).toBe('27 of 31 days (87% of the month)')
    expect((r.expenses as { used: string }).used).toBe('83%') // 500 of 600
  })

  it('caps elapsed days at the range end for a finished month', async () => {
    const r = await call('budget_summary', { from: '2026-07-01', to: '2026-07-31' })
    expect(r.period_progress).toBe('31 of 31 days (100% of the month)')
  })

  it('reports zero days elapsed for a month that has not started yet', async () => {
    const r = await call('budget_summary', { from: '2026-09-01', to: '2026-09-30' })
    expect(r.period_progress).toBe('0 of 30 days (0% of the month)')
  })

  it('skips month progress for a range spanning months, but still reports usage', async () => {
    const r = await call('budget_summary', { from: '2026-01-01', to: '2026-07-31' })
    expect(r.period_progress).toBeUndefined()
    expect((r.expenses as { used: string }).used).toBe('83%')
  })

  it('positions each budgeted category from PocketSmith\'s own analysis, transfers left out', async () => {
    const r = await call('budget_summary', {})
    const rows = r.budget_by_category as { category: string; position: string; budget_period: string }[]
    expect(rows[0]).toMatchObject({ category: 'Medical', position: 'over by $200.00', budget_period: '2026-08-01 to 2026-08-31' })
    expect(rows.find((x) => x.category === 'Supermarket')).toMatchObject({ position: 'under by $300.00' })
    expect(rows.map((x) => x.category)).not.toContain('Transfers')
  })

  it('never calls a budgeted category unbudgeted: a zero allowance is rollover or cadence, noted beside the overspend and named once together', async () => {
    const r = await call('budget_summary', {})
    const rows = r.budget_by_category as { category: string; position: string; forecast: string; note?: string }[]
    expect(rows.find((x) => x.category === 'Shopping')).toMatchObject({
      forecast: '$0.00',
      position: 'over by $177.43',
      note: 'nothing left this month after rollover',
    })
    expect(rows.find((x) => x.category === 'Car rego')).toMatchObject({ position: 'over by $20.00', note: 'nothing budgeted for this month' })
    expect(rows.find((x) => x.category === 'Pets')).toEqual(expect.not.objectContaining({ note: expect.anything() }))
    expect(rows.find((x) => x.category === 'Pets')?.position).toBe('no budget set')
    expect(rows.find((x) => x.category === 'Medical')).not.toHaveProperty('note')
    expect(rows.map((x) => x.position).join(' ')).not.toContain('unbudgeted')
    expect(r.rollover_used_up).toEqual(['Shopping'])
  })

  it('leaves the rollover list out when no category was used up by it', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).endsWith('/me')
        ? json({ id: 42 })
        : String(url).includes('/budget_summary')
          ? json({})
          : json([{ category: { title: 'Kids' }, is_budgeted: true, expense: { total_actual_amount: -10, total_forecast_amount: -100, total_over_by: 0, total_under_by: 90 } }]),
    )
    const r = await call('budget_summary', {})
    expect(r).not.toHaveProperty('rollover_used_up')
  })

  it('lists budgeted categories first, most over budget at the top, and spending with no budget last', async () => {
    const r = await call('budget_summary', {})
    const names = (r.budget_by_category as { category: string }[]).map((x) => x.category)
    expect(names.slice(0, 2)).toEqual(['Medical', 'Shopping'])
    expect(names.at(-1)).toBe('Pets')
  })

  it('positions and annotates a budget line from its own fields', () => {
    const base = { budgeted: true, rollsOver: false, forecast: 100, overBy: 0, underBy: 0 }
    expect(budgetPosition(base, 'AUD')).toBe('on budget')
    expect(budgetNote(base)).toBeUndefined()
    expect(budgetNote({ ...base, forecast: 0, rollsOver: true })).toBe('nothing left this month after rollover')
    expect(budgetNote({ ...base, forecast: 0 })).toBe('nothing budgeted for this month')
    expect(budgetPosition({ ...base, budgeted: false, forecast: 0, overBy: 50 }, 'AUD')).toBe('no budget set')
    expect(budgetNote({ ...base, budgeted: false, forecast: 0 })).toBeUndefined()
  })

  it('copes with a budget response missing a side entirely', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).endsWith('/me') ? json({ id: 42 }) : json({}),
    )
    const r = await call('budget_summary', {})
    expect(r.income).toEqual({ actual: '$0.00', forecast: '$0.00' })
  })

  it('reads a sparse budget line as an uncategorised zero over the asked range, and a non-list as nothing', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).endsWith('/me') ? json({ id: 42 }) : json([{ expense: {} }, { income: {} }]),
    )
    expect(await ps.budgetByCategory({ startDate: '2026-08-01', endDate: '2026-08-31' })).toEqual([
      { title: 'Uncategorised', actual: 0, forecast: 0, overBy: 0, underBy: 0, from: '2026-08-01', to: '2026-08-31', budgeted: false, rollsOver: false },
    ])
    fetchMock.mockImplementation(async (url: URL) => (String(url).endsWith('/me') ? json({ id: 42 }) : json({})))
    expect(await ps.budgetByCategory({ startDate: '2026-08-01', endDate: '2026-08-31' })).toEqual([])
  })

  it('keeps the labels and the bank\'s own wording, and reads a transaction with neither as having none', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).endsWith('/me')
        ? json({ id: 42 })
        : json([
            { id: 1, date: '2026-08-02', payee: 'Coles', original_payee: 'COLES 0123 RINGWOOD', amount: -5, labels: ['groceries', 7] },
            { id: 2, date: '2026-08-03', payee: 'Woolies', amount: -6 },
          ]),
    )
    const [labelled, bare] = await ps.listTransactions({ startDate: '2026-08-01', endDate: '2026-08-31' })
    expect(labelled).toMatchObject({ labels: ['groceries'], originalPayee: 'COLES 0123 RINGWOOD' })
    expect(bare).toMatchObject({ labels: [], originalPayee: null, note: null, memo: null })
  })

  it('asks for a page of 100 when no limit is given', async () => {
    fetchMock.mockImplementation(async (url: URL) => (String(url).endsWith('/me') ? json({ id: 42 }) : json([])))
    await ps.listTransactions({ startDate: '2026-08-01', endDate: '2026-08-31' })
    const asked = fetchMock.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.pathname.endsWith('/transactions'))!
    expect(asked.searchParams.get('per_page')).toBe('100')
  })

  it('surfaces an API error with its status', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).endsWith('/me') ? json({ id: 42 }) : { ok: false, status: 403, text: async () => 'nope' },
    )
    expect(String((await call('budget_summary', {})).error)).toContain('PocketSmith API 403')
  })

  it('refuses to run at all without a key', async () => {
    delete process.env.POCKETSMITH_DEVELOPER_KEY
    ps.resetUserCache()
    await expect(ps.listAccounts()).rejects.toThrow(/POCKETSMITH_DEVELOPER_KEY/)
  })
})
