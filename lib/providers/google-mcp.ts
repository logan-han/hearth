import { deadline } from '../deadline'

/**
 * Google's own MCP server for one member's calendar. Google takes an AI
 * agent's Calendar calls only through it, never the REST API it sits on, and
 * Hearth's every call is an agent's: a member's MCP client or a scheduled
 * job's model asked for it.
 */
export const CALENDAR_MCP = 'https://calendarmcp.googleapis.com/mcp/v1'

/**
 * The protocol revision the server speaks. It has no session: every request
 * says who is asking and what its client can do, so any one can go on its own.
 */
const PROTOCOL = '2026-07-28'
const CLIENT_INFO = { name: 'hearth', version: '2.0.0' }

/** A call Google turned down: over HTTP, as a protocol error, or as a tool that failed. */
export class GoogleMcpError extends Error {
  constructor(message: string, public status: number, public code?: number) {
    super(message)
    this.name = 'GoogleMcpError'
  }
}

type RpcMessage = {
  id?: number | string
  result?: {
    resultType?: string
    isError?: boolean
    structuredContent?: unknown
    content?: { type: string; text?: string }[]
  }
  error?: { code?: number; message?: string; data?: unknown }
}

let nextId = 1

/**
 * Call one tool and hand back its answer. The client says it can put a
 * question to a person, so a call Google will only make with its owner's yes
 * comes back as a question rather than as content quietly left out; nobody is
 * here to answer it, so that is refused in words the member can act on.
 */
export async function callGoogleTool(server: string, token: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const id = nextId++
  const res = await fetch(server, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
      // The revision has the method and the tool named in headers as well as
      // the body, so they can be routed and checked without reading it.
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL,
          'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
          'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
        },
      },
    }),
    signal: deadline(),
  })
  const text = await res.text()
  if (!res.ok) throw new GoogleMcpError(`Google ${res.status} on ${name}: ${text.slice(0, 300)}`, res.status)

  const message = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? fromEventStream(text, id)
    : (parseJson(text) as RpcMessage | undefined)
  if (!message) throw new GoogleMcpError(`Google gave no answer to ${name}.`, res.status)
  if (message.error) {
    throw new GoogleMcpError(`Google refused ${name}: ${message.error.message ?? 'no reason given'}`, res.status, message.error.code)
  }

  const result = message.result ?? {}
  if (result.resultType === 'input_required') {
    throw new GoogleMcpError(
      `Google wants the account owner's own yes before ${name}, which cannot be asked for here. Do it in Google Calendar instead.`,
      res.status,
    )
  }
  const said = result.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') ?? ''
  if (result.isError) throw new GoogleMcpError(said || `Google could not do ${name}.`, res.status)
  return result.structuredContent ?? parseJson(said) ?? said
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * The answer to request `id` out of a stream: a server may send notes of its
 * own (progress, say) before it, each an event of `data:` lines.
 */
function fromEventStream(stream: string, id: number): RpcMessage | undefined {
  for (const event of stream.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    const message = data ? (parseJson(data) as RpcMessage | undefined) : undefined
    if (message?.id === id && (message.result || message.error)) return message
  }
  return undefined
}
