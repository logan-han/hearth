import { required, appUrl } from '../env'

export type Provider = 'google' | 'microsoft'

export type ProviderConfig = {
  id: Provider
  label: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: () => string
  clientSecret: () => string
  /** Extra params on the authorisation request. */
  authExtras: Record<string, string>
}

export const GOOGLE: ProviderConfig = {
  id: 'google',
  label: 'Google',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
  ],
  clientId: () => required('GOOGLE_CLIENT_ID'),
  clientSecret: () => required('GOOGLE_CLIENT_SECRET'),
  // access_type=offline + prompt=consent is what actually yields a refresh_token.
  authExtras: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
}

export const MICROSOFT: ProviderConfig = {
  id: 'microsoft',
  label: 'Microsoft',
  // /common so both personal Microsoft accounts and work/school tenants work.
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scopes: [
    'offline_access',
    'openid',
    'email',
    'User.Read',
    'Mail.ReadWrite',
    'Mail.Send',
    'Calendars.ReadWrite',
  ],
  clientId: () => required('MS_CLIENT_ID'),
  clientSecret: () => required('MS_CLIENT_SECRET'),
  authExtras: { response_mode: 'query' },
}

export function providerConfig(p: Provider): ProviderConfig {
  return p === 'google' ? GOOGLE : MICROSOFT
}

export function redirectUri(p: Provider): string {
  return `${appUrl()}/api/oauth/${p}/callback`
}

export function authorizeUrl(p: Provider, state: string): string {
  const c = providerConfig(p)
  const url = new URL(c.authUrl)
  url.searchParams.set('client_id', c.clientId())
  url.searchParams.set('redirect_uri', redirectUri(p))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', c.scopes.join(' '))
  url.searchParams.set('state', state)
  for (const [k, v] of Object.entries(c.authExtras)) url.searchParams.set(k, v)
  return url.toString()
}

export type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  id_token?: string
}

async function tokenRequest(p: Provider, body: Record<string, string>): Promise<TokenResponse> {
  const c = providerConfig(p)
  const res = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId(),
      client_secret: c.clientSecret(),
      ...body,
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${c.label} token request failed (${res.status}): ${text.slice(0, 400)}`)
  return JSON.parse(text) as TokenResponse
}

export function exchangeCode(p: Provider, code: string): Promise<TokenResponse> {
  return tokenRequest(p, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(p),
  })
}

export function refreshAccessToken(p: Provider, refreshToken: string): Promise<TokenResponse> {
  const body: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken }
  // Graph wants the scopes restated on refresh; Google rejects them.
  if (p === 'microsoft') body.scope = MICROSOFT.scopes.join(' ')
  return tokenRequest(p, body)
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
