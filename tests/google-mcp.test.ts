import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { callGoogleTool, GoogleMcpError, CALENDAR_MCP } from '@/lib/providers/google-mcp'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const stream = (...events: unknown[]) =>
  new Response(events.map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
const sent = () => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)), signal: init.signal }
}

describe("a call to Google's Calendar MCP server", () => {
  it('goes as a stateless tools/call that says who is asking and that a person could be asked', async () => {
    fetchMock.mockResolvedValueOnce(json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { events: [] } } }))
    await callGoogleTool(CALENDAR_MCP, 'tok', 'list_events', { calendarId: 'primary' })
    const { url, headers, body, signal } = sent()
    expect(url).toBe('https://calendarmcp.googleapis.com/mcp/v1')
    expect(headers).toMatchObject({
      authorization: 'Bearer tok',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'list_events',
    })
    expect(headers.accept).toContain('text/event-stream')
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_events', arguments: { calendarId: 'primary' } } })
    expect(body.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
    // Said, so Google asks rather than quietly leaving content out.
    expect(body.params._meta['io.modelcontextprotocol/clientCapabilities']).toEqual({ elicitation: { form: {} } })
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  it('hands back the structured answer, or the JSON in its text, or the text itself', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 1, result: { structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"a":2}' }] } }))
    expect(await callGoogleTool(CALENDAR_MCP, 't', 'x', {})).toEqual({ a: 1 })
    fetchMock.mockResolvedValueOnce(json({ id: 2, result: { content: [{ type: 'text', text: '{"a":2}' }] } }))
    expect(await callGoogleTool(CALENDAR_MCP, 't', 'x', {})).toEqual({ a: 2 })
    fetchMock.mockResolvedValueOnce(json({ id: 3, result: { content: [{ type: 'text', text: 'Deleted.' }] } }))
    expect(await callGoogleTool(CALENDAR_MCP, 't', 'x', {})).toBe('Deleted.')
  })

  it('finds its own answer in a stream, past the notes sent before it', async () => {
    fetchMock.mockImplementationOnce(async (_url, init: RequestInit) => {
      const { id } = JSON.parse(String(init.body))
      return stream(
        { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
        { jsonrpc: '2.0', id, result: { structuredContent: { events: [{ id: 'e1' }] } } },
      )
    })
    expect(await callGoogleTool(CALENDAR_MCP, 't', 'list_events', {})).toEqual({ events: [{ id: 'e1' }] })
  })

  it('says so when a stream ends without its answer', async () => {
    fetchMock.mockResolvedValueOnce(stream({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }))
    await expect(callGoogleTool(CALENDAR_MCP, 't', 'x', {})).rejects.toThrow(/gave no answer to x/)
  })

  it("refuses a call Google wants its owner's own yes for, since nobody is here to give one", async () => {
    const inputRequests = { approval_choice: { method: 'elicitation/create', params: { mode: 'form', message: 'Invite these guests?' } } }
    fetchMock.mockResolvedValueOnce(json({ id: 1, result: { resultType: 'input_required', inputRequests, requestState: 'g-state' } }))
    await expect(callGoogleTool(CALENDAR_MCP, 't', 'create_event', {})).rejects.toThrow(/own yes before create_event.*Google Calendar instead/)
  })

  it('refuses with what Google said, whether the tool failed, the protocol did, or HTTP did', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 1, result: { isError: true, content: [{ type: 'text', text: 'Calendar not found.' }] } }))
    await expect(callGoogleTool(CALENDAR_MCP, 't', 'list_events', {})).rejects.toThrow('Calendar not found.')

    fetchMock.mockResolvedValueOnce(json({ id: 2, result: { isError: true } }))
    await expect(callGoogleTool(CALENDAR_MCP, 't', 'get_event', {})).rejects.toThrow('Google could not do get_event.')

    fetchMock.mockResolvedValueOnce(json({ id: 3, error: { code: -32021, message: 'Missing capability' } }))
    const refused = await callGoogleTool(CALENDAR_MCP, 't', 'create_event', {}).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(GoogleMcpError)
    expect(refused).toMatchObject({ code: -32021, message: 'Google refused create_event: Missing capability' })

    // A tool the server does not offer is a 404 with the reason in a tool result.
    fetchMock.mockResolvedValueOnce(json({ id: 4, result: { isError: true, content: [{ type: 'text', text: 'Method not found.' }] } }, 404))
    const missing = await callGoogleTool(CALENDAR_MCP, 't', 'nothing_here', {}).catch((e: unknown) => e)
    expect(missing).toMatchObject({ status: 404 })
    expect(String(missing)).toContain('Method not found.')

    fetchMock.mockResolvedValueOnce(json({ id: 5, error: {} }))
    await expect(callGoogleTool(CALENDAR_MCP, 't', 'x', {})).rejects.toThrow('no reason given')

    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }))
    await expect(callGoogleTool(CALENDAR_MCP, 't', 'x', {})).rejects.toThrow('gave no answer')
  })
})
