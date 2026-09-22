import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

const send = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/telegram', () => ({ send, typing: vi.fn(), bot: vi.fn() }))

/** The signin branch signs a session cookie; give it somewhere to put one. */
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

const { startAuth, completeAuth } = await import('@/lib/oauth/flow')
const { signState } = await import('@/lib/oauth/state')
const { accessTokenFor, clearTokenCache, NotConnectedError } = await import('@/lib/providers/token')
const { clientsFor, clientFor } = await import('@/lib/providers')

const fetchMock = vi.fn()
let client: PGlite

const tokenReply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  process.env.GOOGLE_CLIENT_ID = 'gid'
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret'
  process.env.MS_CLIENT_ID = 'mid'
  process.env.MS_CLIENT_SECRET = 'msecret'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  clearTokenCache()
  client = (await freshDb()).client
})
afterEach(async () => { vi.unstubAllGlobals(); await closeDb(client) })

const req = (url: string) => new Request(url)

describe('startAuth', () => {
  it('bounces a valid link to the provider', async () => {
    const t = await signState({ tg: '111', name: 'Rowan', chat: '-100' })
    const res = await startAuth(req(`https://hearth.example/api/oauth/google?t=${encodeURIComponent(t)}`), 'google')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('accounts.google.com')
  })

  it('explains a missing token instead of redirecting', async () => {
    const res = await startAuth(req('https://hearth.example/api/oauth/google'), 'google')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('/connect')
  })

  it('explains an expired token', async () => {
    const t = await signState({ tg: '111', name: 'Rowan', chat: '' }, '0s')
    await new Promise((r) => setTimeout(r, 1100))
    const res = await startAuth(req(`https://hearth.example/api/oauth/google?t=${t}`), 'google')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('expired')
  })
})

describe('completeAuth', () => {
  const callbackUrl = async (extra = '') => {
    const state = await signState({ tg: '111', name: 'Rowan', chat: '-100' })
    return `https://hearth.example/api/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}${extra}`
  }

  it('stores an encrypted refresh token and tells the member', async () => {
    fetchMock.mockResolvedValueOnce(
      tokenReply({ access_token: 'a', refresh_token: 'r3fr3sh', scope: 's', id_token: idToken({ email: 'a@b.com' }) }),
    )
    const res = await completeAuth(req(await callbackUrl()), 'google')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('linked=google')

    const member = await q.memberByTelegramId('111')
    const conn = await q.connectionFor(member!.id, 'google')
    expect(conn!.email).toBe('a@b.com')
    expect(conn!.refreshToken).not.toContain('r3fr3sh')
    expect(await q.decryptRefreshToken(conn!)).toBe('r3fr3sh')
    expect(send).toHaveBeenCalledWith('111', expect.stringContaining('linked'))
  })

  it('refuses a grant with no refresh token, which would expire in an hour', async () => {
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a' }))
    const res = await completeAuth(req(await callbackUrl()), 'google')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('refresh token')
  })

  it('reports a provider-side denial', async () => {
    const res = await completeAuth(req('https://x/callback?error=access_denied'), 'google')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('access_denied')
  })

  it('rejects a callback missing code or state', async () => {
    expect((await completeAuth(req('https://x/callback?code=a'), 'google')).status).toBe(400)
    expect((await completeAuth(req('https://x/callback?state=b'), 'google')).status).toBe(400)
  })

  it('rejects a forged state', async () => {
    const res = await completeAuth(req('https://x/callback?code=a&state=forged'), 'google')
    expect(await res.text()).toContain('expired')
  })

  it('reports a failed code exchange without leaking the response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'invalid_grant' })
    const res = await completeAuth(req(await callbackUrl()), 'google')
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('Could not complete')
    expect(body).not.toContain('invalid_grant')
  })

  it('escapes html in the failure page', async () => {
    const res = await completeAuth(req('https://x/callback?error=%3Cscript%3E'), 'google')
    const body = await res.text()
    expect(body).not.toContain('<script>')
  })

  it('records the confirmation into the chat history once telegram has accepted it', async () => {
    fetchMock.mockResolvedValueOnce(
      tokenReply({ access_token: 'a', refresh_token: 'r3fr3sh', scope: 's', id_token: idToken({ email: 'a@b.com' }) }),
    )
    await completeAuth(req(await callbackUrl()), 'google')
    await vi.waitFor(async () => {
      const history = await q.messagesAfter('111', 0)
      expect(history.map((h) => h.content)).toEqual([expect.stringContaining('linked')])
    })
  })

  it('does not let a failed confirmation message affect the redirect', async () => {
    fetchMock.mockResolvedValueOnce(
      tokenReply({ access_token: 'a', refresh_token: 'r3fr3sh', scope: 's', id_token: idToken({ email: 'a@b.com' }) }),
    )
    send.mockRejectedValueOnce(new Error('telegram unreachable'))
    const res = await completeAuth(req(await callbackUrl()), 'google')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('linked=google')
    // Telegram never took it, so nothing goes into the history either.
    expect(await q.messagesAfter('111', 0)).toEqual([])
  })

  it('links without a scope on record when the provider does not return one', async () => {
    fetchMock.mockResolvedValueOnce(
      tokenReply({ access_token: 'a', refresh_token: 'r3fr3sh', id_token: idToken({ email: 'a@b.com' }) }),
    )
    await completeAuth(req(await callbackUrl()), 'google')
    const member = await q.memberByTelegramId('111')
    const conn = await q.connectionFor(member!.id, 'google')
    expect(conn!.scopes).toBeNull()
  })

  describe('signing in, which can also link a mailbox', () => {
    const signinUrl = async () => {
      const state = await signState({ tg: '', name: '', chat: '', purpose: 'signin' })
      return `https://hearth.example/api/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`
    }

    it('signs in and links in one step when nothing is linked yet, with no scope on record', async () => {
      await q.saveMember({ telegramUserId: '777', name: 'Sam', email: 'sam@hearth.example', allowed: true, isAdmin: false })
      fetchMock.mockResolvedValueOnce(
        tokenReply({ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'sam@hearth.example' }) }),
      )
      const res = await completeAuth(req(await signinUrl()), 'google')
      expect(res.status).toBe(307)
      const member = await q.memberByTelegramId('777')
      const conn = await q.connectionFor(member!.id, 'google')
      expect(conn!.scopes).toBeNull()
    })

    it('never adopts an existing connection that has no email recorded against it', async () => {
      const m = await q.saveMember({ telegramUserId: '888', name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
      await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'old', scopes: null })
      fetchMock.mockResolvedValueOnce(
        tokenReply({ access_token: 'a', refresh_token: 'new', id_token: idToken({ email: 'ada@hearth.example' }) }),
      )
      await completeAuth(req(await signinUrl()), 'google')
      const conn = await q.connectionFor(m.id, 'google')
      expect(await q.decryptRefreshToken(conn!)).toBe('old')
    })

    it('keeps the session even when the mailbox link cannot be stored', async () => {
      await q.saveMember({ telegramUserId: '999', name: 'Juno', email: 'juno@hearth.example', allowed: true, isAdmin: false })
      const { db } = await import('@/lib/db')
      const { sql } = await import('drizzle-orm')
      await db().execute(sql`alter table connections add constraint block_insert_for_test check (false)`)
      fetchMock.mockResolvedValueOnce(
        tokenReply({ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'juno@hearth.example' }) }),
      )
      const res = await completeAuth(req(await signinUrl()), 'google')
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toBe('https://hearth.example/')
      expect(console.error).toHaveBeenCalledWith('[oauth] sign-in could not store the connection:', expect.anything())
    })
  })
})

describe('access tokens', () => {
  const linkGoogle = async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'r', scopes: null })
    return m
  }

  it('refuses when the member has not linked that provider', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await expect(accessTokenFor(m.id, 'microsoft')).rejects.toBeInstanceOf(NotConnectedError)
  })

  it('exchanges the stored refresh token', async () => {
    const m = await linkGoogle()
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'fresh', expires_in: 3600 }))
    expect(await accessTokenFor(m.id, 'google')).toBe('fresh')
    expect(new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body)).get('refresh_token')).toBe('r')
  })

  it('caches within its lifetime, so a second call costs nothing', async () => {
    const m = await linkGoogle()
    fetchMock.mockResolvedValue(tokenReply({ access_token: 'fresh', expires_in: 3600 }))
    await accessTokenFor(m.id, 'google')
    await accessTokenFor(m.id, 'google')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('assumes an hour when the provider does not say how long the token lasts', async () => {
    const m = await linkGoogle()
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'fresh' }))
    expect(await accessTokenFor(m.id, 'google')).toBe('fresh')
    await accessTokenFor(m.id, 'google')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes again once the cached token is nearly out', async () => {
    const m = await linkGoogle()
    fetchMock.mockResolvedValue(tokenReply({ access_token: 'fresh', expires_in: 10 }))
    await accessTokenFor(m.id, 'google')
    await accessTokenFor(m.id, 'google')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps members apart', async () => {
    const a = await linkGoogle()
    const b = await q.upsertMember('222', 'Ada', { allowed: true })
    await q.saveConnection({ memberId: b.id, provider: 'google', email: null, refreshToken: 'r2', scopes: null })
    fetchMock
      .mockResolvedValueOnce(tokenReply({ access_token: 'for-a', expires_in: 3600 }))
      .mockResolvedValueOnce(tokenReply({ access_token: 'for-b', expires_in: 3600 }))
    expect(await accessTokenFor(a.id, 'google')).toBe('for-a')
    expect(await accessTokenFor(b.id, 'google')).toBe('for-b')
  })
})

describe('clientsFor', () => {
  it('is empty when nothing is linked', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    expect(await clientsFor(m.id)).toEqual([])
  })

  it('returns one client per linked provider, in a stable order', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'microsoft', email: null, refreshToken: 'm', scopes: null })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'g', scopes: null })
    expect((await clientsFor(m.id)).map((c) => c.provider)).toEqual(['google', 'microsoft'])
  })

  it('picks the right implementation per provider', () => {
    expect(clientFor(1, 'google').provider).toBe('google')
    expect(clientFor(1, 'microsoft').provider).toBe('microsoft')
  })
})

describe('oauth routes', () => {
  it('delegate to the shared flow for both providers', async () => {
    const g = await import('@/app/api/oauth/google/route')
    const m = await import('@/app/api/oauth/microsoft/route')
    const gc = await import('@/app/api/oauth/google/callback/route')
    const mc = await import('@/app/api/oauth/microsoft/callback/route')

    expect((await g.GET(req('https://x/api/oauth/google'))).status).toBe(400)
    expect((await m.GET(req('https://x/api/oauth/microsoft'))).status).toBe(400)
    expect((await gc.GET(req('https://x/cb?error=denied'))).status).toBe(400)
    expect((await mc.GET(req('https://x/cb?error=denied'))).status).toBe(400)
  })
})
