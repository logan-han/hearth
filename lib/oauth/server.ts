import { SignJWT, jwtVerify } from 'jose'
import { and, like, sql } from 'drizzle-orm'
import { db } from '../db'
import { settings } from '../db/schema'
import { signingKey, randomToken } from '../crypto'
import { appUrl } from '../env'
import { memberById, issueMcpKey, MCP_KEY_LABEL_MAX } from '../db/queries'

/**
 * Hearth as its own OAuth 2.1 authorisation server for /api/mcp, so a client
 * that speaks the MCP authorisation spec (claude.ai's connectors, Claude
 * Desktop, Claude Code without a header) can sign its member in rather than
 * be handed a key. The token it ends with is an ordinary MCP key, made in the
 * member's name and listed with their keys on Home, where they revoke it.
 *
 * Everything a client registers, everything an approval binds and every code
 * is a signed token, not a row: registering, asking and failing cost no
 * database read, so junk sent every few minutes cannot keep Neon awake. Only
 * a code's one use is written down, so it cannot be traded twice.
 */

/**
 * Where an MCP client is sent when it is turned away without a key: the
 * protected-resource metadata for /api/mcp, at the path RFC 9728 gives a
 * resource with a path of its own.
 */
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/api/mcp'

const ALG = 'HS256'
/** How long an approval page may sit before its Allow stops working. */
const CONSENT_TTL = '10m'
/** How long a code may wait to be traded for a key. */
const CODE_TTL_S = 300

export const mcpResource = () => `${appUrl()}/api/mcp`

/** RFC 9728: what /api/mcp is, who issues its tokens, and how they travel. */
export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [appUrl()],
    bearer_methods_supported: ['header'],
    resource_name: 'Hearth',
    // A member can also make a key by hand on Home, under Claude and other MCP clients.
    resource_documentation: `${appUrl()}/connect`,
  }
}

/** RFC 8414: where to register, authorise and trade a code, and what this server takes. */
export function authorizationServerMetadata() {
  return {
    issuer: appUrl(),
    authorization_endpoint: `${appUrl()}/api/oauth/authorize`,
    token_endpoint: `${appUrl()}/api/oauth/token`,
    registration_endpoint: `${appUrl()}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${appUrl()}/connect`,
  }
}

/** Metadata and the token endpoint are read from browsers on other sites, as the spec expects. */
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, mcp-protocol-version',
  'Access-Control-Max-Age': '86400',
}

const key = (purpose: 'oauth-client' | 'oauth-consent' | 'oauth-code') => signingKey(purpose, '')

/* ----------------------------------------------------------- registration */

/** The longest name a client keeps; it lands on an approval page and a key's label. */
const CLIENT_NAME_MAX = 60
const MAX_REDIRECTS = 10

/** Schemes a redirect may never use, whatever the client says it is. */
const NEVER = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:'])

/**
 * Whether a client may be sent back here: https anywhere; plain http only to
 * this machine, for a native client listening on a loopback port; or a
 * native app's own scheme. Never one that runs or reads something in the
 * browser, never with a fragment, and never with a password in it.
 */
export function redirectAllowed(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash || url.username || url.password || NEVER.has(url.protocol)) return false
  if (url.protocol === 'https:') return Boolean(url.hostname)
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  // A native app's private-use scheme (RFC 8252), such as cursor://.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol)
}

export type RegisteredClient = { redirectUris: string[]; name: string | null }

/**
 * RFC 7591 dynamic registration. What a client registers is signed into its
 * client_id, so nothing is stored and a made-up id is known for one by its
 * signature. Every client is a public one, proving itself with PKCE.
 */
export async function registerClient(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const fail = (description: string, error = 'invalid_client_metadata') => ({ status: 400, json: { error, error_description: description } })
  if (!body || typeof body !== 'object') return fail('The registration must be a JSON object.')
  const meta = body as Record<string, unknown>
  const uris = meta.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECTS || !uris.every((u) => typeof u === 'string')) {
    return fail(`redirect_uris must list between 1 and ${MAX_REDIRECTS} addresses.`, 'invalid_redirect_uri')
  }
  const bad = (uris as string[]).find((u) => !redirectAllowed(u))
  if (bad !== undefined) return fail(`${bad} is not an address a client can be sent back to.`, 'invalid_redirect_uri')
  const grants = meta.grant_types
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes('authorization_code'))) {
    return fail('Only the authorization_code grant is offered here.')
  }
  const name = typeof meta.client_name === 'string' ? meta.client_name.replace(/\s+/g, ' ').trim().slice(0, CLIENT_NAME_MAX) || null : null

  const issuedAt = Math.floor(Date.now() / 1000)
  // Each registration its own id, even two alike in the same second.
  const clientId = await new SignJWT({ r: uris, ...(name ? { n: name } : {}) })
    .setProtectedHeader({ alg: ALG })
    .setJti(randomToken(12))
    .setIssuedAt(issuedAt)
    .sign(await key('oauth-client'))
  return {
    status: 201,
    json: {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      redirect_uris: uris,
      ...(name ? { client_name: name } : {}),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    },
  }
}

/** A client_id this server issued, read back, or null for one it did not. */
export async function readClient(clientId: string): Promise<RegisteredClient | null> {
  try {
    const { payload } = await jwtVerify(clientId, await key('oauth-client'), { algorithms: [ALG] })
    const r = payload.r
    if (!Array.isArray(r) || !r.every((u) => typeof u === 'string')) return null
    return { redirectUris: r as string[], name: typeof payload.n === 'string' ? payload.n : null }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------- authorise */

/** One authorisation request, checked: who asked, where the answer goes, and the PKCE challenge it must be traded with. */
export type AuthoriseRequest = {
  clientId: string
  client: RegisteredClient
  redirectUri: string
  state: string | null
  codeChallenge: string
}

/**
 * Check an authorisation request. A fault is shown on Hearth's own page and
 * the browser goes nowhere: every client here registered itself, so its
 * redirect is anyone's address, and sending a malformed request straight back
 * to it would make this endpoint a way to bounce anyone anywhere. Only a
 * member's own answer on the approval page sends them back to the client.
 */
export async function checkAuthorise(params: URLSearchParams): Promise<{ ok: AuthoriseRequest } | { page: string }> {
  const clientId = params.get('client_id') ?? ''
  const client = clientId ? await readClient(clientId) : null
  if (!client) return { page: 'That sign-in came from a client Hearth does not know. Start connecting it again from the client.' }
  const asked = params.get('redirect_uri')
  const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null)
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { page: 'That sign-in asked to go back to an address its client did not register, so Hearth will not send it there.' }
  }
  const state = params.get('state')
  const refused = (error: string, description: string) => ({ page: `The client asked in a way Hearth does not take (${error}): ${description}` })
  if (params.get('response_type') !== 'code') return refused('unsupported_response_type', 'only response_type=code is offered.')
  const codeChallenge = params.get('code_challenge') ?? ''
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge) || params.get('code_challenge_method') !== 'S256') {
    return refused('invalid_request', 'PKCE with code_challenge_method=S256 is required.')
  }
  const resource = params.get('resource')
  if (resource !== null && resource.replace(/\/$/, '') !== mcpResource()) return refused('invalid_target', `the only resource here is ${mcpResource()}.`)
  return { ok: { clientId, client, redirectUri, state, codeChallenge } }
}

/** A URL with these parameters added, leaving out the empty ones. */
function withParams(base: string, extra: Record<string, string | null>): string {
  const url = new URL(base)
  for (const [k, v] of Object.entries(extra)) if (v) url.searchParams.set(k, v)
  return url.toString()
}

/** Who a client says it is, and where it sends a member back to: the two things to judge it by. */
export function describeClient(req: AuthoriseRequest): { name: string; returnsTo: string } {
  const url = new URL(req.redirectUri)
  return { name: req.client.name ?? 'An MCP client', returnsTo: url.protocol === 'https:' || url.protocol === 'http:' ? url.host : url.protocol.replace(/:$/, '') }
}

/**
 * What the approval page's Allow carries: the checked request, bound to the
 * member who is looking at it, so the POST that follows cannot be made for
 * anyone else or for a request nobody checked.
 */
export async function consentToken(req: AuthoriseRequest, memberId: number): Promise<string> {
  return new SignJWT({ c: req.clientId, r: req.redirectUri, ch: req.codeChallenge, s: req.state, m: memberId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(CONSENT_TTL)
    .sign(await key('oauth-consent'))
}

/**
 * The member's answer on the approval page, as the URL to send them to: a
 * code for the client on a yes, access_denied on a no. Null when the page's
 * token is not one this server signed for this member, or has run out.
 */
export async function decide(token: string, memberId: number, allow: boolean): Promise<string | null> {
  let claims: Record<string, unknown>
  try {
    claims = (await jwtVerify(token, await key('oauth-consent'), { algorithms: [ALG] })).payload as Record<string, unknown>
  } catch {
    return null
  }
  if (claims.m !== memberId || typeof claims.r !== 'string' || typeof claims.c !== 'string' || typeof claims.ch !== 'string') return null
  const state = typeof claims.s === 'string' ? claims.s : null
  if (!allow) return withParams(claims.r, { error: 'access_denied', error_description: 'The member said no.', state, iss: appUrl() })
  const code = await new SignJWT({ m: memberId, c: claims.c, r: claims.r, ch: claims.ch })
    .setProtectedHeader({ alg: ALG })
    .setJti(randomToken(16))
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + CODE_TTL_S)
    .sign(await key('oauth-code'))
  return withParams(claims.r, { code, state, iss: appUrl() })
}

/* ----------------------------------------------------------------- token */

const S256 = async (verifier: string) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')

/**
 * Write down that a code has been used, and say whether this was its first
 * use. The row is kept until the code would have expired anyway.
 */
async function firstUse(jti: string, expiresAtMs: number): Promise<boolean> {
  const rows = await db()
    .insert(settings)
    .values({ key: `oauth_code:${jti}`, value: String(expiresAtMs) })
    .onConflictDoNothing()
    .returning({ key: settings.key })
  return rows.length > 0
}

/** Forget used codes once they would have expired: past then, their signature turns them away by itself. */
export async function pruneUsedCodes(now: Date = new Date()): Promise<void> {
  await db()
    .delete(settings)
    .where(and(like(settings.key, 'oauth_code:%'), sql`${settings.value}::bigint < ${now.getTime()}`))
}

/**
 * The token endpoint: trade a code for an MCP key. The code must be one this
 * server signed and not yet used, for this client and redirect, with the
 * verifier its challenge was made from, for a member still allowed. The key
 * is listed on Home under the client's name.
 */
export async function exchangeToken(form: URLSearchParams): Promise<{ status: number; json: Record<string, unknown> }> {
  const fail = (error: string, description: string, status = 400) => ({ status, json: { error, error_description: description } })
  if (form.get('grant_type') !== 'authorization_code') return fail('unsupported_grant_type', 'Only authorization_code is offered.')
  const code = form.get('code') ?? ''
  let claims: Record<string, unknown>
  try {
    claims = (await jwtVerify(code, await key('oauth-code'), { algorithms: [ALG] })).payload as Record<string, unknown>
  } catch {
    return fail('invalid_grant', 'That code is not one Hearth issued, or it has run out.')
  }
  const clientId = form.get('client_id')
  if (!clientId || clientId !== claims.c) return fail('invalid_grant', 'That code was issued to another client.')
  if (form.get('redirect_uri') !== claims.r) return fail('invalid_grant', 'redirect_uri does not match the one the code was issued for.')
  const verifier = form.get('code_verifier') ?? ''
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (await S256(verifier)) !== claims.ch) {
    return fail('invalid_grant', 'code_verifier does not match the challenge.')
  }
  // A code is good once, and only until it expires: one with no expiry, or
  // no id to remember its use by, is no code this server made.
  if (typeof claims.jti !== 'string' || !claims.jti || typeof claims.exp !== 'number') {
    return fail('invalid_grant', 'That code is not one Hearth issued, or it has run out.')
  }
  if (!(await firstUse(claims.jti, claims.exp * 1000))) return fail('invalid_grant', 'That code has already been used.')
  const memberId = typeof claims.m === 'number' ? claims.m : 0
  const member = memberId ? await memberById(memberId) : undefined
  if (!member?.allowed) return fail('invalid_grant', 'Whoever approved this is no longer a member here.')
  const client = await readClient(clientId)
  const label = `${client?.name ?? 'MCP client'}, via sign-in`.slice(0, MCP_KEY_LABEL_MAX)
  const { key: accessToken } = await issueMcpKey(member.id, label)
  return { status: 200, json: { access_token: accessToken, token_type: 'Bearer' } }
}
