import { SignJWT, jwtVerify } from 'jose'
import { signingSecret, epochMark, inThisEpoch } from '../auth/keys'

const ALG = 'HS256'

const secret = () => signingSecret('oauth-state')

/**
 * `purpose` separates the two things this round trip is used for: signing in
 * to the dashboard, and a signed-in member linking a calendar. Both go through
 * the same provider callback so the OAuth consoles need only one redirect URI
 * registered. A sign-in may carry `next`, the page to land on afterwards (an
 * MCP client's approval page, say); a link carries the member it is for.
 */
export type StatePayload =
  | { purpose: 'signin'; next?: string }
  | { purpose: 'link'; member: number }

/**
 * Where a sign-in may send its member afterwards: a page on this site, never
 * another one. A path starting with one slash, and not two (`//host` is
 * another site), with nothing in it a browser would read as a new origin.
 */
export function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = value.trim()
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\s]/.test(path) || path.length > 2000) return undefined
  return path
}

/**
 * Signed, short-lived state for one OAuth round trip. A sign-in state is
 * handed to anyone who asks and binds nobody, so it carries no epoch and
 * costs no read; a link carries one, so signing out everywhere voids it.
 */
export async function signState(payload: StatePayload, ttl = '10m'): Promise<string> {
  const claims =
    payload.purpose === 'signin'
      ? { purpose: 'signin', ...(safeNext(payload.next) ? { next: safeNext(payload.next) } : {}) }
      : { purpose: 'link', member: payload.member, ep: await epochMark() }
  return new SignJWT(claims).setProtectedHeader({ alg: ALG }).setIssuedAt().setExpirationTime(ttl).sign(await secret())
}

/**
 * Verify a state, and when `expect` is given, that it was minted for that
 * purpose. A sign-in state is handed to anyone who asks, so a consumer that
 * acts for a member must say so here: otherwise that anonymous state passes
 * as a link bound to nobody.
 */
export async function verifyState(token: string, expect?: StatePayload['purpose']): Promise<StatePayload> {
  const { payload } = await jwtVerify(token, await secret(), { algorithms: [ALG] })
  const { purpose, member, next, ep } = payload as Record<string, unknown>
  const kind = purpose === 'signin' ? 'signin' : 'link'
  if (expect && kind !== expect) throw new Error(`state is for ${kind}, not ${expect}`)
  if (kind === 'signin') {
    const to = safeNext(next)
    return to ? { purpose: 'signin', next: to } : { purpose: 'signin' }
  }
  if (!(await inThisEpoch(ep))) throw new Error('state signed before everyone was signed out')
  if (typeof member !== 'number' || !Number.isInteger(member) || member < 1) throw new Error('state names no member')
  return { purpose: 'link', member }
}
