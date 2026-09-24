import { getSetting, setSetting } from '../db/queries'
import { hashToken, randomToken, signingKey } from '../crypto'

/**
 * The epoch every session and /connect link is signed under. Unset until the
 * first sign-out everywhere, and replaced by each one after.
 */
const EPOCH = 'signing_epoch'

/**
 * The key a session or an OAuth state is signed and checked with. It takes no
 * epoch, so a made-up cookie or state is turned away by its signature before
 * anything is read: a read keeps the database awake, and junk sent every few
 * minutes would run out the free plan's compute hours. The epoch rides in the
 * token instead (see epochMark), and is looked at only once the signature
 * has checked.
 */
export async function signingSecret(purpose: 'session' | 'oauth-state'): Promise<Uint8Array> {
  return signingKey(purpose, '')
}

/**
 * What a token carries of the epoch in force as it is signed: nothing before
 * the first sign-out everywhere, a digest after, so the stored value itself
 * never leaves the store.
 */
export async function epochMark(): Promise<string> {
  const epoch = await getSetting(EPOCH)
  return epoch ? (await hashToken(epoch)).slice(0, 32) : ''
}

/** Whether a token whose signature has checked was signed in the epoch still in force. */
export async function inThisEpoch(mark: unknown): Promise<boolean> {
  return (typeof mark === 'string' ? mark : '') === (await epochMark())
}

/**
 * End every dashboard session and void every /connect link still out, by
 * moving the epoch they were signed under. Before, the only lever was
 * replacing TOKEN_ENC_KEY, and with it every stored refresh token and setting.
 */
export async function signOutEverywhere(): Promise<void> {
  await setSetting(EPOCH, randomToken(24))
}
