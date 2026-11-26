import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { memberByMcpKey } from '@/lib/db/queries'
import { callTool, descriptors, INSTRUCTIONS, SERVER_INFO, type Caller } from '@/lib/mcp'
import { RESOURCE_METADATA_PATH } from '@/lib/oauth/server'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Hearth over MCP: the household's tools for a member's own client.
 *
 * Streamable HTTP with no session state, so nothing has to be remembered
 * between calls and the endpoint costs nothing while idle. Each request
 * carries its own key, which is what says who is calling.
 *
 * Idle stays free only while no client holds a stream open. The tool list is
 * fixed for the life of a deployment, so the server says it will not change:
 * a client told otherwise opens a listen stream to wait for changes, and here
 * an open stream is a function running until maxDuration cuts it, opened again
 * for as long as that client is connected. A listen sent regardless is refused
 * at once rather than held.
 */
const handler = createMcpHandler(
  (server) => {
    for (const { name, description, inputSchema } of descriptors()) {
      server.registerTool(
        name,
        { description, inputSchema },
        async (input, ctx) => {
          const caller = (ctx.http?.authInfo?.extra as { caller?: Caller } | undefined)?.caller
          // withMcpAuth turns an unauthenticated request away before this runs;
          // a call without a caller would be a bug in the wiring, not a caller.
          if (!caller) return { content: [{ type: 'text' as const, text: 'No key.' }], isError: true }
          return callTool(name, input, caller)
        },
      )
    }
  },
  {
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    capabilities: { tools: { listChanged: false } },
    maxSubscriptions: 0,
  },
)

/**
 * A key is one member's, so the member it belongs to travels with the request
 * and every tool runs in their name: their calendar, their word on the
 * household board. A key this deployment did not mint is turned
 * away on its tag, before anything is read (see memberByMcpKey), so made-up
 * keys sent every few minutes cannot keep the database awake. A key made on
 * the web and one the OAuth flow handed a client are the same kind of key.
 */
async function verify(_req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined
  const found = await memberByMcpKey(bearer)
  if (!found) return undefined
  const caller: Caller = { member: found.member, keyId: found.keyId }
  return {
    token: bearer,
    clientId: `member-${found.member.id}`,
    scopes: [],
    extra: { caller },
  }
}

/**
 * Turned away, a client is pointed at the protected-resource metadata, which
 * names this deployment as the authorisation server: a client that speaks
 * OAuth signs its member in from there, and one that does not is given a key
 * on the web instead.
 */
const authed = withMcpAuth(handler, verify, { required: true, resourceMetadataPath: RESOURCE_METADATA_PATH })

export { authed as GET, authed as POST, authed as DELETE }
