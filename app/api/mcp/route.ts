import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { memberByMcpKey } from '@/lib/db/queries'
import { callTool, descriptors, INSTRUCTIONS, SERVER_INFO } from '@/lib/mcp'
import type { Member } from '@/lib/db/schema'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/**
 * Hearth over MCP: the household's tools for a client that is not Telegram.
 *
 * Streamable HTTP with no session state, so nothing has to be remembered
 * between calls and the endpoint costs nothing while idle. Each request
 * carries its own key, which is what says who is calling — rooms are never
 * trusted here either.
 */
const handler = createMcpHandler(
  (server) => {
    for (const { name, description, inputSchema } of descriptors()) {
      server.registerTool(
        name,
        { description, inputSchema },
        async (input, ctx) => {
          const member = (ctx.http?.authInfo?.extra as { member?: Member } | undefined)?.member
          // withMcpAuth turns an unauthenticated request away before this runs;
          // a call without a member would be a bug in the wiring, not a caller.
          if (!member) return { content: [{ type: 'text' as const, text: 'No key.' }], isError: true }
          return callTool(name, input, member)
        },
      )
    }
  },
  { serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
)

/**
 * A key is one member's, so the member it belongs to travels with the request
 * and every tool runs in their name: their mailbox, their calendar, their
 * word on the household board.
 */
async function verify(_req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined
  const member = await memberByMcpKey(bearer)
  if (!member) return undefined
  return {
    token: bearer,
    clientId: `member-${member.id}`,
    scopes: [],
    extra: { member },
  }
}

const authed = withMcpAuth(handler, verify, { required: true })

export { authed as GET, authed as POST, authed as DELETE }
