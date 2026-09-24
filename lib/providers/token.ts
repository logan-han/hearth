import { connectionFor, decryptRefreshToken, updateRefreshToken } from '../db/queries'
import { refreshAccessToken, TokenRequestError, type Provider } from '../oauth/providers'
import { describeError } from '../errors'

type CacheEntry = { token: string; expiresAt: number }

// Access tokens live ~1h; caching within a single warm lambda avoids a refresh
// round-trip on every tool call.
const cache = new Map<string, CacheEntry>()

export class NotConnectedError extends Error {
  constructor(public provider: Provider) {
    super(`No ${provider} account linked`)
    this.name = 'NotConnectedError'
  }
}

/** The link is there but the provider no longer honours it: expired, revoked, or the password changed. */
export class ReconnectNeededError extends Error {
  constructor(public provider: Provider) {
    super(`The ${provider} link has expired or been revoked`)
    this.name = 'ReconnectNeededError'
  }
}

/**
 * How a token endpoint says only the member can fix this: the grant expired
 * or was revoked, or Microsoft wants them to sign in or consent again.
 */
const RECONNECT = new Set(['invalid_grant', 'interaction_required', 'consent_required', 'login_required'])

export async function accessTokenFor(memberId: number, provider: Provider): Promise<string> {
  const key = `${memberId}:${provider}`
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token

  const conn = await connectionFor(memberId, provider)
  if (!conn) throw new NotConnectedError(provider)

  const refresh = await decryptRefreshToken(conn)
  let res
  try {
    res = await refreshAccessToken(provider, refresh)
  } catch (err) {
    if (err instanceof TokenRequestError && err.code && RECONNECT.has(err.code)) throw new ReconnectNeededError(provider)
    throw err
  }
  const expiresAt = Date.now() + (res.expires_in ?? 3600) * 1000
  cache.set(key, { token: res.access_token, expiresAt })

  // Microsoft hands back a new refresh token on every refresh, and each one
  // lasts 90 days from its own issue. Keep presenting the one from the day of
  // linking and the link dies three months in. Google usually sends none.
  if (res.refresh_token && res.refresh_token !== refresh) {
    try {
      await updateRefreshToken(memberId, provider, res.refresh_token)
    } catch (err) {
      // The access token is good either way, and the old refresh token still
      // works until its own expiry; the next refresh tries the save again.
      console.error(`[token] could not store the rotated ${provider} refresh token:`, describeError(err))
    }
  }
  return res.access_token
}

export function clearTokenCache(): void {
  cache.clear()
}
