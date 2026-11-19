import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { FamilyEvent } from '@/lib/db/schema'

const calendarToken = vi.fn<() => Promise<string>>()
const allFamilyEventsForFeed = vi.fn<(since: Date) => Promise<FamilyEvent[]>>()

vi.mock('@/lib/db/queries', async (orig) => ({
  calendarToken,
  allFamilyEventsForFeed,
  FEED_EDGE_SECONDS: (await orig<typeof import('@/lib/db/queries')>()).FEED_EDGE_SECONDS,
}))

const { GET: calendarGet } = await import('@/app/api/calendar/[token]/route')

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/calendar/[token]', () => {
  const event: FamilyEvent = {
    id: 1,
    uid: 'e1@hearth',
    title: 'Bin night',
    description: null,
    location: null,
    startsAt: new Date('2026-09-07T09:00:00Z'),
    endsAt: new Date('2026-09-07T10:00:00Z'),
    allDay: false,
    createdBy: null,
    cancelled: false,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  }

  const request = (token: string) =>
    calendarGet(new Request(`https://hearth.test/api/calendar/${token}`), {
      params: Promise.resolve({ token }),
    })

  beforeEach(() => {
    calendarToken.mockResolvedValue('s3cret-feed-token')
    allFamilyEventsForFeed.mockResolvedValue([event])
  })

  it('serves the feed for the right token', async () => {
    const res = await request('s3cret-feed-token')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/calendar')
    const body = await res.text()
    expect(body).toContain('BEGIN:VCALENDAR')
    expect(body).toContain('SUMMARY:Bin night')
  })

  it('lets the edge answer repeat polls for an hour, as long as the feed asks clients to wait', async () => {
    const res = await request('s3cret-feed-token')
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=3600')
    expect(await res.text()).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H')
  })

  it('tolerates the .ics suffix calendar apps append', async () => {
    expect((await request('s3cret-feed-token.ics')).status).toBe(200)
  })

  it('404s on a wrong token without reading events', async () => {
    const res = await request('wrong-token-same-len')
    expect(res.status).toBe(404)
    expect(allFamilyEventsForFeed).not.toHaveBeenCalled()
  })

  it('404s on a token that is merely a prefix', async () => {
    expect((await request('s3cret')).status).toBe(404)
  })

  it('reads the token for an address it does not know at most once an hour, and always for one it does', async () => {
    // A module of its own, so it starts as a fresh instance holding no token.
    vi.resetModules()
    const { GET } = await import('@/app/api/calendar/[token]/route')
    const fetchFeed = (token: string) =>
      GET(new Request(`https://hearth.test/api/calendar/${token}`), { params: Promise.resolve({ token }) })
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      expect((await fetchFeed('s3cret-feed-token')).status).toBe(200)
      // Made-up addresses: the first gets a look, the rest that hour none.
      expect((await fetchFeed('junk-one')).status).toBe(404)
      expect((await fetchFeed('junk-two')).status).toBe(404)
      expect((await fetchFeed('junk-three')).status).toBe(404)
      expect(calendarToken).toHaveBeenCalledTimes(2)
      clock.mockReturnValue(start + 60 * 60_000)
      expect((await fetchFeed('junk-four')).status).toBe(404)
      expect(calendarToken).toHaveBeenCalledTimes(3)

      // Replaced on another instance: the old address stops at once...
      calendarToken.mockResolvedValue('replaced-token')
      expect((await fetchFeed('s3cret-feed-token')).status).toBe(404)
      expect((await fetchFeed('replaced-token')).status).toBe(200)
      // ...and a new one this instance has not seen is found on the next hour's look.
      calendarToken.mockResolvedValue('replaced-again')
      clock.mockReturnValue(start + 120 * 60_000)
      expect((await fetchFeed('replaced-again')).status).toBe(200)
    } finally {
      clock.mockRestore()
    }
  })

  it('only publishes events from the recent past onwards', async () => {
    await request('s3cret-feed-token')
    const since = allFamilyEventsForFeed.mock.calls[0][0]
    const daysAgo = (Date.now() - since.getTime()) / 86_400_000
    expect(daysAgo).toBeGreaterThan(29)
    expect(daysAgo).toBeLessThan(31)
  })
})
