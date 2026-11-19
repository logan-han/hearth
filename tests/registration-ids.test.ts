import { describe, it, expect, beforeEach } from 'vitest'

const server = await import('@/lib/oauth/server')
const { resetKeyCache } = await import('@/lib/crypto')

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = 'd'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  resetKeyCache()
})

describe('dynamic client registration', () => {
  it('gives two registrations alike, in the same second, ids of their own that both read back', async () => {
    const meta = { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' }
    const [a, b] = await Promise.all([server.registerClient(meta), server.registerClient(meta)])
    expect(a.status).toBe(201)
    expect(a.json.client_id).not.toBe(b.json.client_id)
    for (const id of [a.json.client_id, b.json.client_id]) {
      expect(await server.readClient(String(id))).toEqual({ redirectUris: meta.redirect_uris, name: 'Claude' })
    }
  })
})
