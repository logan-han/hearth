/**
 * Up Bank (https://developer.up.com.au). One household token, not per member:
 * the API is read-only, so the worst it can do is tell you what you spent.
 */
const BASE = 'https://api.up.com.au/api/v1'

export type UpAccount = {
  id: string
  name: string
  type: string
  /** JOINT is a 2Up account, shared with a partner. */
  ownership: 'INDIVIDUAL' | 'JOINT' | string
  balance: number
  currency: string
}

export type UpTransaction = {
  id: string
  description: string
  message: string | null
  amount: number
  currency: string
  status: 'HELD' | 'SETTLED' | string
  createdAt: string
  settledAt: string | null
  category: string | null
  parentCategory: string | null
  /** On a 2Up account, which partner made the purchase. */
  performedBy: string | null
  accountId: string | null
}

export function upConfigured(): boolean {
  return Boolean(process.env.UP_API_TOKEN)
}

/** Up's own token-check endpoint; throws unless the token is alive. */
export async function ping(): Promise<void> {
  await api('/util/ping')
}

async function api<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const token = process.env.UP_API_TOKEN
  if (!token) throw new Error('Up Bank is not configured (UP_API_TOKEN missing).')

  const url = path.startsWith('http') ? new URL(path) : new URL(`${BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Up API ${res.status} on ${url.pathname}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

type Raw = { id: string; attributes: Record<string, any>; relationships?: Record<string, any> }
type Page<T> = { data: T[]; links?: { next?: string | null } }

function toAccount(r: Raw): UpAccount {
  const a = r.attributes
  return {
    id: r.id,
    name: a.displayName,
    type: a.accountType,
    ownership: a.ownershipType,
    balance: Number(a.balance.value),
    currency: a.balance.currencyCode,
  }
}

function toTransaction(r: Raw): UpTransaction {
  const a = r.attributes
  const rel = r.relationships ?? {}
  return {
    id: r.id,
    description: a.description,
    message: a.message ?? null,
    amount: Number(a.amount.value),
    currency: a.amount.currencyCode,
    status: a.status,
    createdAt: a.createdAt,
    settledAt: a.settledAt ?? null,
    category: rel.category?.data?.id ?? null,
    parentCategory: rel.parentCategory?.data?.id ?? null,
    performedBy: a.performingCustomer?.displayName ?? null,
    accountId: rel.account?.data?.id ?? null,
  }
}

export async function listAccounts(): Promise<UpAccount[]> {
  const page = await api<Page<Raw>>('/accounts', { 'page[size]': '30' })
  return page.data.map(toAccount)
}

/** Case-insensitive name match, so "2up" finds "2Up Spending". */
export async function findAccount(nameOrId: string): Promise<UpAccount | undefined> {
  const accounts = await listAccounts()
  const needle = nameOrId.trim().toLowerCase()
  return (
    accounts.find((a) => a.id === nameOrId) ??
    accounts.find((a) => a.name.toLowerCase() === needle) ??
    accounts.find((a) => a.name.toLowerCase().includes(needle)) ??
    (needle.includes('joint') || needle.includes('2up')
      ? accounts.find((a) => a.ownership === 'JOINT')
      : undefined)
  )
}

export async function listTransactions(opts: {
  accountId?: string
  since?: Date
  until?: Date
  status?: 'HELD' | 'SETTLED'
  limit?: number
}): Promise<UpTransaction[]> {
  const limit = Math.min(opts.limit ?? 50, 300)
  const params: Record<string, string> = { 'page[size]': String(Math.min(limit, 100)) }
  if (opts.since) params['filter[since]'] = opts.since.toISOString()
  if (opts.until) params['filter[until]'] = opts.until.toISOString()
  if (opts.status) params['filter[status]'] = opts.status

  const path = opts.accountId ? `/accounts/${opts.accountId}/transactions` : '/transactions'
  const out: UpTransaction[] = []
  let page = await api<Page<Raw>>(path, params)

  // Up paginates with an opaque `next` link; follow it until we have enough.
  for (;;) {
    out.push(...page.data.map(toTransaction))
    const next = page.links?.next
    if (!next || out.length >= limit) break
    page = await api<Page<Raw>>(next)
  }
  return out.slice(0, limit)
}
