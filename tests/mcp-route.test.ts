import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Member } from '@/lib/db/schema'

const member = { id: 7, telegramUserId: '111', name: 'Rowan', allowed: true, isAdmin: false } as Member

const memberByMcpKey = vi.fn(async (key: string) => (key === 'good-key' ? member : null))
vi.mock('@/lib/db/queries', async (orig) => {
  const actual = await orig<typeof import('@/lib/db/queries')>()
  return { ...actual, memberByMcpKey }
})

const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] }))
vi.mock('@/lib/mcp', async (orig) => {
  const actual = await orig<typeof import('@/lib/mcp')>()
  return { ...actual, callTool }
})

const { POST } = await import('@/app/api/mcp/route')

beforeEach(() => vi.clearAllMocks())

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

describe('who the MCP endpoint lets in', () => {
  it('turns away a call with no key at all', async () => {
    const { status, headers } = await rpc('tools/list', {})
    expect(status).toBe(401)
    expect(headers.get('www-authenticate')).toContain('Bearer')
  })

  it('turns away a key it does not know', async () => {
    expect((await rpc('tools/list', {}, 'stolen-key')).status).toBe(401)
    expect(memberByMcpKey).toHaveBeenCalledWith('stolen-key')
  })

  it('lets a member in and offers them the household tools', async () => {
    const { status, json } = await rpc('tools/list', {}, 'good-key')
    expect(status).toBe(200)
    const names = json.result.tools.map((t: { name: string }) => t.name)
    expect(names).toContain('hearth_context')
    expect(names).toContain('add_family_event')
    expect(names).not.toContain('more_tools')
  })

  it('runs the call as the member the key belongs to', async () => {
    const { json } = await rpc('tools/call', { name: 'recall', arguments: { contains: 'bin' } }, 'good-key')
    expect(callTool).toHaveBeenCalledWith('recall', { contains: 'bin' }, member)
    expect(JSON.stringify(json.result)).toContain('done')
  })
})
