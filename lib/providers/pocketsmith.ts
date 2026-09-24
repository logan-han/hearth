/**
 * PocketSmith (https://developers.pocketsmith.com). Categorised transactions
 * and budgets across every account the household has connected there, which is
 * what makes "what did we spend on groceries" answerable.
 */
const BASE = 'https://api.pocketsmith.com/v2'

/** The API rejects anything outside this range outright. */
const MIN_PAGE = 10
const MAX_PAGE = 1000
/** The most one read pages through: five of the largest pages. */
export const MAX_TRANSACTIONS = 5000

export type PsAccount = {
  id: number
  name: string
  type: string
  balance: number | null
  currency: string
  balanceDate: string | null
}

export type PsTransaction = {
  id: number
  date: string
  payee: string
  amount: number
  category: string | null
  account: string | null
  note: string | null
  memo: string | null
  isTransfer: boolean
  /** PocketSmith marks whole categories as transfer buckets (e.g. "Transfers"). */
  categoryIsTransfer: boolean
  /**
   * Which side of the ledger the category keeps, in PocketSmith's own terms.
   * A category whose debits are deductions is income: a tax payment filed
   * there comes off income, and is not spend. A category whose credits are
   * refunds is expense: a rebate filed there comes off the spend. Null for a
   * transaction with no category, or one whose category says neither.
   */
  categoryKind: 'income' | 'expense' | null
  needsReview: boolean
}

export type PsBudgetSide = {
  totalActual: number
  totalForecast: number
  currency: string
}

export function pocketsmithConfigured(): boolean {
  return Boolean(process.env.POCKETSMITH_DEVELOPER_KEY)
}

async function api<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const key = process.env.POCKETSMITH_DEVELOPER_KEY
  if (!key) throw new Error('PocketSmith is not configured (POCKETSMITH_DEVELOPER_KEY missing).')

  const url = new URL(`${BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url, {
    headers: { 'X-Developer-Key': key, accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`PocketSmith API ${res.status} on ${url.pathname}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

let cachedUserId: number | null = null

/** The user id prefixes most paths, and never changes for a given key. */
export async function userId(): Promise<number> {
  if (cachedUserId === null) {
    cachedUserId = (await api<{ id: number }>('/me')).id
  }
  return cachedUserId
}

export function resetUserCache(): void {
  cachedUserId = null
}

export async function listAccounts(): Promise<PsAccount[]> {
  const rows = await api<any[]>(`/users/${await userId()}/accounts`)
  return rows.map((a) => ({
    id: a.id,
    name: a.title,
    type: a.type,
    balance: a.current_balance ?? null,
    currency: a.currency_code,
    balanceDate: a.current_balance_date ?? null,
  }))
}

export async function listCategories(): Promise<string[]> {
  const rows = await api<any[]>(`/users/${await userId()}/categories`)
  return rows.map((c) => c.title)
}

export async function listTransactions(opts: {
  startDate: string
  endDate: string
  limit?: number
}): Promise<PsTransaction[]> {
  const limit = Math.min(opts.limit ?? 100, MAX_TRANSACTIONS)
  const perPage = Math.min(Math.max(limit, MIN_PAGE), MAX_PAGE)
  const path = `/users/${await userId()}/transactions`
  const rows: any[] = []
  // PocketSmith pages by number, and only the last page comes back short;
  // one page alone would sum a long range as if its first thousand were all.
  for (let page = 1; ; page++) {
    const batch = await api<any[]>(path, {
      start_date: opts.startDate,
      end_date: opts.endDate,
      per_page: String(perPage),
      page: String(page),
    })
    rows.push(...batch)
    if (batch.length < perPage || rows.length >= limit) break
  }
  return rows.slice(0, limit).map((t) => ({
    id: t.id,
    date: t.date,
    payee: t.payee,
    amount: t.amount,
    category: t.category?.title ?? null,
    account: t.transaction_account?.name ?? null,
    note: t.note ?? null,
    memo: t.memo ?? null,
    isTransfer: Boolean(t.is_transfer),
    categoryIsTransfer: Boolean(t.category?.is_transfer),
    categoryKind: categoryKind(t.category?.refund_behaviour),
    needsReview: Boolean(t.needs_review),
  }))
}

/** PocketSmith's refund_behaviour, read as the side a category keeps. */
function categoryKind(behaviour: unknown): PsTransaction['categoryKind'] {
  if (behaviour === 'debits_are_deductions') return 'income'
  if (behaviour === 'credits_are_refunds') return 'expense'
  return null
}

export async function budgetSummary(opts: {
  startDate: string
  endDate: string
}): Promise<{ income: PsBudgetSide; expense: PsBudgetSide }> {
  const raw = await api<any>(`/users/${await userId()}/budget_summary`, {
    period: 'months',
    interval: '1',
    start_date: opts.startDate,
    end_date: opts.endDate,
  })
  const side = (s: any): PsBudgetSide => ({
    totalActual: s?.total_actual_amount ?? 0,
    totalForecast: s?.total_forecast_amount ?? 0,
    currency: s?.currency_code ?? 'aud',
  })
  return { income: side(raw?.income), expense: side(raw?.expense) }
}

export type PsCategoryBudget = {
  title: string
  actual: number
  /**
   * What PocketSmith allows for the period, which is the budget after any
   * rollover: a category overspent in earlier months can be allowed nothing
   * this month while still being budgeted, so a zero here never means
   * unbudgeted on its own. `budgeted` says that.
   */
  forecast: number
  overBy: number
  underBy: number
  from: string
  to: string
  /** Whether the category has a budget at all, in PocketSmith's own words. */
  budgeted: boolean
  /** Whether the category rolls a period's over- or underspend into the next. */
  rollsOver: boolean
}

/** Per-category budget analysis; PocketSmith precomputes over/under for us. */
export async function budgetByCategory(opts: { startDate: string; endDate: string }): Promise<PsCategoryBudget[]> {
  const raw = await api<any[]>(`/users/${await userId()}/budget`, {
    roll_up: 'true',
    start_date: opts.startDate,
    end_date: opts.endDate,
  })
  // The transfer marking lives on the category object here, not the entry.
  return (Array.isArray(raw) ? raw : [])
    .filter((e) => e?.expense && !e?.is_transfer && !e?.category?.is_transfer)
    .map((e) => {
      const forecast = Math.abs(e.expense.total_forecast_amount ?? 0)
      return {
        title: e.category?.title ?? 'Uncategorised',
        actual: Math.abs(e.expense.total_actual_amount ?? 0),
        forecast,
        overBy: e.expense.total_over_by ?? 0,
        underBy: e.expense.total_under_by ?? 0,
        from: e.expense.start_date ?? opts.startDate,
        to: e.expense.end_date ?? opts.endDate,
        // Absent only from a sparse reply; an allowance then means a budget.
        budgeted: typeof e.is_budgeted === 'boolean' ? e.is_budgeted : forecast !== 0,
        rollsOver: Boolean(e.category?.rollover_type),
      }
    })
}
