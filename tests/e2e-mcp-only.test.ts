import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import { jar } from './helpers/next-headers'

/**
 * A fresh deployment from start to finish, with nothing but the bootstrap in
 * the environment: an admin signs in, adds the family, a member signs in,
 * makes a key on the web, connects a client, and reads who they are, the
 * family calendar and the money; a revoked key is then turned away. Every
 * route and query here is the real one, against a real Postgres; only the
 * bank's API answers from a recording.
 */

vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))

const { POST: MCP } = await import('@/app/api/mcp/route')
const { POST: MAKE_KEY, DELETE: REVOKE_KEY } = await import('@/app/api/mcp-keys/route')
const { POST: SAVE_MEMBER } = await import('@/app/api/admin/members/route')
const { GET: RESOURCE } = await import('@/app/.well-known/oauth-protected-resource/api/mcp/route')
const { GET: AUTH_SERVER } = await import('@/app/.well-known/oauth-authorization-server/route')
const { createSession, destroySession } = await import('@/lib/auth/session')
const { resetHydration, MANAGED_KEYS } = await import('@/lib/settings')
const { resetUserCache } = await import('@/lib/providers/pocketsmith')

let client: PGlite
const fetchMock = vi.fn()

/** One JSON-RPC call over the streamable HTTP transport, however it answers. */
async function rpc(method: string, params: unknown, key?: string) {
  const res = await MCP(
    new Request('https://hearth.example/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const body = await res.text()
  const json = body.includes('data:')
    ? JSON.parse(body.split('\n').find((l) => l.startsWith('data:'))!.slice(5))
    : body && JSON.parse(body)
  return { status: res.status, headers: res.headers, json }
}

const call = async (name: string, args: Record<string, unknown>, key: string) => {
  const { status, json } = await rpc('tools/call', { name, arguments: args }, key)
  expect(status).toBe(200)
  expect(json.result.isError, json.result.content?.[0]?.text).toBeFalsy()
  return json.result.content[0].text as string
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })

/** The bank, as PocketSmith answers it: one week's payment, and a budget a rollover has used up. */
function pocketsmith(url: URL) {
  if (url.pathname.endsWith('/me')) return json({ id: 1 })
  if (url.pathname.endsWith('/transactions')) {
    return json([
      { id: 9, date: '2026-11-18', payee: 'GROCER HILLSIDE', amount: -82.5, category: { title: 'Groceries', refund_behaviour: 'credits_are_refunds' }, transaction_account: { name: 'Everyday' } },
    ])
  }
  if (url.pathname.endsWith('/budget_summary')) {
    return json({
      expense: { total_actual_amount: -82.5, total_forecast_amount: -600, currency_code: 'aud' },
      income: { total_actual_amount: 0, total_forecast_amount: 0, currency_code: 'aud' },
    })
  }
  if (url.pathname.endsWith('/budget')) {
    return json([
      // Overspent earlier in the year: still budgeted, allowed nothing this month.
      { is_budgeted: true, category: { title: 'Shopping' }, expense: { total_actual_amount: -40, total_forecast_amount: 0, total_over_by: 40, total_under_by: 0, start_date: '2026-11-01', end_date: '2026-11-30' } },
      { is_budgeted: true, category: { title: 'Groceries' }, expense: { total_actual_amount: -82.5, total_forecast_amount: -600, total_over_by: 0, total_under_by: 517.5, start_date: '2026-11-01', end_date: '2026-11-30' } },
    ])
  }
  throw new Error(`unexpected PocketSmith call: ${url.pathname}`)
}

beforeEach(async () => {
  jar.store.clear()
  // Nothing of a chat anywhere: the bootstrap and the bank, and that is all.
  for (const key of Object.keys(process.env)) if (/^TELEGRAM_|^ALLOWED_TELEGRAM/.test(key)) delete process.env[key]
  for (const key of MANAGED_KEYS) delete process.env[key]
  process.env.TOKEN_ENC_KEY = 'b'.repeat(64)
  process.env.ADMIN_EMAILS = 'rowan@hearth.example'
  process.env.APP_URL = 'https://hearth.example'
  process.env.POCKETSMITH_DEVELOPER_KEY = 'ps-key'
  process.env.TIMEZONE = 'Australia/Melbourne'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  resetHydration()
  resetUserCache()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: string | URL) => pocketsmith(new URL(String(input))))
  vi.stubGlobal('fetch', fetchMock)
  client = (await freshDb()).client
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await closeDb(client)
})

describe('a fresh MCP-only deployment', () => {
  it('goes from sign-in to a connected client reading the household, and a revoked key is turned away', async () => {
    expect(Object.keys(process.env).filter((k) => /TELEGRAM/.test(k))).toEqual([])

    // The bootstrap admin signs in and adds the family by the addresses they sign in with.
    await createSession({ email: 'rowan@hearth.example', name: 'rowan@hearth.example', provider: 'google', role: 'admin' })
    for (const person of [
      { name: 'Rowan', email: 'rowan@hearth.example', isAdmin: true },
      { name: 'Sam', email: 'sam@hearth.example' },
    ]) {
      const res = await SAVE_MEMBER(new Request('https://hearth.example/api/admin/members', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...person, allowed: true }),
      }))
      expect(res.status).toBe(200)
    }

    // Rowan, now a member, makes a key for Claude Code on Home.
    await destroySession()
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
    const made = await MAKE_KEY(new Request('https://hearth.example/api/mcp-keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Claude Code' }),
    }))
    expect(made.status).toBe(200)
    const { key, connect, made: row } = (await made.json()) as { key: string; connect: string; made: { id: number } }
    expect(key).toMatch(/^\d+\.[\w-]+\.[\w-]{43}$/)
    expect(connect).toBe(`claude mcp add --transport http hearth https://hearth.example/api/mcp --header "Authorization: Bearer ${key}"`)

    // The client connects with it.
    const listed = await rpc('tools/list', {}, key)
    expect(listed.status).toBe(200)
    const names = listed.json.result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['hearth_context', 'list_family_events', 'morning_brief', 'money_snapshot', 'list_reports']))

    // Who it is, and the household it reads.
    const context = await call('hearth_context', {}, key)
    expect(context).toContain('You are acting as Rowan, an admin of this household.')
    expect(context).toContain('Family members and their linked accounts: Rowan (nothing linked); Sam (nothing linked).')

    // The family calendar, written and read back.
    await call('add_family_event', { title: 'Athletics carnival', start: '2026-12-03' }, key)
    const calendar = JSON.parse(await call('list_family_events', { from: '2026-12-01', to: '2026-12-07' }, key))
    expect(calendar.events.map((e: { title: string }) => e.title)).toEqual(['Athletics carnival'])

    // The money, with a rollover-exhausted category named as such, never as unbudgeted or over.
    const money = JSON.parse(await call('money_snapshot', {}, key))
    expect(money.budget.nothing_left_after_rollover).toEqual(['Shopping'])
    expect(money.budget.budget_by_category.find((c: { category: string }) => c.category === 'Shopping').position).toBe('nothing left after rollover')
    expect(money.budget).not.toHaveProperty('over_budget')
    expect(money.budget).not.toHaveProperty('no_budget_set')
    expect(money.how_to_read).toContain('nothing_left_after_rollover')

    // The client is pointed at OAuth metadata that is there, not a 404.
    const resource = await RESOURCE()
    expect(resource.status).toBe(200)
    expect(await resource.json()).toMatchObject({ resource: 'https://hearth.example/api/mcp', authorization_servers: ['https://hearth.example'] })
    expect((await AUTH_SERVER()).status).toBe(200)

    // Revoked on Home, the key is turned away at once.
    const revoked = await REVOKE_KEY(new Request(`https://hearth.example/api/mcp-keys?id=${row.id}`, { method: 'DELETE' }))
    expect(revoked.status).toBe(200)
    const after = await rpc('tools/list', {}, key)
    expect(after.status).toBe(401)
    expect(after.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/api/mcp')
  })
})
