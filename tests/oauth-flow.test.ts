import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { jar } from './helpers/next-headers'

/** The sign-in branch signs a session cookie, and a link reads one; give them somewhere to keep it. */
vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))

const { startAuth, completeAuth } = await import('@/lib/oauth/flow')
const { signState, verifyState } = await import('@/lib/oauth/state')
const { createSession, readSession } = await import('@/lib/auth/session')
const { accessTokenFor, clearTokenCache, NotConnectedError, ReconnectNeededError } = await import('@/lib/providers/token')
const { clientsFor, clientFor } = await import('@/lib/providers')

const fetchMock = vi.fn()
let client: PGlite

const tokenReply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
const idToken = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
const add = (name: string, extra: Partial<{ email: string | null; isAdmin: boolean; allowed: boolean }> = {}) =>
  q.saveMember({
    name,
    email: extra.email === undefined ? `${name.toLowerCase()}@hearth.example` : extra.email,
    allowed: extra.allowed ?? true,
    isAdmin: extra.isAdmin ?? false,
  })

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  process.env.GOOGLE_CLIENT_ID = 'gid'
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret'
  process.env.GOOGLE_AGENT_CLIENT_ID = 'agent-gid'
  process.env.GOOGLE_AGENT_CLIENT_SECRET = 'agent-gsecret'
  process.env.MS_CLIENT_ID = 'mid'
  process.env.MS_CLIENT_SECRET = 'msecret'
  delete process.env.ADMIN_EMAILS
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  clearTokenCache()
  client = (await freshDb()).client
})
afterEach(async () => { vi.unstubAllGlobals(); await closeDb(client) })

const req = (url: string) => new Request(url)

/** Signed in on the dashboard as this address, the way the sign-in callback leaves a member. */
const signIn = (email: string) => createSession({ email, name: email, provider: 'google', role: 'member' })

describe('startAuth', () => {
  it('bounces a sign-in to the provider, binding nobody', async () => {
    const res = await startAuth(req('https://hearth.example/api/oauth/google?signin=1'), 'google')
    expect(res.status).toBe(307)
    const to = new URL(res.headers.get('location')!)
    expect(to.origin).toBe('https://accounts.google.com')
    expect(to.searchParams.get('prompt')).toBeNull()
    expect(await verifyState(to.searchParams.get('state')!, 'signin')).toEqual({ purpose: 'signin' })
  })

  it('carries a sign-in on to the page that asked for it, on this site only', async () => {
    const next = '/api/oauth/authorize?client_id=c&state=s'
    const back = await startAuth(req(`https://hearth.example/api/oauth/google?signin=1&next=${encodeURIComponent(next)}`), 'google')
    expect(await verifyState(new URL(back.headers.get('location')!).searchParams.get('state')!)).toEqual({ purpose: 'signin', next })
    const away = await startAuth(req(`https://hearth.example/api/oauth/google?signin=1&next=${encodeURIComponent('//evil.example')}`), 'google')
    expect(await verifyState(new URL(away.headers.get('location')!).searchParams.get('state')!)).toEqual({ purpose: 'signin' })
  })

  it('links for the member who is signed in, with the consent screen forced so a refresh token comes back', async () => {
    const rowan = await add('Rowan')
    await signIn('rowan@hearth.example')
    const res = await startAuth(req('https://hearth.example/api/oauth/microsoft'), 'microsoft')
    expect(res.status).toBe(307)
    const to = new URL(res.headers.get('location')!)
    expect(to.host).toBe('login.microsoftonline.com')
    expect(await verifyState(to.searchParams.get('state')!, 'link')).toEqual({ purpose: 'link', member: rowan.id })

    const google = new URL((await startAuth(req('https://hearth.example/api/oauth/google'), 'google')).headers.get('location')!)
    expect(google.searchParams.get('prompt')).toBe('consent')
  })

  it('sends anyone not signed in as a member back to Connect, binding nobody', async () => {
    const res = await startAuth(req('https://hearth.example/api/oauth/google'), 'google')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://hearth.example/connect')

    // An ADMIN_EMAILS address with no member behind it has nobody to link an account to.
    process.env.ADMIN_EMAILS = 'boss@hearth.example'
    await signIn('boss@hearth.example')
    expect((await startAuth(req('https://hearth.example/api/oauth/google'), 'google')).headers.get('location')).toBe('https://hearth.example/connect')
  })

  it('will not link for someone revoked since they signed in', async () => {
    const rowan = await add('Rowan')
    await signIn('rowan@hearth.example')
    await q.saveMember({ id: rowan.id, name: 'Rowan', email: rowan.email, allowed: false, isAdmin: false })
    expect((await startAuth(req('https://hearth.example/api/oauth/google'), 'google')).headers.get('location')).toBe('https://hearth.example/connect')
  })
})

describe('completeAuth', () => {
  let rowan: Awaited<ReturnType<typeof add>>
  beforeEach(async () => { rowan = await add('Rowan') })

  const callbackUrl = async (member = rowan.id) => {
    const state = await signState({ purpose: 'link', member })
    return `https://hearth.example/api/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`
  }

  it('stores an encrypted refresh token for the member who asked, and sends them back to Connect', async () => {
    fetchMock.mockResolvedValueOnce(
      tokenReply({ access_token: 'a', refresh_token: 'r3fr3sh', scope: 's', id_token: idToken({ email: 'a@b.com' }) }),
    )
    const res = await completeAuth(req(await callbackUrl()), 'google')
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://hearth.example/connect?linked=google')

    const conn = await q.connectionFor(rowan.id, 'google')
    expect(conn!.email).toBe('a@b.com')
    expect(conn!.scopes).toBe('s')
    expect(conn!.refreshToken).not.toContain('r3fr3sh')
    expect(await q.decryptRefreshToken(conn!)).toBe('r3fr3sh')
  })

  it('turns away an account already linked to another member, and changes nothing', async () => {
    const mum = await add('Mum', { email: null })
    await q.saveConnection({ memberId: mum.id, provider: 'google', email: 'mum@gmail.com', refreshToken: 'mums', scopes: null })
    fetchMock.mockResolvedValueOnce(
      tokenReply({ access_token: 'a', refresh_token: 'r3fr3sh', id_token: idToken({ email: 'Mum@Gmail.com' }) }),
    )
    const res = await completeAuth(req(await callbackUrl()), 'google')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Mum&#39;s account in this household')
    expect(await q.connectionFor(rowan.id, 'google')).toBeUndefined()
    expect(await q.decryptRefreshToken((await q.connectionFor(mum.id, 'google'))!)).toBe('mums')
  })

  it('turns away an address an admin recorded against another member, before they have linked anything', async () => {
    await add('Sam')
    fetchMock.mockResolvedValueOnce(
      tokenReply({ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'sam@hearth.example' }) }),
    )
    const res = await completeAuth(req(await callbackUrl()), 'google')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Sam&#39;s account')
  })

  describe('an address in ADMIN_EMAILS', () => {
    beforeEach(() => void (process.env.ADMIN_EMAILS = 'Parent@Gmail.com'))

    it('is turned away from a member who is not an admin, though no row names its owner', async () => {
      await add('Parent', { isAdmin: true, email: null })
      fetchMock.mockResolvedValueOnce(
        tokenReply({ access_token: 'a', refresh_token: 'parents', id_token: idToken({ email: 'parent@gmail.com' }) }),
      )
      const res = await completeAuth(req(await callbackUrl()), 'google')
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('an admin&#39;s address')
      expect(await q.connectionFor(rowan.id, 'google')).toBeUndefined()
    })

    it('is turned away from a member with no address of their own on record', async () => {
      const kid = await add('Kid', { email: null })
      fetchMock.mockResolvedValueOnce(
        tokenReply({ access_token: 'a', refresh_token: 'parents', id_token: idToken({ email: 'parent@gmail.com' }) }),
      )
      expect((await completeAuth(req(await callbackUrl(kid.id)), 'google')).status).toBe(400)
      expect(await q.connectionFor(kid.id, 'google')).toBeUndefined()
    })

    it('links for an admin, or for the member an admin recorded it against', async () => {
      await q.saveMember({ id: rowan.id, name: 'Rowan', email: rowan.email, allowed: true, isAdmin: true })
      fetchMock.mockResolvedValue(
        tokenReply({ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'parent@gmail.com' }) }),
      )
      expect((await completeAuth(req(await callbackUrl()), 'google')).status).toBe(307)

      // An admin's own address may not be named another member's, so it is Rowan's own record that names it here.
      await q.saveMember({ id: rowan.id, name: 'Rowan', email: 'parent@gmail.com', allowed: true, isAdmin: false })
      expect((await completeAuth(req(await callbackUrl()), 'microsoft')).status).toBe(307)
      expect((await q.connectionFor(rowan.id, 'microsoft'))!.email).toBe('parent@gmail.com')
    })
  })

  it('links an account whose address the provider did not give, since nobody can be said to own it', async () => {
    await add('Sam')
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a', refresh_token: 'r' }))
    expect((await completeAuth(req(await callbackUrl()), 'google')).status).toBe(307)
    expect((await q.connectionFor(rowan.id, 'google'))!.email).toBeNull()
  })

  it("lets a member relink their own account, whether it came from their link or an admin's record", async () => {
    await q.saveConnection({ memberId: rowan.id, provider: 'microsoft', email: 'a@b.com', refreshToken: 'old', scopes: null })
    fetchMock
      .mockResolvedValueOnce(tokenReply({ access_token: 'a', refresh_token: 'new', id_token: idToken({ email: 'a@b.com' }) }))
      .mockResolvedValueOnce(tokenReply({ access_token: 'a', refresh_token: 'g', id_token: idToken({ email: 'rowan@hearth.example' }) }))
    expect((await completeAuth(req(await callbackUrl()), 'microsoft')).status).toBe(307)
    expect(await q.decryptRefreshToken((await q.connectionFor(rowan.id, 'microsoft'))!)).toBe('new')
    expect((await completeAuth(req(await callbackUrl()), 'google')).status).toBe(307)
    expect((await q.connectionFor(rowan.id, 'google'))!.email).toBe('rowan@hearth.example')
  })

  it('refuses a link for a member revoked or removed since they asked', async () => {
    await q.saveMember({ id: rowan.id, name: 'Rowan', email: rowan.email, allowed: false, isAdmin: false })
    fetchMock.mockResolvedValue(tokenReply({ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'a@b.com' }) }))
    const res = await completeAuth(req(await callbackUrl()), 'google')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('no longer valid')
    expect(await q.connectionFor(rowan.id, 'google')).toBeUndefined()
    expect((await completeAuth(req(await callbackUrl(9999)), 'google')).status).toBe(400)
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
    expect(res.status).toBe(400)
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
    expect(await res.text()).not.toContain('<script>')
  })

  it('links without a scope on record when the provider does not return one', async () => {
    fetchMock.mockResolvedValueOnce(
      tokenReply({ access_token: 'a', refresh_token: 'r3fr3sh', id_token: idToken({ email: 'a@b.com' }) }),
    )
    await completeAuth(req(await callbackUrl()), 'google')
    expect((await q.connectionFor(rowan.id, 'google'))!.scopes).toBeNull()
  })

  describe('signing in, which can also link a mailbox', () => {
    const signinUrl = async (next?: string, provider = 'google') => {
      const state = await signState({ purpose: 'signin', ...(next ? { next } : {}) })
      return `https://hearth.example/api/oauth/${provider}/callback?code=abc&state=${encodeURIComponent(state)}`
    }

    it('signs a recognised member in and links in one step when nothing is linked yet', async () => {
      const sam = await add('Sam')
      fetchMock.mockResolvedValueOnce(
        tokenReply({ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'sam@hearth.example' }) }),
      )
      const res = await completeAuth(req(await signinUrl(undefined, 'microsoft')), 'microsoft')
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toBe('https://hearth.example/')
      expect((await readSession())?.email).toBe('sam@hearth.example')
      expect((await q.connectionFor(sam.id, 'microsoft'))!.scopes).toBeNull()
    })

    it('signs in with Google through its own client and links nothing, since Gmail is linked through the agent client', async () => {
      const sam = await add('Sam')
      fetchMock.mockResolvedValueOnce(
        tokenReply({ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'sam@hearth.example' }) }),
      )
      const res = await completeAuth(req(await signinUrl()), 'google')
      expect(res.status).toBe(307)
      expect((await readSession())?.email).toBe('sam@hearth.example')
      expect(await q.connectionFor(sam.id, 'google')).toBeUndefined()
      // The code goes back through the client that sent the member to Google.
      expect(new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body)).get('client_id')).toBe('gid')
    })

    it('lands on the page the sign-in was started from', async () => {
      await add('Sam')
      fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a', id_token: idToken({ email: 'sam@hearth.example' }) }))
      const res = await completeAuth(req(await signinUrl('/api/oauth/authorize?client_id=c')), 'google')
      expect(res.headers.get('location')).toBe('https://hearth.example/api/oauth/authorize?client_id=c')
    })

    it('turns away an address nobody recognises, and one the provider did not give', async () => {
      fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a', id_token: idToken({ email: 'stranger@example.com' }) }))
      const stranger = await completeAuth(req(await signinUrl()), 'google')
      expect(stranger.status).toBe(400)
      expect(await stranger.text()).toContain('stranger@example.com is not recognised')

      fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a' }))
      const nobody = await completeAuth(req(await signinUrl()), 'google')
      expect(nobody.status).toBe(400)
      expect(await nobody.text()).toContain('did not tell us which account')
      expect(await readSession()).toBeNull()
    })

    it('signs in an ADMIN_EMAILS address with no member behind it, linking nothing', async () => {
      process.env.ADMIN_EMAILS = 'boss@hearth.example'
      fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'boss@hearth.example' }) }))
      expect((await completeAuth(req(await signinUrl()), 'google')).status).toBe(307)
      expect((await readSession())?.role).toBe('admin')
    })

    it('never repoints a link at another account, or adopts one that has no email recorded against it', async () => {
      const ada = await add('Ada')
      await q.saveConnection({ memberId: ada.id, provider: 'microsoft', email: null, refreshToken: 'old', scopes: null })
      fetchMock.mockResolvedValueOnce(
        tokenReply({ access_token: 'a', refresh_token: 'new', id_token: idToken({ email: 'ada@hearth.example' }) }),
      )
      await completeAuth(req(await signinUrl(undefined, 'microsoft')), 'microsoft')
      expect(await q.decryptRefreshToken((await q.connectionFor(ada.id, 'microsoft'))!)).toBe('old')
    })

    it('keeps the session even when the mailbox link cannot be stored', async () => {
      await add('Juno')
      const { db } = await import('@/lib/db')
      const { sql } = await import('drizzle-orm')
      await db().execute(sql`alter table connections add constraint block_insert_for_test check (false)`)
      fetchMock.mockResolvedValueOnce(
        tokenReply({ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'juno@hearth.example' }) }),
      )
      const res = await completeAuth(req(await signinUrl(undefined, 'microsoft')), 'microsoft')
      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toBe('https://hearth.example/')
      expect(console.error).toHaveBeenCalledWith('[oauth] sign-in could not store the connection:', expect.anything())
    })
  })
})

describe('access tokens', () => {
  const linkGoogle = async () => {
    const m = await add('Rowan')
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'r', scopes: null })
    return m
  }

  it('refuses when the member has not linked that provider', async () => {
    const m = await add('Rowan')
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

  it('keeps the refresh token Microsoft rotates in, so the link outlives the first one\'s 90 days', async () => {
    const m = await add('Rowan')
    await q.saveConnection({ memberId: m.id, provider: 'microsoft', email: 'r@outlook.com', refreshToken: 'day-0', scopes: null })
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a1', refresh_token: 'day-1', expires_in: 10 }))
    expect(await accessTokenFor(m.id, 'microsoft')).toBe('a1')
    expect(await q.decryptRefreshToken((await q.connectionFor(m.id, 'microsoft'))!)).toBe('day-1')

    // The next refresh presents the new one, not the one from the day of linking.
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'a2', refresh_token: 'day-2', expires_in: 3600 }))
    expect(await accessTokenFor(m.id, 'microsoft')).toBe('a2')
    expect(new URLSearchParams(String((fetchMock.mock.calls[1][1] as RequestInit).body)).get('refresh_token')).toBe('day-1')
    expect(await q.decryptRefreshToken((await q.connectionFor(m.id, 'microsoft'))!)).toBe('day-2')
  })

  it('leaves the stored token alone when the provider sends none back, or the same one', async () => {
    const m = await linkGoogle()
    const before = (await q.connectionFor(m.id, 'google'))!.refreshToken
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'fresh', refresh_token: 'r', expires_in: 10 }))
    await accessTokenFor(m.id, 'google')
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'fresh', expires_in: 10 }))
    await accessTokenFor(m.id, 'google')
    expect((await q.connectionFor(m.id, 'google'))!.refreshToken).toBe(before)
  })

  it('still hands out the access token when the rotated one cannot be stored', async () => {
    const m = await linkGoogle()
    const { db } = await import('@/lib/db')
    vi.spyOn(db(), 'update').mockImplementationOnce(() => { throw new Error('connections locked') })
    fetchMock.mockResolvedValueOnce(tokenReply({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }))
    expect(await accessTokenFor(m.id, 'google')).toBe('fresh')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not store the rotated google'), 'connections locked')
  })

  it('says the link needs redoing when the provider refuses the refresh token outright', async () => {
    const m = await linkGoogle()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => '{"error":"invalid_grant","error_description":"AADSTS700082: expired"}' })
    const err = await accessTokenFor(m.id, 'google').catch((e) => e)
    expect(err).toBeInstanceOf(ReconnectNeededError)
    expect(err.provider).toBe('google')

    // Microsoft asking for a fresh sign-in or consent is the same: only the member can fix it.
    clearTokenCache()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => '{"error":"interaction_required"}' })
    await expect(accessTokenFor(m.id, 'google')).rejects.toBeInstanceOf(ReconnectNeededError)

    // So is a refresh token another client was issued, which only a new link through this one replaces.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => '{"error":"unauthorized_client","error_description":"Unauthorized"}' })
    await expect(accessTokenFor(m.id, 'google')).rejects.toBeInstanceOf(ReconnectNeededError)

    // Anything else stays the error it was.
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'upstream down' })
    await expect(accessTokenFor(m.id, 'google')).rejects.toThrow(/token request failed \(503\): upstream down/)
  })

  it('keeps members apart', async () => {
    const a = await linkGoogle()
    const b = await add('Ada')
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
    const m = await add('Rowan')
    expect(await clientsFor(m.id)).toEqual([])
  })

  it('returns one client per linked provider, in a stable order', async () => {
    const m = await add('Rowan')
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

    // Nobody is signed in, so a link goes back to Connect rather than to the provider.
    expect((await g.GET(req('https://x/api/oauth/google'))).headers.get('location')).toBe('https://hearth.example/connect')
    expect((await m.GET(req('https://x/api/oauth/microsoft'))).headers.get('location')).toBe('https://hearth.example/connect')
    expect((await gc.GET(req('https://x/cb?error=denied'))).status).toBe(400)
    expect((await mc.GET(req('https://x/cb?error=denied'))).status).toBe(400)
  })
})
