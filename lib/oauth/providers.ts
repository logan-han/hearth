import { required, appUrl } from '../env'
import { deadline } from '../deadline'

export type Provider = 'google' | 'microsoft'

/** One OAuth client: what it is asked for, and who it is. */
export type OAuthClient = {
  scopes: string[]
  clientId: () => string
  clientSecret: () => string
  /** Extra params on the authorisation request. */
  authExtras: Record<string, string>
}

export type ProviderConfig = OAuthClient & {
  id: Provider
  label: string
  /** How the family names a calendar there: "Rowan's Google Calendar", never "google". */
  calendar: string
  authUrl: string
  tokenUrl: string
  /**
   * The client that signs a member in to the dashboard, when it is not the one
   * that links their calendar. Left out, signing in is the link's own round
   * trip, and a sign-in that brings back a refresh token links the calendar too.
   */
  signin?: OAuthClient
}

/** Why the round trip is happening: it decides what to ask the provider for. */
export type AuthPurpose = 'link' | 'signin'

/**
 * Google takes an AI agent's calendar calls only through its MCP server, and
 * that takes only tokens from a client marked as an agent's ("Use this client
 * for an AI-powered agent"). A marked client is to carry no other feature, so
 * signing in to the dashboard has a client of its own.
 */
export const GOOGLE: ProviderConfig = {
  id: 'google',
  label: 'Google',
  calendar: 'Google Calendar',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ],
  clientId: () => required('GOOGLE_AGENT_CLIENT_ID'),
  clientSecret: () => required('GOOGLE_AGENT_CLIENT_SECRET'),
  // access_type=offline + prompt=consent is what actually yields a refresh
  // token. Only these scopes are asked for, so a relink drops anything an
  // older link had been granted besides.
  authExtras: { access_type: 'offline', prompt: 'consent' },
  // Only who is signing in, so the consent screen shows once and after that
  // Google just picks the account.
  signin: {
    scopes: ['openid', 'email'],
    clientId: () => required('GOOGLE_CLIENT_ID'),
    clientSecret: () => required('GOOGLE_CLIENT_SECRET'),
    authExtras: {},
  },
}

export const MICROSOFT: ProviderConfig = {
  id: 'microsoft',
  label: 'Microsoft',
  calendar: 'Outlook Calendar',
  // /common so both personal Microsoft accounts and work/school tenants work.
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: [
    'offline_access',
    'openid',
    'email',
    'User.Read',
    'Calendars.ReadWrite',
  ],
  clientId: () => required('MS_CLIENT_ID'),
  clientSecret: () => required('MS_CLIENT_SECRET'),
  authExtras: { response_mode: 'query' },
}

export function providerConfig(p: Provider): ProviderConfig {
  return p === 'google' ? GOOGLE : MICROSOFT
}

/** The client a round trip of this purpose goes through. */
function clientFor(p: Provider, purpose: AuthPurpose): OAuthClient {
  const c = providerConfig(p)
  return purpose === 'signin' && c.signin ? c.signin : c
}

/** Whether signing in with this provider is the calendar link's own round trip, and so can link the calendar as well. */
export function signinLinks(p: Provider): boolean {
  return !providerConfig(p).signin
}

export function redirectUri(p: Provider): string {
  return `${appUrl()}/api/oauth/${p}/callback`
}

export function authorizeUrl(p: Provider, state: string, purpose: AuthPurpose = 'link'): string {
  const client = clientFor(p, purpose)
  const url = new URL(providerConfig(p).authUrl)
  url.searchParams.set('client_id', client.clientId())
  url.searchParams.set('redirect_uri', redirectUri(p))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', client.scopes.join(' '))
  url.searchParams.set('state', state)
  for (const [k, v] of Object.entries(client.authExtras)) url.searchParams.set(k, v)
  return url.toString()
}

export type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  id_token?: string
}

/** A token endpoint's refusal, with the OAuth error code it gave (invalid_grant, say) when it gave one. */
export class TokenRequestError extends Error {
  constructor(message: string, public status: number, public code: string | null) {
    super(message)
    this.name = 'TokenRequestError'
  }
}

async function tokenRequest(p: Provider, client: OAuthClient, body: Record<string, string>): Promise<TokenResponse> {
  const c = providerConfig(p)
  const res = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId(),
      client_secret: client.clientSecret(),
      ...body,
    }),
    signal: deadline(),
  })
  const text = await res.text()
  if (!res.ok) {
    let code: string | null = null
    try {
      const parsed = JSON.parse(text) as { error?: unknown }
      if (typeof parsed.error === 'string') code = parsed.error
    } catch {
      // Not JSON; the status and the text are all there is.
    }
    throw new TokenRequestError(`${c.label} token request failed (${res.status}): ${text.slice(0, 400)}`, res.status, code)
  }
  return JSON.parse(text) as TokenResponse
}

/** A code goes back through the client it was issued to, which is the one its round trip's purpose chose. */
export function exchangeCode(p: Provider, code: string, purpose: AuthPurpose = 'link'): Promise<TokenResponse> {
  return tokenRequest(p, clientFor(p, purpose), {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(p),
  })
}

/** Only a link's refresh token is ever stored, so a refresh always goes through the link's client. */
export function refreshAccessToken(p: Provider, refreshToken: string): Promise<TokenResponse> {
  const body: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken }
  // Graph wants the scopes restated on refresh; Google rejects them.
  if (p === 'microsoft') body.scope = MICROSOFT.scopes.join(' ')
  return tokenRequest(p, providerConfig(p), body)
}

/** Best-effort email extraction from an id_token, avoiding an extra userinfo call. */
export function emailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null
  try {
    const payload = idToken.split('.')[1]
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return json.email ?? json.preferred_username ?? json.upn ?? null
  } catch {
    return null
  }
}
