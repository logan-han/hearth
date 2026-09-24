import { NextResponse } from 'next/server'
import { requireMember } from '@/lib/auth/session'
import { hydrateSecrets } from '@/lib/settings'
import { gatherCalendar } from '@/lib/stats'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One month of the family calendar. Deliberately separate from the ICS feed at
 * /api/calendar/[token]: that one is public-by-token for calendar apps, this
 * one is for a signed-in person flicking between months.
 */
export async function GET(req: Request) {
  if (!(await requireMember())) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // Events land on the household's days, and the household's zone may live in the dashboard.
  await hydrateSecrets()

  const month = new URL(req.url).searchParams.get('month') ?? undefined
  const { calendar } = await gatherCalendar(month)
  return NextResponse.json({ calendar })
}
