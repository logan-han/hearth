import { calendarToken, allFamilyEventsForFeed, FEED_EDGE_SECONDS } from '@/lib/db/queries'
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

/** The feed's token as this instance last read it; null until it has. */
let known: string | null = null
/** When a request matching nothing last had the token read again for it. */
let missReadAt = -Infinity
const MISS_READ_MS = 60 * 60_000
let reading: Promise<string> | null = null

function readToken(): Promise<string> {
  reading ??= calendarToken()
    .then((token) => (known = token))
    .finally(() => {
      reading = null
    })
  return reading
}

/**
 * Whether the address carries the feed's token, going to the database only
 * when that can change the answer. One that matches the token this instance
 * holds is read again, so an address replaced by `/calendar new` on another
 * instance stops working at once. One that matches nothing is turned away on
 * what this instance holds, with a fresh read at most once an hour, in case
 * the token was replaced elsewhere. A read for every miss let anyone who knew
 * the host keep Neon awake by fetching made-up addresses every few minutes,
 * which runs out the month's compute hours and suspends the whole deployment.
 * As with the webhook's secret (see recheckSecrets), a request arriving while
 * a read is under way shares it, and neither a fresh instance's first read nor
 * one that failed uses up the hour.
 */
async function isFeedToken(supplied: string): Promise<boolean> {
  const miss = !reading && known !== null && !safeEqual(supplied, known)
  if (miss && Date.now() - missReadAt < MISS_READ_MS) return false
  const token = await readToken()
  if (miss) missReadAt = Date.now()
  return safeEqual(supplied, token)
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  // Calendar clients append the filename, e.g. /api/calendar/<token>/family.ics
  const supplied = token.replace(/\.ics$/i, '')

  if (!(await isFeedToken(supplied))) {
    return new Response('Not found', { status: 404 })
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  const events = await allFamilyEventsForFeed(since)
  const ics = buildCalendar(events, 'Family')

  return new Response(ics, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="family.ics"',
      // Calendar apps poll on their own clocks, some every few minutes. The
      // edge answers repeat polls for an hour so a keen client cannot keep
      // the Neon compute awake: every miss here wakes it for five minutes,
      // and each edge region misses on its own. No stale-while-revalidate:
      // Google polls a few times a day, and would always be handed the copy
      // from its last visit.
      'cache-control': `public, max-age=300, s-maxage=${FEED_EDGE_SECONDS}`,
    },
  })
}
