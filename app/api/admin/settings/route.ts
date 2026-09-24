import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/session'
import { isManaged, setSecret, clearSecret, listSettings, SETTING_META } from '@/lib/settings'
import { canonicalTimeZone } from '@/lib/env'

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

  const { key } = body
  // The allowlist is the security boundary: without it a session could set
  // DATABASE_URL and point the deployment at someone else's database.
  if (!key || !isManaged(key)) {
    return NextResponse.json({ error: `"${key}" is not an editable setting.` }, { status: 400 })
  }
  // A pasted key brings its trailing newline with it.
  let value = typeof body.value === 'string' ? body.value.trim() : body.value
  const refused = value ? invalid(key, value) : null
  if (refused) return NextResponse.json({ error: refused }, { status: 400 })
  // Stored under the zone's own name, which every provider it is handed to expects.
  if (key === 'TIMEZONE' && value) value = canonicalTimeZone(value) ?? value

  try {
    if (value === undefined || value === '') await clearSecret(key, session.email)
    else await setSecret(key, value, session.email)
    return NextResponse.json({ ok: true, key, settings: await listSettings() })
  } catch (err) {
    console.error('[admin] could not save setting:', err)
    return NextResponse.json({ error: 'Could not save that setting.' }, { status: 500 })
  }
}

/** Why this value cannot be stored, or null. Checked here, since a value that gets in is read by every page. */
function invalid(key: string, value: string): string | null {
  if (key === 'TIMEZONE' && !canonicalTimeZone(value)) {
    return `"${value}" is not a time zone. Use a name like Australia/Melbourne or Europe/London.`
  }
  const options = (SETTING_META as Record<string, { options?: readonly string[] }>)[key]?.options
  if (options && !options.includes(value)) return `${key} is one of: ${options.join(', ')}.`
  return null
}
