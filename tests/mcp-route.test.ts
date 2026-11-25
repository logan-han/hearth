import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Member } from '@/lib/db/schema'
import { randomToken } from '@/lib/crypto'

const member = { id: 7, name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false, createdAt: new Date(0) } as Member

// Any other key goes through the real lookup, against a database that is not there.
const memberByMcpKey = vi.fn<(key: string) => Promise<{ member: Member; keyId: number } | null>>()
vi.mock('@/lib/db/queries', async (orig) => {
  const actual = await orig<typeof import('@/lib/db/queries')>()
  memberByMcpKey.mockImplementation(async (key) => (key === 'good-key' ? { member, keyId: 3 } : actual.memberByMcpKey(key)))
  return { ...actual, memberByMcpKey }
})
const db = vi.fn(() => {
  throw new Error('no database here')
})
vi.mock('@/lib/db', async (orig) => ({ ...(await orig<typeof import('@/lib/db')>()), db }))

const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] }))
vi.mock('@/lib/mcp', async (orig) => {
  const actual = await orig<typeof import('@/lib/mcp')>()
  return { ...actual, callTool }
})

const { POST } = await import('@/app/api/mcp/route')

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
})

/** One JSON-RPC call over the streamable HTTP transport, however it answers. */
async function rpc(method: string, params: unknown, key?: string) {
  const res = await POST(
    new Request('https://hearth.example/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const body = await res.text()
  // An SSE answer carries the same JSON-RPC payload, one `data:` line at a time.
  const json = body.includes('data:')
    ? JSON.parse(body.split('\n').find((l) => l.startsWith('data:'))!.slice(5))
    : body && JSON.parse(body)
  return { status: res.status, headers: res.headers, json }
}

/** A call the way a 2026-07-28 client sends it: the method in a header as well, and who is asking in `_meta`. */
function modern(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
  return POST(
    new Request('https://hearth.example/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer good-key',
        'mcp-method': method,
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'call-1',
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'a-client', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
      signal,
    }),
  )
}

describe('what a connected client holds open', () => {
  it('tells a client of either era that the tool list will not change, so it has nothing to wait for', async () => {
    const initialised = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a-client', version: '1.0.0' } }, 'good-key')
    expect(initialised.json.result.capabilities.tools).toEqual({ listChanged: false })

    const discovered = await (await modern('server/discover')).json()
    expect(discovered.result.capabilities.tools).toEqual({ listChanged: false })
  })

  it('refuses a listen at once instead of leaving a stream open for the host to run until it times out', async () => {
    // A stream handed back here would never end, so the client hangs up whatever the answer was.
    const client = new AbortController()
    try {
      const res = await modern('subscriptions/listen', { notifications: { toolsListChanged: true } }, client.signal)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect((await res.json()).error).toMatchObject({ code: -32603 })
    } finally {
      client.abort()
    }
  })
})

describe('who the MCP endpoint lets in', () => {
  it('turns away a call with no key, pointing it at the metadata that says how to sign in', async () => {
    const { status, headers } = await rpc('tools/list', {})
    expect(status).toBe(401)
    const challenge = headers.get('www-authenticate') ?? ''
    expect(challenge).toContain('Bearer')
    expect(challenge).toContain('resource_metadata="https://hearth.example/.well-known/oauth-protected-resource/api/mcp"')
  })

  it('turns away a key it does not know', async () => {
    expect((await rpc('tools/list', {}, 'stolen-key')).status).toBe(401)
    expect(memberByMcpKey).toHaveBeenCalledWith('stolen-key')
  })

  it('turns away a key it did not mint before anything is read, so junk cannot keep the database awake', async () => {
    for (const key of ['stolen-key', randomToken(32), `7.${randomToken(32)}.${'A'.repeat(43)}`]) {
      expect((await rpc('tools/list', {}, key)).status).toBe(401)
    }
    expect(db).not.toHaveBeenCalled()
  })

  it('lets a member in and offers them the household tools', async () => {
    const { status, json } = await rpc('tools/list', {}, 'good-key')
    expect(status).toBe(200)
    const names = json.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('hearth_context')
    expect(names).toContain('add_family_event')
    expect(names).toContain('morning_brief')
    expect(names).not.toContain('more_tools')
  })

  it('runs the call as the member the key belongs to, with which key it was', async () => {
    const { json } = await rpc('tools/call', { name: 'recall', arguments: { contains: 'bin' } }, 'good-key')
    expect(callTool).toHaveBeenCalledWith('recall', { contains: 'bin' }, { member, keyId: 3 })
    expect(JSON.stringify(json.result)).toContain('done')
  })
})
