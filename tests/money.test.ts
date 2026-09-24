import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import { getSetting } from '@/lib/db/queries'
import { commitCursors } from '@/lib/tools/cursor'
import type { ToolContext } from '@/lib/tools/context'

const { moneyTools, budgetPosition, budgetNote } = await import('@/lib/tools/money')
const up = await import('@/lib/providers/up')
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

const upAccounts = {
  data: [
    { id: 'ind', attributes: { displayName: 'Spending', accountType: 'TRANSACTIONAL', ownershipType: 'INDIVIDUAL', balance: { value: '10.00', currencyCode: 'AUD' } } },
    { id: 'joint', attributes: { displayName: '2Up Spending', accountType: 'TRANSACTIONAL', ownershipType: 'JOINT', balance: { value: '1500.50', currencyCode: 'AUD' } } },
  ],
}

const upTxn = (id: string, amount: string, createdAt: string, desc = 'Coles') => ({
  id,
  attributes: {
    description: desc, message: null, status: 'SETTLED',
    amount: { value: amount, currencyCode: 'AUD' },
    createdAt, settledAt: createdAt,
    performingCustomer: { displayName: '$rowanhale' },
  },
  relationships: { account: { data: { id: 'joint' } } },
})

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.UP_API_TOKEN = 'up:yeah:test'
  process.env.POCKETSMITH_DEVELOPER_KEY = 'ps-key'
  ps.resetUserCache()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  client = (await freshDb()).client
  ctx = { chatId: '-100', member: null, memberName: 'Rowan', now: NOW, notices: [] }
})
afterEach(async () => { vi.unstubAllGlobals(); await closeDb(client) })

describe('configuration', () => {
  it('reports each integration independently', () => {
    expect(up.upConfigured()).toBe(true)
    delete process.env.UP_API_TOKEN
    expect(up.upConfigured()).toBe(false)
    expect(ps.pocketsmithConfigured()).toBe(true)
  })

  it('says so rather than throwing when nothing is configured', async () => {
    delete process.env.UP_API_TOKEN
    delete process.env.POCKETSMITH_DEVELOPER_KEY
    expect(String((await call('list_bank_accounts', {})).error)).toContain('No bank integration')
    expect(String((await call('list_transactions', { limit: 5 })).error)).toContain('Up Bank')
    expect(String((await call('budget_summary', {})).error)).toContain('PocketSmith')
    expect(String((await call('spending_summary', { source: 'up' })).error)).toContain('Up Bank')
    expect(String((await call('spending_summary', { source: 'pocketsmith' })).error)).toContain('PocketSmith')
    expect(String((await call('new_transactions', {})).error)).toContain('Up Bank')
  })
})

describe('accounts', () => {
  it('flags the JOINT account as shared and formats balances', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('up.com.au') ? json(upAccounts) : json([]),
    )
    const r = await call('list_bank_accounts', {})
    const accounts = r.up as { name: string; shared: boolean; balance: string }[]
    expect(accounts.find((a) => a.name === '2Up Spending')).toMatchObject({ shared: true, balance: '$1,500.50' })
    expect(accounts.find((a) => a.name === 'Spending')!.shared).toBe(false)
  })

  it('sends the Up token as a bearer', async () => {
    fetchMock.mockImplementation(async () => json(upAccounts))
    await up.listAccounts()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer up:yeah:test')
  })

  it('reports one provider failing without losing the other', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('up.com.au')
        ? { ok: false, status: 401, text: async () => 'unauthorised' }
        : json([{ id: 1, title: 'NAB', type: 'bank', current_balance: 5, currency_code: 'aud', current_balance_date: '2026-08-27' }]),
    )
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 401, text: async () => 'unauthorised' }))
    const r = await call('list_bank_accounts', {})
    expect(String((r.up as { error: string }).error)).toContain('401')
  })

  it('reports pocketsmith failing without losing up', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('up.com.au') ? json(upAccounts) : { ok: false, status: 500, text: async () => 'ps down' },
    )
    const r = await call('list_bank_accounts', {})
    expect(String((r.pocketsmith as { error: string }).error)).toContain('500')
    expect((r.up as { name: string }[]).length).toBe(2)
  })

  it('reports a null pocketsmith balance as null, not a formatted currency string', async () => {
    fetchMock.mockImplementation(async (url: URL) => {
      const u = String(url)
      if (u.includes('up.com.au')) return json(upAccounts)
      if (u.endsWith('/me')) return json({ id: 42 })
      return json([{ id: 1, title: 'Wise', type: 'bank', current_balance: null, currency_code: 'usd', current_balance_date: null }])
    })
    const r = await call('list_bank_accounts', {})
    const accounts = r.pocketsmith as { name: string; balance: string | null }[]
    expect(accounts[0]).toMatchObject({ name: 'Wise', balance: null })
  })
})

describe('findAccount', () => {
  beforeEach(() => fetchMock.mockImplementation(async () => json(upAccounts)))

  it('matches "2up" to the shared account', async () => {
    expect((await up.findAccount('2up'))!.id).toBe('joint')
  })

  it('matches an exact name, a partial name and an id', async () => {
    expect((await up.findAccount('2Up Spending'))!.id).toBe('joint')
    expect((await up.findAccount('Home'))?.id).toBeUndefined()
    expect((await up.findAccount('ind'))!.id).toBe('ind')
  })

  it('falls back to the joint account for the word "joint"', async () => {
    expect((await up.findAccount('joint account'))!.id).toBe('joint')
  })

  it('returns nothing for a name it cannot place', async () => {
    expect(await up.findAccount('offshore')).toBeUndefined()
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
    const r = await call('spending_summary', { source: 'pocketsmith' })
    expect(r.from).toBe('2026-08-01')
    expect(r.to).toBe('2026-08-31')
  })

  it('excludes transfers, which would otherwise double the total', async () => {
    const r = await call('spending_summary', { source: 'pocketsmith' })
    expect(r.transactions).toBe(8)
    expect(r.spent).toBe('$275.00')
    expect(r.received).toBe('$1,000.00')
    expect(r.net).toBe('$665.00')
  })

  it('keeps a debit filed under income out of the spend: a deduction from income, said as such', async () => {
    const r = await call('spending_summary', { source: 'pocketsmith' })
    expect(r.deductions).toBe('$60.00')
    expect(r.net_income).toBe('$940.00')
    const cats = r.by_category as { category: string }[]
    expect(cats.map((c) => c.category)).not.toContain('Income')
    const largest = r.largest as { payee: string; counts_as?: string }[]
    expect(largest.find((t) => t.payee.startsWith('ZIPPAY'))?.counts_as).toBe('a deduction from income, not spend')
    expect(largest.find((t) => t.payee === 'Coles')?.counts_as).toBeUndefined()
  })

  it('nets a refund against the expense it refunds rather than counting it as income', async () => {
    const r = await call('spending_summary', { source: 'pocketsmith' })
    const cats = r.by_category as { category: string; amount: string }[]
    expect(cats.find((c) => c.category === 'Medical')).toMatchObject({ amount: '$50.00' })
    expect(r.received).toBe('$1,000.00')
  })

  it('says nothing about deductions when there are none', async () => {
    serve(psTxns.filter((t) => t.id !== 8))
    const r = await call('spending_summary', { source: 'pocketsmith' })
    expect(r.deductions).toBeUndefined()
    expect(r.net_income).toBeUndefined()
    expect(r.net).toBe('$725.00')
  })

  it('excludes transfer-category transactions without a trace, since their sum means nothing', async () => {
    const r = await call('spending_summary', { source: 'pocketsmith' })
    const cats = r.by_category as { category: string }[]
    expect(cats.map((c) => c.category)).not.toContain('Transfers')
    expect(r.transfers_excluded).toBeUndefined()
    const largest = r.largest as { payee: string }[]
    expect(largest.map((x) => x.payee)).not.toContain('Anz Cards')
  })

  it('breaks spending down by category, largest first', async () => {
    const r = await call('spending_summary', { source: 'pocketsmith' })
    const cats = r.by_category as { category: string; amount: string; share_of_spend: string }[]
    expect(cats[0]).toEqual({ category: 'Supermarket', amount: '$150.00', share_of_spend: '55%' })
    // No category kind to go by: a debit is spend.
    expect(cats.map((c) => c.category)).toContain('Uncategorised')
  })

  it('lists the largest outgoings with payee, category and note, salaries kept apart', async () => {
    const r = await call('spending_summary', { source: 'pocketsmith' })
    const largest = r.largest as { payee: string; amount: string; category: string; note: string | null }[]
    expect(largest[0]).toMatchObject({ payee: 'Coles', amount: '$100.00' })
    const zip = largest.find((t) => t.payee.startsWith('ZIPPAY'))
    expect(zip).toMatchObject({ note: 'Card ending 7031 - BAS', category: 'Income' })
    const credits = r.largest_credits as { payee: string; amount: string }[]
    expect(credits[0]).toMatchObject({ payee: 'Salary', amount: '$1,000.00' })
    expect(credits.map((c) => c.payee)).toEqual(['Salary', 'Medicare rebate'])
  })

  it('honours an explicit range', async () => {
    const r = await call('spending_summary', { from: '2026-07-01', to: '2026-07-31', source: 'pocketsmith' })
    expect(r.from).toBe('2026-07-01')
    const url = new URL(String(fetchMock.mock.calls.find(([u]) => String(u).includes('/transactions'))![0]))
    expect(url.searchParams.get('start_date')).toBe('2026-07-01')
  })

  it('asks for a page size the API will accept', async () => {
    await call('spending_summary', { source: 'pocketsmith' })
    const url = new URL(String(fetchMock.mock.calls.find(([u]) => String(u).includes('/transactions'))![0]))
    expect(Number(url.searchParams.get('per_page'))).toBeGreaterThanOrEqual(10)
    expect(Number(url.searchParams.get('per_page'))).toBeLessThanOrEqual(1000)
  })

  it('resolves the user id once and reuses it', async () => {
    await call('spending_summary', { source: 'pocketsmith' })
    await call('spending_summary', { source: 'pocketsmith' })
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/me'))).toHaveLength(1)
  })

  it('treats an uncategorised credit as income, not spend, and labels it Uncategorised among the largest credits', async () => {
    serve([{ id: 20, date: '2026-08-11', payee: 'Refund misc', amount: 30, category: null, is_transfer: false }])
    const r = await call('spending_summary', { source: 'pocketsmith' })
    expect(r.received).toBe('$30.00')
    expect(r.by_category).toEqual([])
    const credits = r.largest_credits as { payee: string; category: string }[]
    expect(credits[0]).toMatchObject({ payee: 'Refund misc', category: 'Uncategorised' })
  })
})

describe('spending_summary via Up', () => {
  it('sums the raw feed, which has no transfer flag', async () => {
    fetchMock.mockImplementation(async () =>
      json({ data: [upTxn('a', '-100.00', '2026-08-02T10:00:00+10:00'), upTxn('b', '250.00', '2026-08-03T10:00:00+10:00')], links: {} }),
    )
    const r = await call('spending_summary', { source: 'up' })
    expect(r.spent).toBe('$100.00')
    expect(r.received).toBe('$250.00')
    expect(r.net).toBe('$150.00')
  })

  it('surfaces a provider error instead of throwing', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, text: async () => 'down' }))
    expect(String((await call('spending_summary', { source: 'up' })).error)).toContain('500')
  })
})

describe('list_transactions', () => {
  it('names who made each 2Up purchase', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('/accounts/joint/transactions')
        ? json({ data: [upTxn('a', '-12.50', '2026-08-26T18:00:00+10:00', 'Coles')], links: {} })
        : json(upAccounts),
    )
    const r = await call('list_transactions', { account: '2up', limit: 5 })
    expect(r.account).toBe('2Up Spending')
    expect((r.transactions as { by: string; amount: string }[])[0]).toMatchObject({ by: '$rowanhale', amount: '-$12.50' })
  })

  it('refuses an account it cannot find', async () => {
    fetchMock.mockImplementation(async () => json(upAccounts))
    expect(String((await call('list_transactions', { account: 'swiss', limit: 5 })).error)).toContain('No Up account')
  })

  it('lists across all accounts when none is named, honouring an explicit date range', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('/transactions')
        ? json({ data: [upTxn('a', '-5.00', '2026-08-02T10:00:00+10:00')], links: {} })
        : json(upAccounts),
    )
    const r = await call('list_transactions', { from: '2026-08-01', to: '2026-08-05', limit: 5 })
    expect(r.account).toBe('all accounts')
    const url = new URL(String(fetchMock.mock.calls.find(([u]) => String(u).includes('/transactions'))![0]))
    expect(url.searchParams.get('filter[since]')).toBeTruthy()
    expect(url.searchParams.get('filter[until]')).toBeTruthy()
  })

  it('surfaces a provider error instead of throwing', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('/transactions') ? { ok: false, status: 500, text: async () => 'boom' } : json(upAccounts),
    )
    expect(String((await call('list_transactions', { limit: 5 })).error)).toContain('500')
  })
})

describe('new_transactions', () => {
  const feed = (...txns: ReturnType<typeof upTxn>[]) => ({ data: txns, links: {} })

  const wire = (txns: ReturnType<typeof upTxn>[]) =>
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('/transactions') ? json(feed(...txns)) : json(upAccounts),
    )

  it('looks back only a day on the first check, and remembers it looked once the result is delivered', async () => {
    wire([])
    const r = await call('new_transactions', { account: '2up', limit: 10 })
    expect(r.first_check).toBe(true)
    expect(r.count).toBe(0)
    expect(await getSetting('up_cursor:-100:joint')).toBeNull()
    await commitCursors(ctx.pendingCursors)
    expect(await getSetting('up_cursor:-100:joint')).toContain('at')
  })

  it('returns what is new and stages the marker, which moves only when committed', async () => {
    wire([upTxn('t1', '-10.00', '2026-08-27T11:00:00+10:00')])
    const first = await call('new_transactions', { account: '2up', limit: 10 })
    expect(first.count).toBe(1)
    expect(await getSetting('up_cursor:-100:joint')).toBeNull()
    await commitCursors(ctx.pendingCursors)
    const cursor = JSON.parse((await getSetting('up_cursor:-100:joint'))!)
    expect(cursor.ids).toContain('t1')
  })

  it('reports it again to a later run when the earlier one was never delivered', async () => {
    wire([upTxn('t1', '-10.00', '2026-08-27T11:00:00+10:00')])
    expect((await call('new_transactions', { account: '2up', limit: 10 })).count).toBe(1)
    // That run died before posting: nothing was committed, and the next run starts afresh.
    ctx = { ...ctx, pendingCursors: undefined }
    expect((await call('new_transactions', { account: '2up', limit: 10 })).count).toBe(1)
  })

  it('counts what does not fit rather than dropping it, and moves past it', async () => {
    const txns = Array.from({ length: 5 }, (_, i) => upTxn(`t${i}`, '-1.00', `2026-08-27T1${i}:00:00+10:00`))
    wire(txns.reverse())
    const r = await call('new_transactions', { account: '2up', limit: 3 })
    expect(r.count).toBe(3)
    expect(r.more_not_shown).toBe(2)
    expect(r.more_not_shown_is_at_least).toBeUndefined()
    await commitCursors(ctx.pendingCursors)
    const cursor = JSON.parse((await getSetting('up_cursor:-100:joint'))!)
    expect(new Date(cursor.at).toISOString()).toBe(new Date('2026-08-27T14:00:00+10:00').toISOString())
  })

  it('says the count is a floor when the look read as far as it goes', async () => {
    const txns = Array.from({ length: 51 }, (_, i) => upTxn(`t${i}`, '-1.00', new Date(Date.parse('2026-08-27T01:00:00Z') + i * 60_000).toISOString()))
    wire(txns.reverse())
    const r = await call('new_transactions', { account: '2up', limit: 1 })
    expect(r.count).toBe(1)
    expect(r.more_not_shown).toBe(50)
    expect(r.more_not_shown_is_at_least).toBe(true)
  })

  it('never posts the same transaction twice', async () => {
    wire([upTxn('t1', '-10.00', '2026-08-27T11:00:00+10:00')])
    expect((await call('new_transactions', { account: '2up', limit: 10 })).count).toBe(1)
    expect((await call('new_transactions', { account: '2up', limit: 10 })).count).toBe(0)
  })

  it('picks up a genuinely newer transaction after a quiet run', async () => {
    wire([upTxn('t1', '-10.00', '2026-08-27T11:00:00+10:00')])
    await call('new_transactions', { account: '2up', limit: 10 })
    wire([upTxn('t2', '-20.00', '2026-08-27T12:00:00+10:00'), upTxn('t1', '-10.00', '2026-08-27T11:00:00+10:00')])
    const r = await call('new_transactions', { account: '2up', limit: 10 })
    expect(r.count).toBe(1)
    expect((r.transactions as { amount: string }[])[0].amount).toBe('-$20.00')
  })

  it('keeps a separate marker per chat', async () => {
    wire([upTxn('t1', '-10.00', '2026-08-27T11:00:00+10:00')])
    await call('new_transactions', { account: '2up', limit: 10 })
    ctx = { ...ctx, chatId: '-200' }
    expect((await call('new_transactions', { account: '2up', limit: 10 })).count).toBe(1)
  })

  it('defaults to the shared account without being told', async () => {
    wire([])
    expect((await call('new_transactions', { limit: 10 })).account).toBe('2Up Spending')
  })

  it('flags a new, oversized payee against the account history, and says what typical looks like', async () => {
    const past = Array.from({ length: 12 }, (_, i) =>
      upTxn(`h${i}`, i % 2 ? '-12.50' : '-84.20', `2026-08-${String(10 + i).padStart(2, '0')}T18:00:00+10:00`, i % 2 ? 'Corner Cafe' : 'Grocer 0812 Hillside'),
    )
    const lisbon = upTxn('s1', '-389.60', '2026-08-27T11:00:00+10:00', 'FARESAVER LISBON')
    const grocer = upTxn('c1', '-60.00', '2026-08-27T11:30:00+10:00', 'Grocer 0812 Hillside')
    wire([lisbon, grocer, ...past])
    const r = await call('new_transactions', { account: '2up', limit: 10 })
    const rows = r.transactions as { description: string; flags: string[] }[]
    expect(rows.find((t) => t.description === 'FARESAVER LISBON')?.flags).toEqual(['new_payee', 'unusually_large'])
    expect(rows.find((t) => t.description === 'Grocer 0812 Hillside')?.flags).toEqual([])
    expect(r.typical_debit).toBe('$48.35')
    expect(r.history_days).toBe(90)
  })

  it('refuses an account it cannot find', async () => {
    wire([])
    expect(String((await call('new_transactions', { account: 'swiss', limit: 10 })).error)).toContain('No Up account')
  })

  it('surfaces a provider error instead of throwing', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('/transactions') ? { ok: false, status: 500, text: async () => 'boom' } : json(upAccounts),
    )
    expect(String((await call('new_transactions', { account: '2up', limit: 10 })).error)).toContain('500')
  })

  it('finds the newest transaction by timestamp even when it is not last in the feed', async () => {
    wire([upTxn('newer', '-15.00', '2026-08-27T14:00:00+10:00'), upTxn('older', '-5.00', '2026-08-27T13:00:00+10:00')])
    await call('new_transactions', { account: '2up', limit: 10 })
    await commitCursors(ctx.pendingCursors)
    const cursor = JSON.parse((await getSetting('up_cursor:-100:joint'))!)
    expect(new Date(cursor.at).toISOString()).toBe(new Date('2026-08-27T14:00:00+10:00').toISOString())
  })

  it('keeps the transactions when the history read fails', async () => {
    let calls = 0
    fetchMock.mockImplementation(async (url: URL) => {
      if (!String(url).includes('/transactions')) return json(upAccounts)
      calls++
      if (calls === 1) return json(feed(upTxn('t1', '-10.00', '2026-08-27T11:00:00+10:00')))
      return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = await call('new_transactions', { account: '2up', limit: 10 })
    expect(r.count).toBe(1)
    expect((r.transactions as { flags: string[] }[])[0].flags).toEqual([])
    expect(r.typical_debit).toBeUndefined()
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

describe('up pagination', () => {
  it('follows the next link until it has enough', async () => {
    let page = 0
    fetchMock.mockImplementation(async (url: URL) => {
      if (!String(url).includes('/transactions')) return json(upAccounts)
      page += 1
      return json({
        data: [upTxn(`p${page}`, '-1.00', `2026-08-0${page}T10:00:00+10:00`)],
        links: { next: page < 3 ? 'https://api.up.com.au/api/v1/transactions?page=2' : null },
      })
    })
    const out = await up.listTransactions({ limit: 3 })
    expect(out).toHaveLength(3)
    expect(page).toBe(3)
  })

  it('stops at the requested limit even with more pages waiting', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('/transactions')
        ? json({
            data: [upTxn('a', '-1.00', '2026-08-01T10:00:00+10:00'), upTxn('b', '-2.00', '2026-08-02T10:00:00+10:00')],
            links: { next: 'https://api.up.com.au/api/v1/transactions?page=2' },
          })
        : json(upAccounts),
    )
    expect(await up.listTransactions({ limit: 1 })).toHaveLength(1)
  })

  it('passes date and status filters through', async () => {
    fetchMock.mockImplementation(async () => json({ data: [], links: {} }))
    await up.listTransactions({
      since: new Date('2026-08-01T00:00:00Z'),
      until: new Date('2026-08-31T00:00:00Z'),
      status: 'SETTLED',
    })
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.searchParams.get('filter[since]')).toBe('2026-08-01T00:00:00.000Z')
    expect(url.searchParams.get('filter[status]')).toBe('SETTLED')
  })

  it('refuses to run at all without a token', async () => {
    delete process.env.UP_API_TOKEN
    await expect(up.listAccounts()).rejects.toThrow(/UP_API_TOKEN/)
  })
})

describe('toTransaction mapping', () => {
  it('maps a sparse transaction with no relationships, settlement time or performing customer', async () => {
    fetchMock.mockImplementation(async (url: URL) =>
      String(url).includes('/transactions')
        ? json({
            data: [
              {
                id: 'sparse1',
                attributes: {
                  description: 'ATM Withdrawal',
                  amount: { value: '-40.00', currencyCode: 'AUD' },
                  status: 'HELD',
                  createdAt: '2026-08-27T09:00:00+10:00',
                },
              },
            ],
            links: {},
          })
        : json(upAccounts),
    )
    const [t] = await up.listTransactions({})
    expect(t).toMatchObject({
      settledAt: null, performedBy: null, accountId: null, category: null, parentCategory: null,
    })
  })
})
