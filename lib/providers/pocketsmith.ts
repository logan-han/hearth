/**
 * PocketSmith (https://developers.pocketsmith.com). Categorised transactions
 * and budgets across every account the household has connected there, which is
 * what makes "what did we spend on groceries" answerable.
 */
const BASE = 'https://api.pocketsmith.com/v2'

/** The API rejects anything outside this range outright. */
const MIN_PAGE = 10
const MAX_PAGE = 1000

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
  const perPage = Math.min(Math.max(opts.limit ?? 100, MIN_PAGE), MAX_PAGE)
  const rows = await api<any[]>(`/users/${await userId()}/transactions`, {
    start_date: opts.startDate,
    end_date: opts.endDate,
    per_page: String(perPage),
  })
  return rows.map((t) => ({
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
    needsReview: Boolean(t.needs_review),
  }))
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
  forecast: number
  overBy: number
  underBy: number
  from: string
  to: string
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
    .map((e) => ({
      title: e.category?.title ?? 'Uncategorised',
      actual: Math.abs(e.expense.total_actual_amount ?? 0),
      forecast: Math.abs(e.expense.total_forecast_amount ?? 0),
      overBy: e.expense.total_over_by ?? 0,
      underBy: e.expense.total_under_by ?? 0,
      from: e.expense.start_date ?? opts.startDate,
      to: e.expense.end_date ?? opts.endDate,
    }))
}
