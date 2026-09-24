import { getSetting, setSetting } from '../db/queries'
import { randomToken, signingKey } from '../crypto'

/**
 * The epoch every session and OAuth state is signed under, beside the key
 * each derives from TOKEN_ENC_KEY. Unset until the first sign-out everywhere,
 * and replaced by each one after.
 */
const EPOCH = 'signing_epoch'

/** The key a session or an OAuth state is signed and checked with, as of now. */
export async function signingSecret(purpose: 'session' | 'oauth-state'): Promise<Uint8Array> {
  return signingKey(purpose, (await getSetting(EPOCH)) ?? '')
}

/**
 * End every dashboard session and void every /connect link still out, by
 * moving the epoch they were signed under. Before, the only lever was
 * replacing TOKEN_ENC_KEY, and with it every stored refresh token and setting.
 */
export async function signOutEverywhere(): Promise<void> {
  await setSetting(EPOCH, randomToken(24))
}
