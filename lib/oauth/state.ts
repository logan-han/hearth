import { SignJWT, jwtVerify } from 'jose'
import { required } from '../env'

const ALG = 'HS256'

function secret(): Uint8Array {
  return new TextEncoder().encode(required('TOKEN_ENC_KEY'))
}

/**
 * `purpose` separates the two things this round trip is used for: linking a
 * family member's mailbox, and signing in to the web dashboard. Both go through
 * the same provider callback so the OAuth consoles need only one redirect URI
 * registered.
 */
export type StatePayload = { tg: string; name: string; chat: string; purpose?: 'link' | 'signin' }

/** Signed, short-lived state binding an OAuth round-trip to one Telegram user. */
export async function signState(payload: StatePayload, ttl = '10m'): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret())
}

/**
 * Verify a state, and when `expect` is given, that it was minted for that
 * purpose. A sign-in state is handed to anyone who asks, so a consumer that
 * acts for a Telegram member must say so here: otherwise that anonymous state
 * passes as a link bound to nobody.
 */
export async function verifyState(token: string, expect?: 'link' | 'signin'): Promise<StatePayload> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] })
  const { tg, name, chat, purpose } = payload as Record<string, unknown>
  const kind = purpose === 'signin' ? 'signin' : 'link'
  if (expect && kind !== expect) throw new Error(`state is for ${kind}, not ${expect}`)
  // Signing in is not bound to a Telegram account, so only the linking flow
  // requires one, and an empty id binds nothing.
  if (kind === 'link' && (typeof tg !== 'string' || !tg.trim())) throw new Error('state missing telegram id')
  return {
    tg: typeof tg === 'string' ? tg : '',
    name: typeof name === 'string' ? name : 'Family member',
    chat: typeof chat === 'string' ? chat : '',
    purpose: kind,
  }
}

/** The /connect deep link handed to a member over DM. */
export async function connectLink(base: string, payload: StatePayload): Promise<string> {
  return `${base}/connect?t=${encodeURIComponent(await signState(payload, '30m'))}`
}
