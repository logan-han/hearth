import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { signState, verifyState, connectLink } from '@/lib/oauth/state'
import {
  authorizeUrl, redirectUri, providerConfig, exchangeCode, refreshAccessToken, emailFromIdToken,
} from '@/lib/oauth/providers'

const fetchMock = vi.fn()

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.han.life'
  process.env.GOOGLE_CLIENT_ID = 'gid'
  process.env.GOOGLE_CLIENT_SECRET = 'gsecret'
  process.env.MS_CLIENT_ID = 'mid'
  process.env.MS_CLIENT_SECRET = 'msecret'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('oauth state', () => {
  const payload = { tg: '111', name: 'Logan', chat: '-100' }

  it('round-trips the telegram binding, defaulting to the linking purpose', async () => {
    expect(await verifyState(await signState(payload))).toEqual({ ...payload, purpose: 'link' })
  })

  it('carries a sign-in purpose through, which needs no telegram binding', async () => {
    const signin = { tg: '', name: '', chat: '', purpose: 'signin' as const }
    expect(await verifyState(await signState(signin))).toEqual(signin)
  })

  it('treats an unrecognised purpose as linking, never as a sign-in', async () => {
    const { SignJWT } = await import('jose')
    const token = await new SignJWT({ tg: '111', name: 'L', chat: '', purpose: 'root' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(process.env.TOKEN_ENC_KEY!))
    expect((await verifyState(token)).purpose).toBe('link')
  })

  it('rejects a token signed with a different key', async () => {
    const token = await signState(payload)
    process.env.TOKEN_ENC_KEY = 'b'.repeat(64)
    await expect(verifyState(token)).rejects.toThrow()
  })

  it('rejects an expired token', async () => {
    const token = await signState(payload, '0s')
    await new Promise((r) => setTimeout(r, 1100))
    await expect(verifyState(token)).rejects.toThrow()
  })

  it('rejects gibberish', async () => {
    await expect(verifyState('not-a-jwt')).rejects.toThrow()
  })

  it('refuses a token with no telegram id', async () => {
    const { SignJWT } = await import('jose')
    const token = await new SignJWT({ name: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(process.env.TOKEN_ENC_KEY!))
    await expect(verifyState(token)).rejects.toThrow(/telegram id/)
  })

  it('defaults a missing name rather than failing', async () => {
    const { SignJWT } = await import('jose')
    const token = await new SignJWT({ tg: '111' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(process.env.TOKEN_ENC_KEY!))
    expect(await verifyState(token)).toEqual({ tg: '111', name: 'Family member', chat: '', purpose: 'link' })
  })

  it('builds a connect link carrying the state', async () => {
    const link = await connectLink('https://hearth.han.life', payload)
    const token = new URL(link).searchParams.get('t')!
    expect(await verifyState(token)).toEqual({ ...payload, purpose: 'link' })
  })
})

describe('authorize urls', () => {
  it('asks Google for offline access and forced consent', () => {
    const url = new URL(authorizeUrl('google', 'st'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('redirect_uri')).toBe('https://hearth.han.life/api/oauth/google/callback')
  })

  it('asks Google for mail and calendar scopes', () => {
    const scopes = new URL(authorizeUrl('google', 's')).searchParams.get('scope')!.split(' ')
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.modify')
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.events')
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

  it('posts the code with the client credentials', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'a', refresh_token: 'r' }))
    const res = await exchangeCode('google', 'the-code')
    expect(res.refresh_token).toBe('r')
    const body = new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('client_secret')).toBe('gsecret')
  })

  it('restates scopes when refreshing against Graph, which requires them', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'a' }))
    await refreshAccessToken('microsoft', 'r')
    expect(new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body)).get('scope'))
      .toContain('Mail.ReadWrite')
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
