import { NextResponse } from 'next/server'
import { requireMember } from '@/lib/auth/session'
import { issueMcpKey, mcpKeysFor, revokeMcpKey, MCP_KEY_LABEL_MAX } from '@/lib/db/queries'
import { appUrl } from '@/lib/env'
import { formatLocal, formatLocalDate } from '@/lib/cron'
import { hydrateSecrets } from '@/lib/settings'
import type { McpKey } from '@/lib/db/schema'
import { connectLine } from '@/lib/mcp'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A key as its member sees it listed: never the key itself, which is not kept. */
const listed = (k: McpKey) => ({
  id: k.id,
  label: k.label,
  created: formatLocalDate(k.createdAt),
  lastUsed: k.lastUsedAt ? formatLocal(k.lastUsedAt) : null,
})

/**
 * A signed-in member's own MCP keys: list them, make one, revoke one. A key
 * acts as its member, so only that member can make or revoke theirs, and an
 * address in ADMIN_EMAILS with no member behind it has nobody for a key to be.
 */
async function caller(): Promise<{ ok: true; memberId: number } | { ok: false; res: NextResponse }> {
  const session = await requireMember()
  if (!session) return { ok: false, res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) }
  if (session.memberId === null) {
    return { ok: false, res: NextResponse.json({ error: 'A key acts as a family member, and this address is not one. Add yourself to the family in Settings first.' }, { status: 403 }) }
  }
  return { ok: true, memberId: session.memberId }
}

export async function GET() {
  const who = await caller()
  if (!who.ok) return who.res
  await hydrateSecrets()
  return NextResponse.json({ keys: (await mcpKeysFor(who.memberId)).map(listed) })
}

export async function POST(req: Request) {
  const who = await caller()
  if (!who.ok) return who.res
  // The household's zone, for the dates the list shows, may live in the dashboard's store.
  await hydrateSecrets()

  let body: { label?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!label) return NextResponse.json({ error: 'Name the key after the client it is for, like "Claude Code on the laptop".' }, { status: 400 })
  if (label.length > MCP_KEY_LABEL_MAX) return NextResponse.json({ error: `Keep the name under ${MCP_KEY_LABEL_MAX} characters.` }, { status: 400 })

  const { key, row } = await issueMcpKey(who.memberId, label)
  // The only time the key is ever sent anywhere: only its digest is kept.
  return NextResponse.json({
    key,
    connect: connectLine(key),
    endpoint: `${appUrl()}/api/mcp`,
    made: listed(row),
    keys: (await mcpKeysFor(who.memberId)).map(listed),
  })
}

export async function DELETE(req: Request) {
  const who = await caller()
  if (!who.ok) return who.res
  await hydrateSecrets()
  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'Which key?' }, { status: 400 })
  // Only one of the caller's own: anyone else's key is theirs to revoke.
  if (!(await revokeMcpKey(who.memberId, id))) return NextResponse.json({ error: `No key ${id} of yours.` }, { status: 404 })
  return NextResponse.json({ ok: true, keys: (await mcpKeysFor(who.memberId)).map(listed) })
}
