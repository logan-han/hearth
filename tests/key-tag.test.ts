import { describe, it, expect, beforeEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'

const { mintMcpKey, mcpKeyHolder, resetKeyCache } = await import('@/lib/crypto')
const q = await import('@/lib/db/queries')

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = 'c'.repeat(64)
  resetKeyCache()
})

/** Every other spelling of a key's last character. */
const respelt = (key: string) =>
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    .split('')
    .filter((c) => c !== key.at(-1))
    .map((c) => `${key.slice(0, -1)}${c}`)

describe('an MCP key tag', () => {
  it('is checked as minted: no other spelling of it passes, even one that decodes to the same bytes', async () => {
    const key = await mintMcpKey(3)
    expect(await mcpKeyHolder(key)).toBe(3)
    for (const other of respelt(key)) expect(await mcpKeyHolder(other)).toBeNull()
  })
})

describe('changing a member by id', () => {
  let client: PGlite
  beforeEach(async () => {
    client = (await freshDb()).client
    return () => closeDb(client)
  })

  it('refuses one who is not there rather than adding them again', async () => {
    await expect(q.saveMember({ id: 999, name: 'Gone', email: 'gone@example.com', allowed: true, isAdmin: false })).rejects.toThrow('No member 999.')
    expect(await q.allMembers()).toEqual([])
  })
})
