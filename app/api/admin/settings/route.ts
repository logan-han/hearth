import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/session'
import { isManaged, setSecret, clearSecret, listSettings } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Not an administrator' }, { status: 401 })
  return NextResponse.json({ settings: await listSettings() })
}

export async function POST(req: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: 'Not an administrator' }, { status: 401 })

  let body: { key?: string; value?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  const { key, value } = body
  // The allowlist is the security boundary: without it a session could set
  // DATABASE_URL and point the deployment at someone else's database.
  if (!key || !isManaged(key)) {
    return NextResponse.json({ error: `"${key}" is not an editable setting.` }, { status: 400 })
  }

  try {
    if (value === undefined || value === '') await clearSecret(key)
    else await setSecret(key, value, session.email)
    return NextResponse.json({ ok: true, key, settings: await listSettings() })
  } catch (err) {
    console.error('[admin] could not save setting:', err)
    return NextResponse.json({ error: 'Could not save that setting.' }, { status: 500 })
  }
}
