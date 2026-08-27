import { calendarToken, allFamilyEventsForFeed } from '@/lib/db/queries'
import { buildCalendar } from '@/lib/ics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LOOKBACK_DAYS = 30

/** Constant-time-ish comparison so the token cannot be probed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  // Calendar clients append the filename, e.g. /api/calendar/<token>/family.ics
  const supplied = token.replace(/\.ics$/i, '')

  const expected = await calendarToken()
  if (!safeEqual(supplied, expected)) {
    return new Response('Not found', { status: 404 })
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  const events = await allFamilyEventsForFeed(since)
  const ics = buildCalendar(events, 'Family')

  return new Response(ics, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="family.ics"',
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  })
}
