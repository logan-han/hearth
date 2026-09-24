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

/**
 * A key for signing one kind of token, derived from TOKEN_ENC_KEY by HKDF
 * rather than being it. Each purpose gets its own, so a session can never
 * pass as OAuth state or the other way round, and the salt is an epoch the
 * caller stores: changing it voids everything signed before, while the key
 * that decrypts every stored refresh token and setting stays as it was.
 */
export async function signingKey(purpose: 'session' | 'oauth-state' | 'mcp', epoch: string): Promise<Uint8Array> {
  const root = await crypto.subtle.importKey('raw', keyMaterial() as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(epoch),
      info: new TextEncoder().encode(`hearth ${purpose}`),
    },
    root,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * The key an MCP key's tag is made and checked with. It takes no epoch: the
 * tag exists to be checked before anything is read, and the epoch is in the
 * store. Nor does it need one, since the stored hash is what revokes a key
 * (see memberByMcpKey). Only TOKEN_ENC_KEY goes into it, which is always in
 * the environment and never in the store, so an instance that has not read
 * the store yet checks keys the same as one that has.
 */
async function mcpTagKey(): Promise<CryptoKey> {
  const raw = await signingKey('mcp', '')
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/**
 * A new key for the MCP endpoint, `<member id>.<random>.<tag>`, the tag an HMAC
 * over the first two. Only a key minted here carries a tag that checks, so one
 * that was made up is known for what it is without a database read.
 */
export async function mintMcpKey(memberId: number): Promise<string> {
  const body = `${memberId}.${randomToken(32)}`
  const tag = await crypto.subtle.sign('HMAC', await mcpTagKey(), new TextEncoder().encode(body))
  return `${body}.${Buffer.from(tag).toString('base64url')}`
}

/**
 * The member an MCP key was minted for, or null when its tag does not check,
 * worked out from the key alone. A key from before keys carried a tag has none,
 * so it is null too. A key that checks may still have been replaced or revoked
 * since; only the stored hash can say that.
 */
export async function mcpKeyHolder(key: string): Promise<number | null> {
  const parts = /^(\d+)\.([\w-]+)\.([\w-]{43})$/.exec(key)
  if (!parts) return null
  const [, id, random, tag] = parts
  const ok = await crypto.subtle.verify(
    'HMAC',
    await mcpTagKey(),
    Buffer.from(tag, 'base64url'),
    new TextEncoder().encode(`${id}.${random}`),
  )
  return ok ? Number(id) : null
}

/** URL-safe random token, used for the ICS feed address. */
export function randomToken(bytes = 24): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .toString('base64url')
}

/**
 * One-way digest of a bearer token. Encryption would let anyone holding
 * TOKEN_ENC_KEY read the key back out; a hash only ever answers "is this it?",
 * which is all the MCP endpoint asks.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Buffer.from(digest).toString('hex')
}
