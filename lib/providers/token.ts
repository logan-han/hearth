import { connectionFor, decryptRefreshToken } from '../db/queries'
import { refreshAccessToken, type Provider } from '../oauth/providers'

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

export async function accessTokenFor(memberId: number, provider: Provider): Promise<string> {
  const key = `${memberId}:${provider}`
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token

  const conn = await connectionFor(memberId, provider)
  if (!conn) throw new NotConnectedError(provider)

  const refresh = await decryptRefreshToken(conn)
  const res = await refreshAccessToken(provider, refresh)
  const expiresAt = Date.now() + (res.expires_in ?? 3600) * 1000
  cache.set(key, { token: res.access_token, expiresAt })
  return res.access_token
}

export function clearTokenCache(): void {
  cache.clear()
}
