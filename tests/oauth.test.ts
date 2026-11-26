import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import { signState, verifyState, safeNext } from '@/lib/oauth/state'
import { signingSecret, signOutEverywhere } from '@/lib/auth/keys'
import {
  authorizeUrl, redirectUri, providerConfig, exchangeCode, refreshAccessToken, emailFromIdToken,
} from '@/lib/oauth/providers'

const fetchMock = vi.fn()

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  process.env.GOOGLE_CLIENT_ID = 'gid'
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret'
  process.env.GOOGLE_AGENT_CLIENT_ID = 'agent-gid'
  process.env.GOOGLE_AGENT_CLIENT_SECRET = 'agent-gsecret'
  process.env.MS_CLIENT_ID = 'mid'
  process.env.MS_CLIENT_SECRET = 'msecret'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('oauth state', () => {
  const link = { purpose: 'link' as const, member: 5 }
  // The epoch a link is signed under lives in the store.
  let client: PGlite
  beforeEach(async () => { client = (await freshDb()).client })
  afterEach(async () => closeDb(client))

  const signed = async (claims: Record<string, unknown>, key?: Uint8Array) => {
    const { SignJWT } = await import('jose')
    return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(key ?? (await signingSecret('oauth-state')))
  }

  it('round-trips a link, bound to the member who asked for it', async () => {
    expect(await verifyState(await signState(link))).toEqual(link)
  })

  it('round-trips a sign-in, which binds nobody', async () => {
    expect(await verifyState(await signState({ purpose: 'signin' }))).toEqual({ purpose: 'signin' })
  })

  it('carries a sign-in on to a page on this site afterwards', async () => {
    const next = '/api/oauth/authorize?client_id=abc&state=x'
    expect(await verifyState(await signState({ purpose: 'signin', next }))).toEqual({ purpose: 'signin', next })
  })

  it('never carries a sign-in on to another site', async () => {
    for (const next of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '/a b', `/${'x'.repeat(2001)}`]) {
      expect(await verifyState(await signState({ purpose: 'signin', next }))).toEqual({ purpose: 'signin' })
    }
    // Nor one written into a state with the right key some other way.
    expect(await verifyState(await signed({ purpose: 'signin', next: '//evil.example' }))).toEqual({ purpose: 'signin' })
  })

  it('treats an unrecognised purpose as linking, never as a sign-in', async () => {
    expect(await verifyState(await signed({ purpose: 'root', member: 5, ep: '' }))).toEqual(link)
    await expect(verifyState(await signed({ purpose: 'root' }))).rejects.toThrow(/names no member/)
  })

  it('rejects a token signed with a different key', async () => {
    const token = await signState(link)
    process.env.TOKEN_ENC_KEY = 'b'.repeat(64)
    await expect(verifyState(token)).rejects.toThrow()
  })

  it('will not take a token signed with TOKEN_ENC_KEY itself, or with the key sessions are signed with', async () => {
    const claims = { ...link, ep: '' }
    await expect(verifyState(await signed(claims, new TextEncoder().encode(process.env.TOKEN_ENC_KEY!)))).rejects.toThrow()
    await expect(verifyState(await signed(claims, await signingSecret('session')))).rejects.toThrow()
    expect(await verifyState(await signed(claims))).toEqual(link)
  })

  it('voids every link still under way once everyone is signed out, and no sign-in', async () => {
    const pending = await signState(link)
    const signin = await signState({ purpose: 'signin' })
    await signOutEverywhere()
    await expect(verifyState(pending)).rejects.toThrow(/signed out/)
    expect(await verifyState(await signState(link))).toEqual(link)
    expect(await verifyState(signin)).toEqual({ purpose: 'signin' })
  })

  it('turns a made-up state away, and hands out a sign-in state, without reading the store', async () => {
    const { __setDb } = await import('@/lib/db')
    let reads = 0
    __setDb(new Proxy({}, { get: () => { reads++; throw new Error('the store was read') } }))
    const forged = await signed({ ...link }, new TextEncoder().encode('made up'))
    await expect(verifyState(forged)).rejects.toThrow(/signature verification failed/)
    const signin = await signState({ purpose: 'signin', next: '/x' })
    expect(await verifyState(signin, 'signin')).toEqual({ purpose: 'signin', next: '/x' })
    expect(reads).toBe(0)
  })

  it('rejects an expired token', async () => {
    const token = await signState(link, '0s')
    await new Promise((r) => setTimeout(r, 1100))
    await expect(verifyState(token)).rejects.toThrow()
  })

  it('rejects gibberish', async () => {
    await expect(verifyState('not-a-jwt')).rejects.toThrow()
  })

  it('refuses a link that names no member, or not one that could be', async () => {
    for (const member of [undefined, 0, -1, 2.5, '5']) {
      await expect(verifyState(await signed({ purpose: 'link', ep: '', ...(member === undefined ? {} : { member }) }))).rejects.toThrow(/names no member/)
    }
  })

  it('refuses a state minted for the other purpose when the caller says which it wants', async () => {
    const signin = await signState({ purpose: 'signin' })
    await expect(verifyState(signin, 'link')).rejects.toThrow(/signin, not link/)
    await expect(verifyState(await signState(link), 'signin')).rejects.toThrow(/link, not signin/)
    expect(await verifyState(await signState(link), 'link')).toEqual(link)
  })
})

describe('where a sign-in may land afterwards', () => {
  it('is a path on this site', () => {
    expect(safeNext('/api/oauth/authorize?a=1')).toBe('/api/oauth/authorize?a=1')
    expect(safeNext('  /connect  ')).toBe('/connect')
  })

  it('is never another site, nor anything a browser could read as one', () => {
    for (const bad of [undefined, null, 5, '', 'connect', '//evil.example', 'https://evil.example', '/\\evil', '/x\ty', '/a b']) {
      expect(safeNext(bad), String(bad)).toBeUndefined()
    }
    expect(safeNext(`/${'x'.repeat(2000)}`)).toBeUndefined()
  })
})

describe('authorize urls', () => {
  it('links a Gmail mailbox through the agent client, with offline access and forced consent', () => {
    const url = new URL(authorizeUrl('google', 'st'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe('agent-gid')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('redirect_uri')).toBe('https://hearth.example/api/oauth/google/callback')
  })

  it('signs in to the dashboard through the other Google client, asking only who is signing in', () => {
    // Forced consent is for minting a refresh token; a returning admin should just pick an account.
    const url = new URL(authorizeUrl('google', 'st', 'signin'))
    expect(url.searchParams.get('client_id')).toBe('gid')
    expect(url.searchParams.get('prompt')).toBeNull()
    expect(url.searchParams.get('access_type')).toBeNull()
    expect(url.searchParams.get('scope')).toBe('openid email')
    // The same callback either way, so neither client needs a second redirect registered.
    expect(url.searchParams.get('redirect_uri')).toBe('https://hearth.example/api/oauth/google/callback')
  })

  it('uses the same params for Microsoft either way, which never re-asks', () => {
    const link = new URL(authorizeUrl('microsoft', 's')).searchParams
    const signin = new URL(authorizeUrl('microsoft', 's', 'signin')).searchParams
    expect([...signin.entries()]).toEqual([...link.entries()])
  })

  it('asks Google for the calendar alone, and nothing an older link was granted besides', () => {
    const url = new URL(authorizeUrl('google', 's'))
    expect(url.searchParams.get('scope')!.split(' ')).toEqual([
      'openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly',
    ])
    expect(url.searchParams.get('include_granted_scopes')).toBeNull()
    expect(new URL(authorizeUrl('microsoft', 's')).searchParams.get('scope')).not.toMatch(/Mail\./)
  })

  it('routes Microsoft through /common so personal accounts work', () => {
    const url = new URL(authorizeUrl('microsoft', 's'))
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize')
    expect(url.searchParams.get('scope')).toContain('offline_access')
  })

  it('derives the redirect from APP_URL', () => {
    process.env.APP_URL = 'https://other.example/'
    expect(redirectUri('microsoft')).toBe('https://other.example/api/oauth/microsoft/callback')
  })

  it('picks the right config per provider', () => {
    expect(providerConfig('google').label).toBe('Google')
    expect(providerConfig('microsoft').label).toBe('Microsoft')
  })
})

describe('token exchange', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })

  it('posts the code with the credentials of the client its round trip went through', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'a', refresh_token: 'r' }))
    const res = await exchangeCode('google', 'the-code')
    expect(res.refresh_token).toBe('r')
    const sent = (i: number) => new URLSearchParams(String((fetchMock.mock.calls[i][1] as RequestInit).body))
    expect(sent(0).get('grant_type')).toBe('authorization_code')
    expect(sent(0).get('code')).toBe('the-code')
    expect(sent(0).get('client_id')).toBe('agent-gid')
    expect(sent(0).get('client_secret')).toBe('agent-gsecret')

    await exchangeCode('google', 'signin-code', 'signin')
    expect(sent(1).get('client_id')).toBe('gid')
    expect(sent(1).get('client_secret')).toBe('gsecret')
  })

  it("refreshes a Gmail link through the agent client, the only one whose tokens Google's MCP servers take", async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'a' }))
    await refreshAccessToken('google', 'r')
    expect(new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body)).get('client_id')).toBe('agent-gid')
  })

  it('restates scopes when refreshing against Graph, which requires them', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'a' }))
    await refreshAccessToken('microsoft', 'r')
    expect(new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body)).get('scope'))
      .toContain('Calendars.ReadWrite')
  })

  it('omits scopes when refreshing against Google, which rejects them', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'a' }))
    await refreshAccessToken('google', 'r')
    expect(new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body)).get('scope')).toBeNull()
  })

  it('reports a failed exchange with the provider and status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'invalid_grant' })
    await expect(exchangeCode('google', 'bad')).rejects.toThrow(/Google token request failed \(400\)/)
  })
})

describe('emailFromIdToken', () => {
  const jwt = (claims: object) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

  it('reads the email claim', () => {
    expect(emailFromIdToken(jwt({ email: 'a@b.com' }))).toBe('a@b.com')
  })

  it('falls back through the Microsoft claim names', () => {
    expect(emailFromIdToken(jwt({ preferred_username: 'p@b.com' }))).toBe('p@b.com')
    expect(emailFromIdToken(jwt({ upn: 'u@b.com' }))).toBe('u@b.com')
  })

  it('returns null rather than throwing on rubbish', () => {
    expect(emailFromIdToken(undefined)).toBeNull()
    expect(emailFromIdToken('not.a.jwt')).toBeNull()
    expect(emailFromIdToken(jwt({ sub: 'x' }))).toBeNull()
  })
})
