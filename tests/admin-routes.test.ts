import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import { jar } from './helpers/next-headers'

vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))

const { GET, POST } = await import('@/app/api/admin/settings/route')
const { POST: LOGOUT } = await import('@/app/api/admin/logout/route')
const { createSession, readSession } = await import('@/lib/auth/session')
const { resetHydration, listSettings, MANAGED_KEYS } = await import('@/lib/settings')
const { startAuth, completeAuth } = await import('@/lib/oauth/flow')
const { signState, verifyState } = await import('@/lib/oauth/state')

const fetchMock = vi.fn()
let client: PGlite

const post = (body: unknown) =>
  POST(new Request('https://hearth.example/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

const signIn = () => createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.ADMIN_EMAILS = 'rowan@hearth.example'
  process.env.APP_URL = 'https://hearth.example'
  process.env.GOOGLE_CLIENT_ID = 'gid'
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  // A managed key left in process.env by one test would read as the
  // deployment's environment and be seeded into the next fresh store.
  for (const key of MANAGED_KEYS) delete process.env[key]
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

  it('refuses a time zone no clock knows, which would otherwise break every page, this one included', async () => {
    for (const value of ['Melbourne', 'Australia/Melbourn']) {
      const res = await post({ key: 'TIMEZONE', value })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('is not a time zone')
    }
    expect(process.env.TIMEZONE ?? '').not.toContain('Melbourn')
    const ok = await post({ key: 'TIMEZONE', value: ' Australia/Sydney\n' })
    expect(ok.status).toBe(200)
    expect(process.env.TIMEZONE).toBe('Australia/Sydney')
  })

  it('stores a time zone under its own name, and refuses an offset', async () => {
    expect((await post({ key: 'TIMEZONE', value: 'australia/perth' })).status).toBe(200)
    expect(process.env.TIMEZONE).toBe('Australia/Perth')
    const offset = await post({ key: 'TIMEZONE', value: '+08:00' })
    expect(offset.status).toBe(400)
    expect(process.env.TIMEZONE).toBe('Australia/Perth')
  })

  it('holds a setting with a fixed set of answers to that set, and trims what is pasted', async () => {
    const bad = await post({ key: 'UNITS', value: 'furlongs' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toContain('metric, imperial')
    expect((await post({ key: 'UNITS', value: 'imperial' })).status).toBe(200)
    expect((await post({ key: 'TAVILY_API_KEY', value: '  tvly-pasted\n' })).status).toBe(200)
    expect(process.env.TAVILY_API_KEY).toBe('tvly-pasted')
  })

  it('takes a name Hearth can go by, and nothing else', async () => {
    const bad = await post({ key: 'ASSISTANT_NAME', value: 'Pip the Great!' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toContain('one or two words of letters')
    expect((await post({ key: 'ASSISTANT_NAME', value: ' Pip ' })).status).toBe(200)
    expect(process.env.ASSISTANT_NAME).toBe('Pip')
  })

  it('refuses the chat bot settings that are gone, whatever is pasted', async () => {
    for (const key of ['TELEGRAM_BOT_TOKEN', 'ALLOWED_TELEGRAM_IDS', 'AMBIENT_MODE', 'ASSISTANT_PERSONA']) {
      const res = await post({ key, value: 'x' })
      expect(res.status, key).toBe(400)
      expect(process.env[key]).toBeUndefined()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a missing key and a malformed body', async () => {
    expect((await post({ value: 'x' })).status).toBe(400)
    const bad = await POST(new Request('https://hearth.example/api/admin/settings', { method: 'POST', body: 'not json' }))
    expect(bad.status).toBe(400)
  })

  it('treats an empty value, or none at all, as a reset', async () => {
    await post({ key: 'GEMINI_MODEL', value: 'temp' })
    expect((await post({ key: 'GEMINI_MODEL', value: '' })).status).toBe(200)
    expect(process.env.GEMINI_MODEL).toBeUndefined()
    await post({ key: 'GEMINI_MODEL', value: 'temp' })
    expect((await post({ key: 'GEMINI_MODEL' })).status).toBe(200)
    expect(process.env.GEMINI_MODEL).toBeUndefined()
    await post({ key: 'TIMEZONE', value: 'Australia/Perth' })
    expect((await post({ key: 'TIMEZONE', value: '' })).status).toBe(200)
    expect(process.env.TIMEZONE).toBeUndefined()
  })

  it('returns the refreshed list, still without secret values', async () => {
    const res = await post({ key: 'NOTION_TOKEN', value: 'ntn_supersecret' })
    const body = await res.text()
    expect(body).toContain('NOTION_TOKEN')
    expect(body).not.toContain('ntn_supersecret')
  })

  it('records who made the change', async () => {
    await post({ key: 'GEMINI_MODEL', value: 'x' })
    expect((await listSettings()).find((s) => s.key === 'GEMINI_MODEL')!.updatedBy).toBe('rowan@hearth.example')
  })

  it('answers 500 when the store cannot be written, rather than pretending', async () => {
    // Only the write fails: the admin check before it still reads the members table.
    const { db } = await import('@/lib/db')
    vi.spyOn(db(), 'insert').mockImplementation(() => { throw new Error('db exploded') })
    const res = await post({ key: 'GEMINI_MODEL', value: 'x' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('Could not save')
  })
})

describe('signing out', () => {
  const logout = (everywhere = false) =>
    LOGOUT(new Request('https://hearth.example/api/admin/logout', {
      method: 'POST',
      ...(everywhere ? { body: new URLSearchParams({ everywhere: '1' }) } : {}),
    }))

  /** A session signed in on some other browser, as its cookie. */
  const elsewhere = async () => {
    await createSession({ email: 'ada@hearth.example', name: 'Ada', provider: 'google', role: 'admin' })
    return jar.store.get('hearth_session')!
  }

  it('destroys the session and bounces to the sign-in screen', async () => {
    await signIn()
    expect(jar.store.has('hearth_session')).toBe(true)
    const res = await logout()
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://hearth.example/')
    expect(jar.store.has('hearth_session')).toBe(false)
  })

  it('leaves every other session alone when signing out one browser', async () => {
    const other = await elsewhere()
    await signIn()
    await logout()
    jar.store.set('hearth_session', other)
    expect(await readSession()).not.toBeNull()
  })

  it('signs every browser out, and voids every account link still under way, when an admin asks for everywhere', async () => {
    const other = await elsewhere()
    const link = await signState({ purpose: 'link', member: 1 }, '30m')
    await signIn()
    const res = await logout(true)
    expect(res.status).toBe(303)
    expect(jar.store.has('hearth_session')).toBe(false)
    jar.store.set('hearth_session', other)
    expect(await readSession()).toBeNull()
    await expect(verifyState(link)).rejects.toThrow()
  })

  it('signs only themselves out when someone who is not an admin asks for everywhere', async () => {
    const other = await elsewhere()
    await createSession({ email: 'kid@hearth.example', name: 'Kid', provider: 'google', role: 'member' })
    await logout(true)
    jar.store.set('hearth_session', other)
    expect(await readSession()).not.toBeNull()
  })
})

describe('admin sign-in through the shared OAuth callback', () => {
  const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.y`
  const tokenReply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })

  const callback = async (email: string, extra: Record<string, unknown> = {}) => {
    const state = await signState({ purpose: 'signin' }, '10m')
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a', id_token: idToken(email), ...extra }))
    return completeAuth(
      new Request(`https://hearth.example/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`),
      'google',
    )
  }

  it('starts without a session, unlike linking a mailbox', async () => {
    const res = await startAuth(new Request('https://hearth.example/api/oauth/google?signin=1'), 'google')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('accounts.google.com')
  })

  it('sends a link asked for without a session back to Connect', async () => {
    const res = await startAuth(new Request('https://hearth.example/api/oauth/google'), 'google')
    expect(res.headers.get('location')).toBe('https://hearth.example/connect')
  })

  it('signs a recognised address in and lands on the dashboard at the root', async () => {
    const res = await callback('rowan@hearth.example')
    expect(res.headers.get('location')).toBe('https://hearth.example/')
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
    await q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
    await callback('ada@hearth.example')
    const { readSession } = await import('@/lib/auth/session')
    expect((await readSession())?.role).toBe('member')
  })

  it('refuses when the provider will not say who signed in', async () => {
    const state = await signState({ purpose: 'signin' }, '10m')
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a' }))
    const res = await completeAuth(
      new Request(`https://hearth.example/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`),
      'google',
    )
    expect(res.status).toBe(400)
    expect(jar.store.has('hearth_session')).toBe(false)
  })

  it('does not need a refresh token, since it is not linking a mailbox', async () => {
    const res = await callback('rowan@hearth.example')
    expect(res.status).toBe(307)
  })

  it('links no mailbox, since Gmail and Calendar are linked through an agent client of their own', async () => {
    const q = await import('@/lib/db/queries')
    const member = await q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
    const res = await callback('ada@hearth.example', { refresh_token: 'rt-1', scope: 'openid email' })
    expect(res.status).toBe(307)
    expect(await q.connectionFor(member.id, 'google')).toBeUndefined()
  })

  it('never repoints an existing link at a different account', async () => {
    const q = await import('@/lib/db/queries')
    const member = await q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
    await q.saveConnection({ memberId: member.id, provider: 'google', email: 'other@gmail.com', refreshToken: 'rt-old', scopes: null })
    await callback('ada@hearth.example', { refresh_token: 'rt-new' })
    const conn = (await q.connectionFor(member.id, 'google'))!
    expect(conn.email).toBe('other@gmail.com')
    await expect(q.decryptRefreshToken(conn)).resolves.toBe('rt-old')
  })

  it('stores nothing for an ADMIN_EMAILS address with no member row', async () => {
    const res = await callback('rowan@hearth.example', { refresh_token: 'rt-1' })
    expect(res.status).toBe(307)
    const { db } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    const raw = await db().execute(sql`select count(*) as n from connections`)
    expect(Number((raw as unknown as { rows: { n: unknown }[] }).rows[0].n)).toBe(0)
  })

  it('cannot be reached by replaying a member link-state', async () => {
    // A link state takes the linking path, and is turned away for want of a
    // member behind it rather than creating a session.
    const state = await signState({ purpose: 'link', member: 1 }, '10m')
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a', id_token: idToken('rowan@hearth.example') }))
    const res = await completeAuth(
      new Request(`https://hearth.example/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`),
      'google',
    )
    expect(jar.store.has('hearth_session')).toBe(false)
    expect(res.status).toBe(400)
  })
})
