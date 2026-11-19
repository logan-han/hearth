import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/session'
import { allMembersWithLinks, saveMember, deleteMember, memberById, allowedMembers } from '@/lib/db/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const deny = () => NextResponse.json({ error: 'Not an administrator' }, { status: 401 })

/**
 * Something@something.tld, checked by splitting rather than by a pattern: a
 * regexp for this shape backtracks badly on input like "!@!.!.!.!." and this
 * value arrives from the browser.
 */
function looksLikeEmail(value: string): boolean {
  const at = value.indexOf('@')
  if (at < 1 || at !== value.lastIndexOf('@') || /\s/.test(value)) return false
  const labels = value.slice(at + 1).split('.')
  return labels.length > 1 && labels.every((label) => label.length > 0)
}

/**
 * Losing the last admin would leave the household with nobody to run it from
 * here, so the only admin cannot be revoked, demoted or removed, only
 * succeeded. ADMIN_EMAILS still opens this dashboard, which is how you would
 * appoint the successor.
 */
async function isLastAdmin(id: number): Promise<boolean> {
  const target = await memberById(id)
  if (!target?.allowed || !target.isAdmin) return false
  return (await allowedMembers()).filter((m) => m.isAdmin).length === 1
}

export async function GET() {
  if (!(await requireAdmin())) return deny()
  return NextResponse.json({ members: await allMembersWithLinks() })
}

/**
 * Add someone, or change one. A new member needs a name and the address they
 * will sign in with; adding an address already in the family changes that
 * person instead of making a second. A change names its member by id, and
 * keeps whatever the body leaves out, so fixing a name cannot quietly clear
 * an address, demote, or let back in someone who was revoked.
 */
export async function POST(req: Request) {
  const session = await requireAdmin()
  if (!session) return deny()

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  const id = body.id === undefined ? undefined : Number(body.id)
  if (id !== undefined && (!Number.isInteger(id) || id < 1)) return NextResponse.json({ error: 'Which member?' }, { status: 400 })
  const name = String(body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'A name is required.' }, { status: 400 })

  const typed = String(body.email ?? '').trim().toLowerCase() || null
  if (typed && !looksLikeEmail(typed)) {
    return NextResponse.json({ error: `"${typed}" does not look like an email address.` }, { status: 400 })
  }

  const byAddress = typed ? (await allMembersWithLinks()).find((m) => (m.email ?? '').toLowerCase() === typed) : undefined
  const existing = id !== undefined ? await memberById(id) : byAddress
  if (id !== undefined && !existing) return NextResponse.json({ error: 'No such member.' }, { status: 404 })
  if (id !== undefined && byAddress && byAddress.id !== id) {
    return NextResponse.json({ error: `${typed} is already ${byAddress.name}'s address.` }, { status: 400 })
  }
  if (!existing && !typed) {
    return NextResponse.json({ error: 'An email address is required: it is how they sign in.' }, { status: 400 })
  }

  const email = body.email === undefined ? (existing?.email ?? null) : typed
  const allowed = body.allowed === undefined ? (existing?.allowed ?? true) : body.allowed !== false
  const isAdmin = body.isAdmin === undefined ? (existing?.isAdmin ?? false) : body.isAdmin === true

  const demotes = !allowed || !isAdmin
  if (existing && demotes && (await isLastAdmin(existing.id))) {
    return NextResponse.json({ error: 'That is the only admin. Make someone else an admin first.' }, { status: 400 })
  }

  await saveMember({ ...(existing ? { id: existing.id } : {}), name, email, allowed, isAdmin })
  return NextResponse.json({ ok: true, members: await allMembersWithLinks() })
}

export async function DELETE(req: Request) {
  const session = await requireAdmin()
  if (!session) return deny()

  const id = Number(new URL(req.url).searchParams.get('id'))
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'Which member?' }, { status: 400 })

  if (await isLastAdmin(id)) {
    return NextResponse.json({ error: 'That is the only admin. Make someone else an admin first.' }, { status: 400 })
  }

  // Removed is revoked as well: their keys, links and drafts go with them, and
  // their scheduled jobs are paused before the row that says whose they are goes.
  const gone = await deleteMember(id)
  return gone
    ? NextResponse.json({ ok: true, members: await allMembersWithLinks() })
    : NextResponse.json({ error: 'No such member.' }, { status: 404 })
}
