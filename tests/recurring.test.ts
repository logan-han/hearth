import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import type { ToolContext } from '@/lib/tools/context'
import { findRecurring, payeeKey, daysBetween, changedLately, type Payment } from '@/lib/recurring'

const { moneyTools } = await import('@/lib/tools/money')
const ps = await import('@/lib/providers/pocketsmith')

/** Paid every `days` from `start`, `times` times, at `amount` unless the list says otherwise. */
function every(payee: string, start: string, days: number, times: number, amount: number | number[]): Payment[] {
  return Array.from({ length: times }, (_, i) => ({
    date: new Date(Date.parse(`${start}T00:00:00Z`) + i * days * 86_400_000).toISOString().slice(0, 10),
    payee,
    amount: Array.isArray(amount) ? amount[i] : amount,
  }))
}

describe('finding what is paid on a rhythm', () => {
  it('knows a payee however the feed spells it on the day', () => {
    expect(payeeKey('NETFLIX.COM 866-579')).toBe(payeeKey('Netflix.com'))
    expect(payeeKey('Origin Energy Holdings Ltd Melbourne')).toBe('origin energy holdings')
    expect(payeeKey('42 7')).toBe('')
  })

  it('finds a monthly subscription, its price rise, and when the next is due', () => {
    const found = findRecurring(every('Netflix', '2026-04-05', 30, 6, [16.99, 16.99, 16.99, 16.99, 16.99, 18.99]), '2026-10-10')
    expect(found).toEqual([
      expect.objectContaining({
        payee: 'Netflix', cadence: 'monthly', count: 6, typical: 16.99, lastAmount: 18.99, previousAmount: 16.99,
        last: '2026-09-02', next: '2026-10-02', monthly: 16.99, overdue: false, fresh: false,
      }),
    ])
  })

  it('tells weekly, fortnightly, quarterly and yearly apart, and orders them by what they cost a month', () => {
    const found = findRecurring([
      ...every('Cleaner', '2026-07-01', 7, 6, 80),
      ...every('Gym', '2026-05-01', 14, 8, 30),
      ...every('Water', '2026-01-10', 91, 3, 210),
      ...every('Car rego', '2025-03-01', 365, 2, 850),
    ], '2026-08-12')
    expect(found.map((r) => [r.payee, r.cadence, r.monthly])).toEqual([
      ['Cleaner', 'weekly', 346.67],
      ['Car rego', 'yearly', 70.83],
      ['Water', 'quarterly', 70],
      ['Gym', 'fortnightly', 65],
    ])
  })

  it('calls nothing recurring on two coincidences, an uneven rhythm, or money coming in', () => {
    expect(findRecurring(every('Bakery', '2026-08-01', 30, 2, 12), '2026-09-15')).toEqual([])
    expect(findRecurring([
      { date: '2026-01-01', payee: 'Hardware', amount: 50 },
      { date: '2026-01-29', payee: 'Hardware', amount: 50 },
      { date: '2026-03-20', payee: 'Hardware', amount: 50 },
      { date: '2026-03-27', payee: 'Hardware', amount: 50 },
    ], '2026-04-01')).toEqual([])
    expect(findRecurring(every('Refund', '2026-01-01', 30, 4, -20), '2026-05-01')).toEqual([])
    expect(findRecurring([{ date: '2026-01-01', payee: '##', amount: 9 }], '2026-05-01')).toEqual([])
    expect(findRecurring([{ date: '2026-01-01', payee: 'Plumber', amount: 300 }], '2026-05-01')).toEqual([])
  })

  it('counts two charges on one day as one payment, marks one that has not come, and one just found', () => {
    const doubled = [...every('Spotify', '2026-03-03', 30, 4, 13.99), { date: '2026-03-03', payee: 'Spotify', amount: 13.99 }]
    const [late] = findRecurring(doubled, '2026-08-20')
    expect(late).toMatchObject({ count: 4, overdue: true })
    const [fresh] = findRecurring(every('Stan', '2026-07-01', 30, 3, 12), '2026-08-31')
    expect(fresh).toMatchObject({ fresh: true, overdue: false })
    expect(fresh.previousAmount).toBeUndefined()
  })

  it('counts days by the calendar', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30)
  })
})

describe('what changed over the month', () => {
  // As the monthly check sees each: the tool's own rows, from real detection.
  const rows = (payments: Payment[], today: string) =>
    findRecurring(payments, today).map((r) => ({
      payee: r.payee,
      last_paid_on: r.last,
      ...(r.previousAmount !== undefined ? { price_change: 'x' } : {}),
      ...(r.fresh ? { new: 'x' } : {}),
      ...(r.overdue ? { overdue: 'x', overdue_since: r.overdueSince } : {}),
    }))

  it('reports a monthly payment that stopped in the month it became overdue, and only then', () => {
    // Paid monthly until 27 Aug; due 26 Sep; overdue from 12 Oct.
    const gym = every('Gym', '2026-04-29', 30, 5, 60)
    expect(gym.at(-1)!.date).toBe('2026-08-27')
    expect(findRecurring(gym, '2026-10-01')[0].overdueSince).toBe('2026-10-12')
    expect(changedLately(rows(gym, '2026-10-01'), '2026-10-01')).toEqual([])
    expect(changedLately(rows(gym, '2026-11-01'), '2026-11-01').map((r) => r.payee)).toEqual(['Gym'])
    expect(changedLately(rows(gym, '2026-12-01'), '2026-12-01')).toEqual([])
  })

  it('reports a quarterly or yearly one that stopped, which a month-long look at its due date would never catch', () => {
    const water = every('Water', '2026-01-10', 91, 3, 210)
    const overdueFrom = findRecurring(water, '2027-01-01')[0].overdueSince
    expect(changedLately(rows(water, overdueFrom), overdueFrom).map((r) => r.payee)).toEqual(['Water'])
    const rego = every('Car rego', '2024-03-01', 365, 2, 850)
    const since = findRecurring(rego, '2026-01-01')[0].overdueSince
    expect(changedLately(rows(rego, since), since).map((r) => r.payee)).toEqual(['Car rego'])
  })

  it('reports a price change at a payment this month, and not one from months ago', () => {
    const netflix = every('Netflix', '2026-04-05', 30, 6, [16.99, 16.99, 16.99, 16.99, 16.99, 18.99])
    expect(changedLately(rows(netflix, '2026-09-30'), '2026-09-30').map((r) => r.payee)).toEqual(['Netflix'])
    expect(changedLately(rows(netflix, '2026-11-20'), '2026-11-20').every((r) => r.payee !== 'Netflix' || r.overdue_since)).toBe(true)
  })
})

describe('recurring_payments', () => {
  const fetchMock = vi.fn()
  let client: PGlite
  let ctx: ToolContext
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
  const call = (args: Record<string, unknown>) => {
    const tools = moneyTools(ctx) as Record<string, { execute: unknown; inputSchema: { parse: (a: unknown) => unknown } }>
    return (tools.recurring_payments.execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(tools.recurring_payments.inputSchema.parse(args), {})
  }
  const asFeed = (payments: Payment[], over: Record<string, unknown> = {}) =>
    payments.map((p, i) => ({ id: i + 1, date: p.date, payee: p.payee, amount: -p.amount, category: { title: 'Bills' }, is_transfer: false, ...over }))
  const serve = (txns: unknown[]) =>
    fetchMock.mockImplementation(async (url: URL) => {
      const u = String(url)
      if (u.endsWith('/me')) return json({ id: 42 })
      if (u.includes('/transactions')) return json(txns)
      return json([])
    })

  beforeEach(async () => {
    process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
    process.env.POCKETSMITH_DEVELOPER_KEY = 'ps-key'
    ps.resetUserCache()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    client = (await freshDb()).client
    ctx = { chatId: '-100', member: null, memberName: 'Rowan', now: new Date('2026-10-10T02:00:00Z'), notices: [] }
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeDb(client)
  })

  it('lists them with what they come to a month, what changed and what is overdue, over the year by default', async () => {
    serve([
      ...asFeed(every('Netflix', '2026-04-05', 30, 6, [16.99, 16.99, 16.99, 16.99, 16.99, 18.99])),
      ...asFeed(every('Stan', '2026-07-12', 30, 3, 12)),
      ...asFeed(every('Gym', '2026-01-02', 30, 5, 60)),
      // Money moved between the household's own accounts is not a bill, however steady.
      ...asFeed(every('To savings', '2026-04-01', 30, 6, 500), { is_transfer: true }),
    ])
    const r = await call({})
    expect(r).toMatchObject({ from: '2025-10-10', to: '2026-10-10', monthly_total: '$28.99' })
    const listed = r.recurring as Record<string, unknown>[]
    expect(listed.map((x) => x.payee)).toEqual(['Gym', 'Netflix', 'Stan'])
    expect(listed[0]).toMatchObject({ how_often: 'monthly', overdue: expect.stringContaining('may have been cancelled') })
    expect(listed[1]).toMatchObject({ usually: '$16.99', a_month: '$16.99', last_amount: '$18.99', price_change: '$16.99 to $18.99 at the last payment', next_due: '2026-10-02' })
    expect(listed[2]).toMatchObject({ new: 'first paid 2026-07-12' })
    expect(listed[0]).toMatchObject({ overdue_since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(String(fetchMock.mock.calls.find(([u]) => String(u).includes('/transactions'))![0])).toContain('start_date=2025-10-10')
  })

  it('calls a quarterly bill new in the month it is first found, a hundred days after its first payment or not', async () => {
    serve(asFeed(every('Council rates', '2026-04-01', 91, 2, 520)))
    ctx = { ...ctx, now: new Date('2026-07-20T02:00:00Z') }
    const [rates] = (await call({})).recurring as Record<string, unknown>[]
    expect(rates).toMatchObject({ how_often: 'quarterly', new: 'first paid 2026-04-01' })
  })

  it('narrows to a payee, says when the read stopped short, and reports a feed that fails', async () => {
    serve(asFeed([...every('Netflix', '2026-04-05', 30, 6, 16.99), ...every('Stan', '2026-07-12', 30, 3, 12)]))
    expect(((await call({ search: 'stan', months: 6 })).recurring as unknown[]).length).toBe(1)
    fetchMock.mockImplementation(async (url: URL) => (String(url).endsWith('/me') ? json({ id: 42 }) : { ok: false, status: 500, json: async () => ({}), text: async () => 'down' }))
    expect(String((await call({})).error)).toMatch(/500|down/)
  })
})
