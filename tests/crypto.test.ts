import { describe, it, expect, beforeEach } from 'vitest'
import { encrypt, decrypt, randomToken, resetKeyCache } from '@/lib/crypto'

const HEX_KEY = 'a'.repeat(64)
const B64_KEY = Buffer.alloc(32, 7).toString('base64')

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = HEX_KEY
  resetKeyCache()
})

describe('AES-256-GCM token encryption', () => {
  it('round-trips a refresh token', async () => {
    const secret = '1//0abcdefgh_refresh-token.value~123'
    expect(await decrypt(await encrypt(secret))).toBe(secret)
  })

  it('round-trips unicode and long values', async () => {
    const secret = `naïve ${'x'.repeat(4000)} 🔥`
    expect(await decrypt(await encrypt(secret))).toBe(secret)
  })

  it('produces a different ciphertext each time (random IV)', async () => {
    const a = await encrypt('same')
    const b = await encrypt('same')
    expect(a).not.toBe(b)
    expect(await decrypt(a)).toBe(await decrypt(b))
  })

  it('accepts a base64 key as well as hex', async () => {
    process.env.TOKEN_ENC_KEY = B64_KEY
    resetKeyCache()
    expect(await decrypt(await encrypt('hello'))).toBe('hello')
  })

  it('fails to decrypt when the key changes', async () => {
    const sealed = await encrypt('secret')
    process.env.TOKEN_ENC_KEY = 'b'.repeat(64)
    resetKeyCache()
    await expect(decrypt(sealed)).rejects.toThrow()
  })

  it('rejects a tampered ciphertext', async () => {
    const sealed = await encrypt('secret')
    const bytes = Buffer.from(sealed, 'base64')
    bytes[bytes.length - 1] ^= 0xff
    await expect(decrypt(bytes.toString('base64'))).rejects.toThrow()
  })

  it('rejects a truncated payload', async () => {
    await expect(decrypt(Buffer.alloc(8).toString('base64'))).rejects.toThrow('ciphertext too short')
  })

  it('rejects a key of the wrong length', async () => {
    process.env.TOKEN_ENC_KEY = 'abcd'
    resetKeyCache()
    await expect(encrypt('x')).rejects.toThrow(/32 bytes/)
  })
})

describe('randomToken', () => {
  it('is url-safe and unique', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()))
    expect(tokens.size).toBe(200)
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
