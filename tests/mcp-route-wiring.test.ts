import { describe, it, expect, vi } from 'vitest'

// The auth wrapper stood aside, so the handler can be reached the way only a
// bug in the wiring could reach it: with no key behind the call.
vi.mock('mcp-handler', async (orig) => ({
  ...(await orig<typeof import('mcp-handler')>()),
  withMcpAuth: (handler: (req: Request) => Promise<Response>) => handler,
}))
const callTool = vi.fn()
vi.mock('@/lib/mcp', async (orig) => ({ ...(await orig<typeof import('@/lib/mcp')>()), callTool }))

const { POST } = await import('@/app/api/mcp/route')

describe('a tool call that reaches the handler with no key behind it', () => {
  it('runs nothing, and says there is no key', async () => {
    const res = await POST(new Request('https://hearth.example/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall', arguments: {} } }),
    }))
    const body = await res.text()
    const json = JSON.parse(body.includes('data:') ? body.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : body)
    expect(json.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'No key.' }] })
    expect(callTool).not.toHaveBeenCalled()
  })
})
