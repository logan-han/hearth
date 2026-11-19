import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { SignJWT } from 'jose'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { Member } from '@/lib/db/schema'
import { jar } from './helpers/next-headers'

vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))

const server = await import('@/lib/oauth/server')
const { signingKey } = await import('@/lib/crypto')
const { createSession } = await import('@/lib/auth/session')
const authorizeRoute = await import('@/app/api/oauth/authorize/route')
const registerRoute = await import('@/app/api/oauth/register/route')
const tokenRoute = await import('@/app/api/oauth/token/route')
const resourceRoute = await import('@/app/.well-known/oauth-protected-resource/route')
const resourceAtPath = await import('@/app/.well-known/oauth-protected-resource/api/mcp/route')
const issuerRoute = await import('@/app/.well-known/oauth-authorization-server/route')
const { POST: MCP } = await import('@/app/api/mcp/route')

let client: PGlite
let rowan: Member

const BASE = 'https://hearth.example'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const VERIFIER = 'v'.repeat(20) + 'erifier-0123456789_abcdefghij.~'
const challengeOf = async (verifier: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = BASE
  process.env.TIMEZONE = 'Australia/Melbourne'
  delete process.env.ADMIN_EMAILS
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
  rowan = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
})
afterEach(async () => closeDb(client))

/** Register a client the way an MCP client does, and hand back its id. */
async function register(meta: Record<string, unknown> = {}) {
  const out = await server.registerClient({ redirect_uris: [REDIRECT], client_name: 'Claude', ...meta })
  expect(out.status).toBe(201)
  return out.json.client_id as string
}

/** The query an MCP client sends its member to /api/oauth/authorize with. */
async function authoriseQuery(clientId: string, extra: Record<string, string | null> = {}) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: await challengeOf(VERIFIER),
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: `${BASE}/api/mcp`,
  })
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) params.delete(k)
    else params.set(k, v)
  }
  return params
}

const authoriseGet = (params: URLSearchParams) => authorizeRoute.GET(new Request(`${BASE}/api/oauth/authorize?${params}`))
const authorisePost = (form: Record<string, string>) =>
  authorizeRoute.POST(new Request(`${BASE}/api/oauth/authorize`, { method: 'POST', body: new URLSearchParams(form) }))

const signIn = (email = 'rowan@hearth.example') => createSession({ email, name: email, provider: 'google', role: 'member' })

/** The consent token the approval page carries for the signed-in member. */
async function consentFor(params: URLSearchParams) {
  const page = await (await authoriseGet(params)).text()
  const token = /name="consent" value="([^"]+)"/.exec(page)?.[1]
  expect(token).toBeTruthy()
  return token!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

/** Through registration and approval to a code, as the client receives it. */
async function codeFor(meta: Record<string, unknown> = {}) {
  const clientId = await register(meta)
  await signIn()
  const res = await authorisePost({ consent: await consentFor(await authoriseQuery(clientId)), decision: 'allow' })
  const to = new URL(res.headers.get('location')!)
  return { clientId, code: to.searchParams.get('code')! }
}

const tokenForm = (fields: Record<string, string>) => new URLSearchParams({ grant_type: 'authorization_code', redirect_uri: REDIRECT, code_verifier: VERIFIER, ...fields })

describe('what a client is told about signing in', () => {
  it('names /api/mcp as the resource and this deployment as who issues its tokens', () => {
    expect(server.protectedResourceMetadata()).toEqual({
      resource: `${BASE}/api/mcp`,
      authorization_servers: [BASE],
      bearer_methods_supported: ['header'],
      resource_name: 'Hearth',
      resource_documentation: `${BASE}/connect`,
    })
  })

  it('says where to register, approve and trade a code, and that PKCE is S256 for public clients', () => {
    expect(server.authorizationServerMetadata()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/api/oauth/authorize`,
      token_endpoint: `${BASE}/api/oauth/token`,
      registration_endpoint: `${BASE}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  })

  it('serves both at their well-known addresses, readable from other sites, never a 404', async () => {
    for (const route of [resourceRoute, resourceAtPath]) {
      const res = route.GET()
      expect(res.status).toBe(200)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(await res.json()).toMatchObject({ resource: `${BASE}/api/mcp`, authorization_servers: [BASE] })
      expect(route.OPTIONS().status).toBe(204)
    }
    const issuer = issuerRoute.GET()
    expect(issuer.status).toBe(200)
    expect((await issuer.json()).issuer).toBe(BASE)
    expect(issuerRoute.OPTIONS().headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('is what a client turned away by /api/mcp is pointed at', () => {
    expect(server.RESOURCE_METADATA_PATH).toBe('/.well-known/oauth-protected-resource/api/mcp')
  })
})

describe('registering a client', () => {
  it('takes https anywhere, http to this machine only, and a native app scheme', () => {
    for (const ok of [REDIRECT, 'http://localhost:3333/callback', 'http://127.0.0.1:9/cb', 'http://[::1]:8080/cb', 'cursor://anysphere.cursor-retrieval/oauth/callback']) {
      expect(server.redirectAllowed(ok), ok).toBe(true)
    }
  })

  it('refuses anything that runs in a page, carries a fragment or a password, or is plain http elsewhere', () => {
    for (const bad of [
      'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'vbscript:x', 'blob:https://x/1',
      'https://claude.ai/cb#frag', 'https://user:pw@claude.ai/cb', 'http://evil.example/cb', 'not a url', '',
    ]) {
      expect(server.redirectAllowed(bad), bad).toBe(false)
    }
  })

  it('signs what was registered into the client id, stored nowhere, and reads it back', async () => {
    const out = await server.registerClient({ redirect_uris: [REDIRECT, 'http://localhost:1/cb'], client_name: '  Claude \n Desktop ', grant_types: ['authorization_code', 'refresh_token'] })
    expect(out.status).toBe(201)
    expect(out.json).toMatchObject({
      redirect_uris: [REDIRECT, 'http://localhost:1/cb'],
      client_name: 'Claude Desktop',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    })
    expect(await server.readClient(out.json.client_id as string)).toEqual({ redirectUris: [REDIRECT, 'http://localhost:1/cb'], name: 'Claude Desktop' })
    // Nothing went into the database.
    expect((await client.query('select count(*)::int as n from settings')).rows).toEqual([{ n: 0 }])
  })

  it('keeps a name short, and keeps none that is blank', async () => {
    const long = await server.registerClient({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(200) })
    expect((long.json.client_name as string).length).toBe(60)
    const blank = await server.registerClient({ redirect_uris: [REDIRECT], client_name: '   ' })
    expect(blank.json).not.toHaveProperty('client_name')
    expect((await server.readClient(blank.json.client_id as string))!.name).toBeNull()
  })

  it('refuses a registration with no good redirect, or one asking for another grant', async () => {
    for (const body of [
      null, 'string', {}, { redirect_uris: [] }, { redirect_uris: 'https://x/cb' }, { redirect_uris: [5] },
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://x.example/${i}`) },
      { redirect_uris: ['javascript:alert(1)'] }, { redirect_uris: [REDIRECT, 'http://evil.example/cb'] },
      { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }, { redirect_uris: [REDIRECT], grant_types: 'authorization_code' },
    ]) {
      const out = await server.registerClient(body)
      expect(out.status, JSON.stringify(body)).toBe(400)
      expect(out.json.error).toMatch(/^invalid_(client_metadata|redirect_uri)$/)
    }
  })

  it('knows a client id it did not issue for what it is', async () => {
    const id = await register()
    const [h, , sig] = id.split('.')
    const tampered = `${h}.${Buffer.from(JSON.stringify({ r: ['https://evil.example/cb'] })).toString('base64url')}.${sig}`
    expect(await server.readClient(tampered)).toBeNull()
    expect(await server.readClient('garbage')).toBeNull()
    // Signed for another purpose, even with the right root key, it is no registration.
    const asCode = await new SignJWT({ r: [REDIRECT] }).setProtectedHeader({ alg: 'HS256' }).sign(await signingKey('oauth-code', ''))
    expect(await server.readClient(asCode)).toBeNull()
    const noList = await new SignJWT({ r: 'nope' }).setProtectedHeader({ alg: 'HS256' }).sign(await signingKey('oauth-client', ''))
    expect(await server.readClient(noList)).toBeNull()
  })

  it('answers over its route, uncached and readable from other sites, and says so when the body is not JSON', async () => {
    const ok = await registerRoute.POST(new Request(`${BASE}/api/oauth/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT] }) }))
    expect(ok.status).toBe(201)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.headers.get('access-control-allow-origin')).toBe('*')
    const bad = await registerRoute.POST(new Request(`${BASE}/api/oauth/register`, { method: 'POST', body: '{nope' }))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('invalid_client_metadata')
    expect(registerRoute.OPTIONS().status).toBe(204)
  })
})

describe('the approval page', () => {
  it('goes nowhere for a client it does not know, or a redirect the client did not register', async () => {
    const id = await register()
    for (const params of [
      await authoriseQuery('made-up'),
      await authoriseQuery(id, { client_id: null }),
      await authoriseQuery(id, { redirect_uri: 'https://evil.example/cb' }),
    ]) {
      const res = await authoriseGet(params)
      expect(res.status).toBe(400)
      expect(res.headers.get('location')).toBeNull()
      expect(await res.text()).toContain('could not start that sign-in')
    }
  })

  it('takes the one redirect a client registered when none is named, and not a guess among several', async () => {
    await signIn()
    const one = await register()
    expect((await authoriseGet(await authoriseQuery(one, { redirect_uri: null }))).status).toBe(200)
    const two = await register({ redirect_uris: [REDIRECT, 'http://localhost:9/cb'] })
    expect((await authoriseGet(await authoriseQuery(two, { redirect_uri: null }))).status).toBe(400)
  })

  it('shows a malformed request on its own page and sends the browser nowhere, since any client\'s redirect is anyone\'s address', async () => {
    const id = await register()
    const cases: [Record<string, string | null>, string][] = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ code_challenge: null }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ resource: 'https://other.example/api/mcp' }, 'invalid_target'],
    ]
    for (const [extra, error] of cases) {
      const res = await authoriseGet(await authoriseQuery(id, extra))
      expect(res.status, error).toBe(400)
      expect(res.headers.get('location'), error).toBeNull()
      expect(await res.text(), error).toContain(`(${error})`)
    }
  })

  it('takes the resource with or without its closing slash, or none at all', async () => {
    await signIn()
    const id = await register()
    expect((await authoriseGet(await authoriseQuery(id, { resource: `${BASE}/api/mcp/` }))).status).toBe(200)
    expect((await authoriseGet(await authoriseQuery(id, { resource: null }))).status).toBe(200)
  })

  it('asks anyone signed out to sign in first, and to come straight back here', async () => {
    const params = await authoriseQuery(await register())
    const res = await authoriseGet(params)
    expect(res.status).toBe(200)
    const page = await res.text()
    const back = encodeURIComponent(`/api/oauth/authorize?${params}`)
    expect(page).toContain(`/api/oauth/google?signin=1&amp;next=${back}`)
    expect(page).toContain(`/api/oauth/microsoft?signin=1&amp;next=${back}`)
    expect(page).not.toContain('name="consent"')
  })

  it('will not let an address that is no family member approve anything', async () => {
    process.env.ADMIN_EMAILS = 'boss@hearth.example'
    await createSession({ email: 'boss@hearth.example', name: 'Boss', provider: 'google', role: 'admin' })
    const page = await (await authoriseGet(await authoriseQuery(await register()))).text()
    expect(page).toContain('boss@hearth.example, which is not a family member here')
    expect(page).not.toContain('name="consent"')
  })

  it("shows a member who is asking, as whom, and where it sends them, and cannot be framed", async () => {
    await signIn()
    const res = await authoriseGet(await authoriseQuery(await register()))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('cache-control')).toBe('no-store')
    const page = await res.text()
    expect(page).toContain('<b>Claude</b> wants to act as <b>Rowan</b>')
    expect(page).toContain('claude.ai')
    expect(page).toContain('name="consent"')
    expect(page).toContain('value="allow"')
    expect(page).toContain('value="deny"')
  })

  it('escapes what a client calls itself, and names one that said nothing, or a native app by its scheme', async () => {
    await signIn()
    const nasty = await (await authoriseGet(await authoriseQuery(await register({ client_name: '<script>alert(1)</script>' })))).text()
    expect(nasty).not.toContain('<script>alert(1)')
    expect(nasty).toContain('&#60;script&#62;')
    const app = 'cursor://anysphere.cursor-retrieval/oauth/callback'
    const nameless = await server.registerClient({ redirect_uris: [app] })
    const page = await (await authoriseGet(await authoriseQuery(nameless.json.client_id as string, { redirect_uri: app }))).text()
    expect(page).toContain('<b>An MCP client</b>')
    expect(page).toContain('<b class="mono">cursor</b>')
  })
})

describe('answering the approval page', () => {
  it('sends a yes back to the client as a code, with its state and this issuer', async () => {
    await signIn()
    const params = await authoriseQuery(await register())
    const res = await authorisePost({ consent: await consentFor(params), decision: 'allow' })
    expect(res.status).toBe(303)
    const to = new URL(res.headers.get('location')!)
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT)
    expect(to.searchParams.get('code')).toBeTruthy()
    expect(to.searchParams.get('state')).toBe('st-123')
    expect(to.searchParams.get('iss')).toBe(BASE)
  })

  it('sends a no back as access_denied, with no code', async () => {
    await signIn()
    const res = await authorisePost({ consent: await consentFor(await authoriseQuery(await register())), decision: 'deny' })
    const to = new URL(res.headers.get('location')!)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('state')).toBe('st-123')
    expect(to.searchParams.get('code')).toBeNull()
  })

  it('carries no state back when the client sent none', async () => {
    await signIn()
    const res = await authorisePost({ consent: await consentFor(await authoriseQuery(await register(), { state: null })), decision: 'allow' })
    expect(new URL(res.headers.get('location')!).searchParams.has('state')).toBe(false)
  })

  it('refuses a page answered by someone signed out, or a token tampered with or meant for another member', async () => {
    await signIn()
    const token = await consentFor(await authoriseQuery(await register()))

    const ada = await q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
    await signIn('ada@hearth.example')
    const theirs = await authorisePost({ consent: token, decision: 'allow' })
    expect(theirs.status).toBe(400)
    expect(await theirs.text()).toContain('run out')
    expect(await server.decide(token, ada.id, true)).toBeNull()

    await signIn()
    expect((await authorisePost({ consent: `${token}x`, decision: 'allow' })).status).toBe(400)
    expect((await authorisePost({ decision: 'allow' })).status).toBe(400)
    const odd = await new SignJWT({ m: rowan.id, r: 5 }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(await signingKey('oauth-consent', ''))
    expect(await server.decide(odd, rowan.id, true)).toBeNull()

    jar.store.clear()
    const signedOut = await authorisePost({ consent: token, decision: 'allow' })
    expect(signedOut.status).toBe(401)
  })

  it('reads a form it cannot parse as no answer at all', async () => {
    await signIn()
    const res = await authorizeRoute.POST(new Request(`${BASE}/api/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: 'garbage' }))
    expect(res.status).toBe(400)
  })
})

describe('trading a code for a key', () => {
  it('issues a key in the approving member\'s name, listed under the client, that /api/mcp accepts until it is revoked', async () => {
    const { clientId, code } = await codeFor()
    const out = await server.exchangeToken(tokenForm({ code, client_id: clientId }))
    expect(out.status).toBe(200)
    expect(out.json.token_type).toBe('Bearer')
    const key = out.json.access_token as string
    const found = await q.memberByMcpKey(key)
    expect(found?.member.id).toBe(rowan.id)
    expect((await q.mcpKeysFor(rowan.id)).map((k) => k.label)).toEqual(['Claude, via sign-in'])

    const call = (bearer: string) =>
      MCP(new Request(`${BASE}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }))
    expect((await call(key)).status).toBe(200)
    await q.revokeMcpKey(rowan.id, found!.keyId)
    expect((await call(key)).status).toBe(401)
  })

  it('labels the key for a client that gave no name', async () => {
    const { clientId, code } = await codeFor({ client_name: undefined })
    await server.exchangeToken(tokenForm({ code, client_id: clientId }))
    expect((await q.mcpKeysFor(rowan.id)).map((k) => k.label)).toEqual(['MCP client, via sign-in'])
  })

  it('trades a code once only', async () => {
    const { clientId, code } = await codeFor()
    expect((await server.exchangeToken(tokenForm({ code, client_id: clientId }))).status).toBe(200)
    const again = await server.exchangeToken(tokenForm({ code, client_id: clientId }))
    expect(again).toEqual({ status: 400, json: { error: 'invalid_grant', error_description: 'That code has already been used.' } })
    expect(await q.mcpKeysFor(rowan.id)).toHaveLength(1)
  })

  it('refuses the wrong verifier, redirect or client, and anything but the code grant', async () => {
    const { clientId, code } = await codeFor()
    const other = await register({ client_name: 'Another client' })
    const cases: [URLSearchParams, string][] = [
      [tokenForm({ code, client_id: clientId, code_verifier: `${VERIFIER}x` }), 'invalid_grant'],
      [tokenForm({ code, client_id: clientId, code_verifier: 'too-short' }), 'invalid_grant'],
      [tokenForm({ code, client_id: clientId, redirect_uri: 'http://localhost:1/cb' }), 'invalid_grant'],
      [tokenForm({ code, client_id: other }), 'invalid_grant'],
      [tokenForm({ code }), 'invalid_grant'],
      [tokenForm({ code: 'made-up', client_id: clientId }), 'invalid_grant'],
      [tokenForm({ code, client_id: clientId, grant_type: 'refresh_token' }), 'unsupported_grant_type'],
    ]
    for (const [form, error] of cases) {
      const out = await server.exchangeToken(form)
      expect(out.status, form.toString()).toBe(400)
      expect(out.json.error).toBe(error)
    }
    // None of those spent the code: the right one still trades.
    expect((await server.exchangeToken(tokenForm({ code, client_id: clientId }))).status).toBe(200)
  })

  it('refuses a request missing its code or its verifier', async () => {
    const { clientId, code } = await codeFor()
    const noCode = tokenForm({ client_id: clientId })
    expect((await server.exchangeToken(noCode)).json.error).toBe('invalid_grant')
    const noVerifier = tokenForm({ code, client_id: clientId })
    noVerifier.delete('code_verifier')
    expect((await server.exchangeToken(noVerifier)).json.error_description).toBe('code_verifier does not match the challenge.')
  })

  it('refuses a code that carries no expiry: it is no code this server made, and could otherwise be traded for good', async () => {
    const clientId = await register()
    const key = await signingKey('oauth-code', '')
    const code = await new SignJWT({ m: rowan.id, c: clientId, r: REDIRECT, ch: await challengeOf(VERIFIER) })
      .setProtectedHeader({ alg: 'HS256' }).setJti('no-exp').sign(key)
    const out = await server.exchangeToken(tokenForm({ code, client_id: clientId }))
    expect(out.json).toEqual({ error: 'invalid_grant', error_description: 'That code is not one Hearth issued, or it has run out.' })
    expect(await q.getSetting('oauth_code:no-exp')).toBeNull()
    expect(await q.mcpKeysFor(rowan.id)).toEqual([])
  })

  it('refuses a code whose member was revoked before it was traded', async () => {
    const { clientId, code } = await codeFor()
    await q.saveMember({ id: rowan.id, name: 'Rowan', email: rowan.email, allowed: false, isAdmin: false })
    const out = await server.exchangeToken(tokenForm({ code, client_id: clientId }))
    expect(out.json).toEqual({ error: 'invalid_grant', error_description: 'Whoever approved this is no longer a member here.' })
    expect(await q.mcpKeysFor(rowan.id)).toEqual([])
  })

  it('refuses a code that has run out, or one minted without the parts a real one has', async () => {
    const clientId = await register()
    const key = await signingKey('oauth-code', '')
    const base = { m: rowan.id, c: clientId, r: REDIRECT, ch: await challengeOf(VERIFIER) }
    const expired = await new SignJWT(base).setProtectedHeader({ alg: 'HS256' }).setJti('j1').setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(key)
    expect((await server.exchangeToken(tokenForm({ code: expired, client_id: clientId }))).json.error).toBe('invalid_grant')
    const noJti = await new SignJWT(base).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(key)
    expect((await server.exchangeToken(tokenForm({ code: noJti, client_id: clientId }))).json.error_description).toBe('That code is not one Hearth issued, or it has run out.')
    const noMember = await new SignJWT({ ...base, m: 'x' }).setProtectedHeader({ alg: 'HS256' }).setJti('j2').setExpirationTime('5m').sign(key)
    expect((await server.exchangeToken(tokenForm({ code: noMember, client_id: clientId }))).json.error_description).toContain('no longer a member')
  })

  it('answers over its route, uncached, from a form or from JSON, and says so when it cannot read the request', async () => {
    const { clientId, code } = await codeFor()
    const form = await tokenRoute.POST(new Request(`${BASE}/api/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokenForm({ code, client_id: clientId }),
    }))
    expect(form.status).toBe(200)
    expect(form.headers.get('cache-control')).toBe('no-store')
    expect(form.headers.get('pragma')).toBe('no-cache')
    expect(form.headers.get('access-control-allow-origin')).toBe('*')
    expect((await form.json()).access_token).toBeTruthy()

    const second = await codeFor()
    const json = await tokenRoute.POST(new Request(`${BASE}/api/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(tokenForm({ code: second.code, client_id: second.clientId }))),
    }))
    expect(json.status).toBe(200)

    // A body sent with no type at all is read as the form OAuth says it is.
    const third = await codeFor()
    const untyped = await tokenRoute.POST(new Request(`${BASE}/api/oauth/token`, {
      method: 'POST', body: new TextEncoder().encode(tokenForm({ code: third.code, client_id: third.clientId }).toString()),
    }))
    expect(untyped.status).toBe(200)

    const broken = await tokenRoute.POST(new Request(`${BASE}/api/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }))
    expect(broken.status).toBe(400)
    expect((await broken.json()).error).toBe('invalid_request')
    expect(tokenRoute.OPTIONS().status).toBe(204)
  })
})

describe('forgetting used codes', () => {
  it('keeps a used code until it would have run out anyway, and nothing else is touched', async () => {
    const { clientId, code } = await codeFor()
    await server.exchangeToken(tokenForm({ code, client_id: clientId }))
    await q.setSetting('calendar_token', 'keep-me')
    await q.setSetting('last_tick_at', String(Date.now() - 86_400_000))
    const used = await client.query<{ key: string; value: string }>(`select key, value from settings where key like 'oauth_code:%'`)
    expect(used.rows).toHaveLength(1)
    const expiresAt = Number(used.rows[0].value)
    expect(expiresAt).toBeGreaterThan(Date.now())

    await server.pruneUsedCodes(new Date(expiresAt - 1000))
    expect((await client.query(`select key from settings where key like 'oauth_code:%'`)).rows).toHaveLength(1)
    expect((await server.exchangeToken(tokenForm({ code, client_id: clientId }))).json.error_description).toBe('That code has already been used.')
    await server.pruneUsedCodes(new Date(expiresAt + 1000))
    expect((await client.query(`select key from settings where key like 'oauth_code:%'`)).rows).toHaveLength(0)
    expect(await q.getSetting('calendar_token')).toBe('keep-me')
    expect(await q.getSetting('last_tick_at')).not.toBeNull()
    // Forgotten only once it is past its time, when its signature turns it away by itself.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(expiresAt + 1000)
      const late = await server.exchangeToken(tokenForm({ code, client_id: clientId }))
      expect(late.json.error_description).toBe('That code is not one Hearth issued, or it has run out.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes by now when told no time', async () => {
    await expect(server.pruneUsedCodes()).resolves.toBeUndefined()
  })
})
