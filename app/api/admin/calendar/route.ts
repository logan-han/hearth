import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/session'
import { rotateCalendarToken, FEED_EDGE_SECONDS } from '@/lib/db/queries'
import { appUrl } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Replace the family calendar's address, for when it has got out. The old
 * address stops answering at once, though the edge may hand out a copy it
 * cached for up to FEED_EDGE_SECONDS; everyone subscribed then subscribes
 * again with the new one.
 */
export async function POST() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Not an administrator' }, { status: 401 })
  const token = await rotateCalendarToken()
  return NextResponse.json({
    ok: true,
    url: `${appUrl()}/api/calendar/${token}/family.ics`,
    cachedForHours: FEED_EDGE_SECONDS / 3600,
  })
}
