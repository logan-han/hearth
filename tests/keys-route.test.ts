import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { Member } from '@/lib/db/schema'
import { jar } from './helpers/next-headers'

vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))

const { GET, POST, DELETE } = await import('@/app/api/mcp-keys/route')
const { POST: MCP } = await import('@/app/api/mcp/route')
const { createSession } = await import('@/lib/auth/session')

let client: PGlite
let rowan: Member

// The handlers' types allow for no answer at all; every path here answers.
const list = async () => (await GET())!
const make = async (body: unknown, raw?: string) =>
  (await POST(new Request('https://hearth.example/api/mcp-keys', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body),
  })))!
const revoke = async (id: unknown) => (await DELETE(new Request(`https://hearth.example/api/mcp-keys?id=${id}`, { method: 'DELETE' })))!

const signIn = (email: string, role: 'admin' | 'member' = 'member') => createSession({ email, name: email, provider: 'google', role })

/** One call to the MCP endpoint with this key, the way a client makes it. */
async function rpc(key: string, method: string, params: unknown = {}) {
  const res = await MCP(new Request('https://hearth.example/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }))
  const body = await res.text()
  const json = body.includes('data:') ? JSON.parse(body.split('\n').find((l) => l.startsWith('data:'))!.slice(5)) : body && JSON.parse(body)
  return { status: res.status, json }
}

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  process.env.TIMEZONE = 'Australia/Melbourne'
  delete process.env.ADMIN_EMAILS
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
  rowan = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
})
afterEach(async () => closeDb(client))

describe('who may manage keys', () => {
  it('refuses everything signed out', async () => {
    expect((await list()).status).toBe(401)
    expect((await make({ label: 'Laptop' })).status).toBe(401)
    expect((await revoke(1)).status).toBe(401)
    expect(await q.mcpKeysFor(rowan.id)).toEqual([])
  })

  it('refuses an ADMIN_EMAILS address with no member behind it, since a key acts as a member', async () => {
    process.env.ADMIN_EMAILS = 'boss@hearth.example'
    await signIn('boss@hearth.example', 'admin')
    for (const res of [await list(), await make({ label: 'Laptop' }), await revoke(1)]) {
      expect(res.status).toBe(403)
      expect((await res.json()).error).toContain('A key acts as a family member')
    }
  })

  it('refuses a member revoked since they signed in', async () => {
    await signIn('rowan@hearth.example')
    await q.saveMember({ id: rowan.id, name: 'Rowan', email: rowan.email, allowed: false, isAdmin: false })
    expect((await make({ label: 'Laptop' })).status).toBe(401)
  })
})

describe('making a key', () => {
  beforeEach(() => signIn('rowan@hearth.example'))

  it('hands the key over once, with the line that adds it to Claude Code', async () => {
    const res = await make({ label: '  Claude Code on the laptop ' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.key).toMatch(new RegExp(`^${rowan.id}\\.[\\w-]+\\.[\\w-]{43}$`))
    expect(body.connect).toBe(
      `claude mcp add --transport http hearth https://hearth.example/api/mcp --header "Authorization: Bearer ${body.key}"`,
    )
    expect(body.endpoint).toBe('https://hearth.example/api/mcp')
    expect(body.made).toMatchObject({ label: 'Claude Code on the laptop', lastUsed: null })
    expect(body.keys).toEqual([body.made])

    // Only its digest is kept, and no listing hands it out again.
    const [row] = await q.mcpKeysFor(rowan.id)
    expect(row.tokenHash).not.toContain(body.key)
    expect(JSON.stringify(await (await list()).json())).not.toContain(body.key)
  })

  it('makes a key that works against /api/mcp, as the member who made it', async () => {
    const { key } = await (await make({ label: 'Laptop' })).json()
    const listed = await rpc(key, 'tools/list')
    expect(listed.status).toBe(200)
    expect(listed.json.result.tools.map((t: { name: string }) => t.name)).toContain('hearth_context')
    const context = await rpc(key, 'tools/call', { name: 'hearth_context', arguments: {} })
    expect(JSON.stringify(context.json.result)).toContain('You are acting as Rowan.')
  })

  it('makes one per client, each listed with when it was last used', async () => {
    const laptop = await (await make({ label: 'Laptop' })).json()
    await make({ label: 'Phone' })
    await rpc(laptop.key, 'tools/list')
    const { keys } = await (await list()).json()
    expect(keys.map((k: { label: string }) => k.label)).toEqual(['Phone', 'Laptop'])
    expect(keys[0].lastUsed).toBeNull()
    expect(keys[1].lastUsed).toEqual(expect.any(String))
  })

  it('needs a name for the key, and a short one', async () => {
    for (const body of [{}, { label: '   ' }, { label: 42 }]) {
      const res = await make(body)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('Name the key')
    }
    const long = await make({ label: 'x'.repeat(q.MCP_KEY_LABEL_MAX + 1) })
    expect(long.status).toBe(400)
    expect((await long.json()).error).toContain(`under ${q.MCP_KEY_LABEL_MAX} characters`)
    expect((await make({ label: 'x'.repeat(q.MCP_KEY_LABEL_MAX) })).status).toBe(200)
  })

  it('rejects a malformed body', async () => {
    expect((await make(null, '{nope')).status).toBe(400)
    expect(await q.mcpKeysFor(rowan.id)).toEqual([])
  })
})

describe('revoking a key', () => {
  beforeEach(() => signIn('rowan@hearth.example'))

  it('stops it at /api/mcp at once, and leaves the member\'s other keys working', async () => {
    const laptop = await (await make({ label: 'Laptop' })).json()
    const phone = await (await make({ label: 'Phone' })).json()
    expect((await rpc(laptop.key, 'tools/list')).status).toBe(200)

    const res = await revoke(laptop.made.id)
    expect(res.status).toBe(200)
    expect((await res.json()).keys.map((k: { label: string }) => k.label)).toEqual(['Phone'])
    expect((await rpc(laptop.key, 'tools/list')).status).toBe(401)
    expect((await rpc(phone.key, 'tools/list')).status).toBe(200)
    // Revoked is revoked: there is nothing left to revoke a second time.
    expect((await revoke(laptop.made.id)).status).toBe(404)
  })

  it("never reaches another member's key", async () => {
    const ada = await q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
    const hers = await q.issueMcpKey(ada.id, 'Ada phone')
    const res = await revoke(hers.row.id)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe(`No key ${hers.row.id} of yours.`)
    expect((await rpc(hers.key, 'tools/list')).status).toBe(200)
  })

  it('needs to be told which key', async () => {
    for (const id of ['', 'abc', '0', '-2', '1.5']) expect((await revoke(id)).status, id).toBe(400)
  })
})
