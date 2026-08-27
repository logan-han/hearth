/**
 * AES-256-GCM helpers for encrypting OAuth refresh tokens at rest.
 * Uses WebCrypto so the same code runs on Node and edge runtimes.
 *
 * Wire format: base64( iv[12] || ciphertext || tag[16] )
 */
import { required } from './env'

const IV_BYTES = 12

let cached: Promise<CryptoKey> | null = null

function keyMaterial(): Uint8Array {
  const raw = required('TOKEN_ENC_KEY').trim()
  // Accept either 64 hex chars or base64 of 32 bytes.
  const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Uint8Array.from(raw.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
    : Uint8Array.from(Buffer.from(raw, 'base64'))
  if (bytes.length !== 32) {
    throw new Error('TOKEN_ENC_KEY must decode to 32 bytes (64 hex chars or base64)')
  }
  return bytes
}

function getKey(): Promise<CryptoKey> {
  if (!cached) {
    cached = crypto.subtle.importKey('raw', keyMaterial() as BufferSource, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ])
  }
  return cached
}

/** Test seam: drop the memoised key when TOKEN_ENC_KEY changes. */
export function resetKeyCache(): void {
  cached = null
}

export async function encrypt(plaintext: string): Promise<string> {
  const key = await getKey()
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  )
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return Buffer.from(out).toString('base64')
}

export async function decrypt(payload: string): Promise<string> {
  const key = await getKey()
  const bytes = Uint8Array.from(Buffer.from(payload, 'base64'))
  if (bytes.length <= IV_BYTES) throw new Error('ciphertext too short')
  const iv = bytes.subarray(0, IV_BYTES)
  const ct = bytes.subarray(IV_BYTES)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(pt)
}

/** URL-safe random token, used for the ICS feed address. */
export function randomToken(bytes = 24): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .toString('base64url')
}
