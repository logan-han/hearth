import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

// Two tools no real one is like: one that answers in plain words, and one
// with no description at all, to see how each reaches a client.
vi.mock('@/lib/tools', async (orig) => {
  const actual = await orig<typeof import('@/lib/tools')>()
  return {
    ...actual,
    buildTools: (ctx: Parameters<typeof actual.buildTools>[0]) => ({
      ...actual.buildTools(ctx),
      say_plainly: { description: 'Answers in plain words rather than an object.', inputSchema: z.object({}), execute: async () => 'just words' },
      undescribed: { inputSchema: z.object({}), execute: async () => ({ ok: true }) },
    }),
    allToolNames: () => [...actual.allToolNames(), 'say_plainly', 'undescribed'],
  }
})
vi.mock('@/lib/settings', async (orig) => ({ ...(await orig<typeof import('@/lib/settings')>()), hydrateSecrets: async () => {} }))

const { callTool, descriptors } = await import('@/lib/mcp')
const member = { id: 1, name: 'Rowan', email: null, allowed: true, isAdmin: false, createdAt: new Date(0) }

describe('how a tool reaches a client', () => {
  it('hands back an answer that is already words as it is, and an object as JSON', async () => {
    expect((await callTool('say_plainly', {}, { member, keyId: 1 })).content[0].text).toBe('just words')
    expect((await callTool('undescribed', {}, { member, keyId: 1 })).content[0].text).toBe('{\n  "ok": true\n}')
  })

  it('lists a tool with no description by its name, with an empty one', () => {
    expect(descriptors().find((d) => d.name === 'undescribed')).toMatchObject({ description: '' })
  })
})
