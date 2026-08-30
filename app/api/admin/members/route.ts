import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/session'
import { allMembersWithLinks, saveMember, deleteMember, memberByTelegramId, allowedMembers } from '@/lib/db/queries'
import { idSet } from '@/lib/env'
import { hydrateSecrets } from '@/lib/settings'

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
 * Losing the last admin would leave the bot with nobody to run it from the
 * chat, so the only admin cannot be revoked, demoted or removed — only
 * succeeded. ADMIN_EMAILS still opens this dashboard, which is how you would
 * appoint the successor.
 */
async function isLastAdmin(telegramUserId: string): Promise<boolean> {
  const target = await memberByTelegramId(telegramUserId)
  if (!target?.allowed || !target.isAdmin) return false
  return (await allowedMembers()).filter((m) => m.isAdmin).length === 1
}

export async function GET() {
  if (!(await requireAdmin())) return deny()
  return NextResponse.json({ members: await allMembersWithLinks() })
}

export async function POST(req: Request) {
  const session = await requireAdmin()
  if (!session) return deny()

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  const telegramUserId = String(body.telegramUserId ?? '').replace(/[^0-9]/g, '')
  const name = String(body.name ?? '').trim()
  if (!telegramUserId) return NextResponse.json({ error: 'A numeric Telegram id is required.' }, { status: 400 })
  if (!name) return NextResponse.json({ error: 'A name is required.' }, { status: 400 })

  const email = String(body.email ?? '').trim().toLowerCase() || null
  if (email && !looksLikeEmail(email)) {
    return NextResponse.json({ error: `"${email}" does not look like an email address.` }, { status: 400 })
  }

  const demotes = body.allowed === false || body.isAdmin !== true
  if (demotes && (await isLastAdmin(telegramUserId))) {
    return NextResponse.json(
      { error: 'That is the only admin. Make someone else an admin first.' },
      { status: 400 },
    )
  }

  await saveMember({
    telegramUserId,
    name,
    email,
    allowed: body.allowed !== false,
    isAdmin: body.isAdmin === true,
  })
  return NextResponse.json({ ok: true, members: await allMembersWithLinks() })
}

export async function DELETE(req: Request) {
  const session = await requireAdmin()
  if (!session) return deny()

  // The founder guard below reads ALLOWED_TELEGRAM_IDS, which may live in the dashboard.
  await hydrateSecrets()
  const id = new URL(req.url).searchParams.get('telegramUserId') ?? ''
  if (!id) return NextResponse.json({ error: 'Which member?' }, { status: 400 })

  // A seeded founder would be recreated as an admin on their next message, so
  // deleting them here would be a lie rather than a revocation.
  if (idSet('ALLOWED_TELEGRAM_IDS').has(id)) {
    return NextResponse.json(
      { error: 'That is a founding member, set in ALLOWED_TELEGRAM_IDS. Remove them there instead.' },
      { status: 400 },
    )
  }

  if (await isLastAdmin(id)) {
    return NextResponse.json(
      { error: 'That is the only admin. Make someone else an admin first.' },
      { status: 400 },
    )
  }

  const gone = await deleteMember(id)
  return gone
    ? NextResponse.json({ ok: true, members: await allMembersWithLinks() })
    : NextResponse.json({ error: 'No such member.' }, { status: 404 })
}
