import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'

const jar = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    cookies: async () => ({
      get: (k: string) => (store.has(k) ? { value: store.get(k) } : undefined),
      set: (k: string, v: string) => void store.set(k, v),
      delete: (k: string) => void store.delete(k),
    }),
  }
})
vi.mock('next/headers', () => ({ cookies: jar.cookies }))
const send = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/telegram', () => ({ send, typing: vi.fn(), bot: vi.fn() }))

const { GET, POST } = await import('@/app/api/admin/settings/route')
const { POST: LOGOUT } = await import('@/app/api/admin/logout/route')
const { createSession } = await import('@/lib/auth/session')
const { resetHydration, listSettings } = await import('@/lib/settings')
const { startAuth, completeAuth } = await import('@/lib/oauth/flow')
const { signState } = await import('@/lib/oauth/state')

const fetchMock = vi.fn()
let client: PGlite

const post = (body: unknown) =>
  POST(new Request('https://hearth.han.life/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

const signIn = () => createSession({ email: 'logan@han.life', name: 'Logan', provider: 'google', role: 'admin' })

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.ADMIN_EMAILS = 'logan@han.life'
  process.env.APP_URL = 'https://hearth.han.life'
  process.env.GOOGLE_CLIENT_ID = 'gid'
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  resetHydration()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  client = (await freshDb()).client
})
afterEach(async () => { vi.unstubAllGlobals(); await closeDb(client) })

describe('the settings API requires a session', () => {
  it('refuses to read without one', async () => {
    expect((await GET()).status).toBe(401)
  })

  it('refuses to write without one', async () => {
    const res = await post({ key: 'TAVILY_API_KEY', value: 'x' })
    expect(res.status).toBe(401)
    expect(process.env.TAVILY_API_KEY).not.toBe('x')
  })

  it('reads once signed in', async () => {
    await signIn()
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).settings.length).toBeGreaterThan(0)
  })
})

describe('the settings API respects the allowlist', () => {
  beforeEach(signIn)

  it('writes a managed key', async () => {
    const res = await post({ key: 'TAVILY_API_KEY', value: 'tvly-new' })
    expect(res.status).toBe(200)
    expect(process.env.TAVILY_API_KEY).toBe('tvly-new')
  })

  it('refuses a key that would repoint the deployment', async () => {
    for (const key of ['DATABASE_URL', 'TOKEN_ENC_KEY', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_SECRET']) {
      const res = await post({ key, value: 'evil' })
      expect(res.status).toBe(400)
      expect(process.env[key]).not.toBe('evil')
    }
  })

  it('accepts the Telegram settings, which are dashboard-managed now', async () => {
    const res = await post({ key: 'ALLOWED_TELEGRAM_IDS', value: '111, 222' })
    expect(res.status).toBe(200)
    expect(process.env.ALLOWED_TELEGRAM_IDS).toBe('111, 222')
  })

  it('refuses a missing key and a malformed body', async () => {
    expect((await post({ value: 'x' })).status).toBe(400)
    const bad = await POST(new Request('https://hearth.han.life/api/admin/settings', { method: 'POST', body: 'not json' }))
    expect(bad.status).toBe(400)
  })

  it('treats an empty value as a reset', async () => {
    await post({ key: 'GEMINI_MODEL', value: 'temp' })
    expect((await post({ key: 'GEMINI_MODEL', value: '' })).status).toBe(200)
    expect(process.env.GEMINI_MODEL).toBeUndefined()
  })

  it('returns the refreshed list, still without secret values', async () => {
    const res = await post({ key: 'NOTION_TOKEN', value: 'ntn_supersecret' })
    const body = await res.text()
    expect(body).toContain('NOTION_TOKEN')
    expect(body).not.toContain('ntn_supersecret')
  })

  it('records who made the change', async () => {
    await post({ key: 'GEMINI_MODEL', value: 'x' })
    expect((await listSettings()).find((s) => s.key === 'GEMINI_MODEL')!.updatedBy).toBe('logan@han.life')
  })

  it('answers 500 when the store cannot be written, rather than pretending', async () => {
    const { __setDb } = await import('@/lib/db')
    __setDb({ insert: () => { throw new Error('db exploded') } })
    const res = await post({ key: 'GEMINI_MODEL', value: 'x' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('Could not save')
  })
})

describe('signing out', () => {
  it('destroys the session and bounces to the sign-in screen', async () => {
    await signIn()
    expect(jar.store.has('hearth_session')).toBe(true)
    const res = await LOGOUT()
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://hearth.han.life/')
    expect(jar.store.has('hearth_session')).toBe(false)
  })
})

describe('admin sign-in through the shared OAuth callback', () => {
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`
  const tokenReply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })

  const callback = async (email: string, extra: Record<string, unknown> = {}) => {
    const state = await signState({ tg: '', name: 'Administrator', chat: '', purpose: 'signin' }, '10m')
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a', id_token: idToken(email), ...extra }))
    return completeAuth(
      new Request(`https://hearth.han.life/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`),
      'google',
    )
  }

  it('starts without a link token, unlike the member flow', async () => {
    const res = await startAuth(new Request('https://hearth.han.life/api/oauth/google?signin=1'), 'google')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('accounts.google.com')
  })

  it('still refuses the member flow with no token', async () => {
    expect((await startAuth(new Request('https://hearth.han.life/api/oauth/google'), 'google')).status).toBe(400)
  })

  it('signs a recognised address in and lands on the dashboard at the root', async () => {
    const res = await callback('logan@han.life')
    expect(res.headers.get('location')).toBe('https://hearth.han.life/')
    expect(jar.store.has('hearth_session')).toBe(true)
  })

  it('turns an unrecognised address away without creating a session', async () => {
    const res = await callback('stranger@example.com')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('not recognised')
    expect(jar.store.has('hearth_session')).toBe(false)
  })

  it('signs an ordinary member in as a member, not an admin', async () => {
    const q = await import('@/lib/db/queries')
    await q.saveMember({ telegramUserId: '222', name: 'Ada', email: 'ada@han.life', allowed: true, isAdmin: false })
    await callback('ada@han.life')
    const { readSession } = await import('@/lib/auth/session')
    expect((await readSession())?.role).toBe('member')
  })

  it('refuses when the provider will not say who signed in', async () => {
    const state = await signState({ tg: '', name: 'Administrator', chat: '', purpose: 'signin' }, '10m')
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a' }))
    const res = await completeAuth(
      new Request(`https://hearth.han.life/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`),
      'google',
    )
    expect(res.status).toBe(400)
    expect(jar.store.has('hearth_session')).toBe(false)
  })

  it('does not need a refresh token, since it is not linking a mailbox', async () => {
    const res = await callback('logan@han.life')
    expect(res.status).toBe(307)
  })

  it('doubles as the mailbox link when the provider hands back a refresh token', async () => {
    const q = await import('@/lib/db/queries')
    await q.saveMember({ telegramUserId: '222', name: 'Ada', email: 'ada@han.life', allowed: true, isAdmin: false })
    const res = await callback('ada@han.life', { refresh_token: 'rt-1', scope: 'mail calendar' })
    expect(res.status).toBe(307)
    const member = (await q.memberByTelegramId('222'))!
    const conn = await q.connectionFor(member.id, 'google')
    expect(conn).toMatchObject({ provider: 'google', email: 'ada@han.life' })
  })

  it('never repoints an existing link at a different account', async () => {
    const q = await import('@/lib/db/queries')
    await q.saveMember({ telegramUserId: '222', name: 'Ada', email: 'ada@han.life', allowed: true, isAdmin: false })
    const member = (await q.memberByTelegramId('222'))!
    await q.saveConnection({ memberId: member.id, provider: 'google', email: 'other@gmail.com', refreshToken: 'rt-old', scopes: null })
    await callback('ada@han.life', { refresh_token: 'rt-new' })
    const conn = (await q.connectionFor(member.id, 'google'))!
    expect(conn.email).toBe('other@gmail.com')
    await expect(q.decryptRefreshToken(conn)).resolves.toBe('rt-old')
  })

  it('stores nothing for an ADMIN_EMAILS address with no member row', async () => {
    const res = await callback('logan@han.life', { refresh_token: 'rt-1' })
    expect(res.status).toBe(307)
    const { db } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    const raw = await db().execute(sql`select count(*) as n from connections`)
    expect(Number((raw as unknown as { rows: { n: unknown }[] }).rows[0].n)).toBe(0)
  })

  it('cannot be reached by replaying a member link-state', async () => {
    // A /connect state has purpose 'link', so it takes the linking path and is
    // rejected for want of a refresh token rather than creating a session.
    const state = await signState({ tg: '111', name: 'Logan', chat: '-100' }, '10m')
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a', id_token: idToken('logan@han.life') }))
    const res = await completeAuth(
      new Request(`https://hearth.han.life/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`),
      'google',
    )
    expect(jar.store.has('hearth_session')).toBe(false)
    expect(res.status).toBe(400)
  })
})
