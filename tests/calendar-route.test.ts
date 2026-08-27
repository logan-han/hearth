import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { FamilyEvent } from '@/lib/db/schema'

const { calendarToken, allFamilyEventsForFeed } = vi.hoisted(() => ({
  calendarToken: vi.fn(async () => 'the-token'),
  allFamilyEventsForFeed: vi.fn(async () => [] as FamilyEvent[]),
}))
vi.mock('@/lib/db/queries', () => ({ calendarToken, allFamilyEventsForFeed }))

const { GET } = await import('@/app/api/calendar/[token]/[file]/route')

beforeEach(() => vi.clearAllMocks())

describe('the /family.ics path calendar apps request', () => {
  const get = (token: string, file = 'family.ics') =>
    GET(new Request(`https://hearth.han.life/api/calendar/${token}/${file}`), {
      params: Promise.resolve({ token, file }),
    })

  it('serves the same feed as the bare token path', async () => {
    const res = await get('the-token')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/calendar')
    expect(await res.text()).toContain('BEGIN:VCALENDAR')
  })

  it('404s on a wrong token regardless of the filename', async () => {
    expect((await get('wrong-token')).status).toBe(404)
    expect(allFamilyEventsForFeed).not.toHaveBeenCalled()
  })

  it('ignores whatever filename was asked for', async () => {
    expect((await get('the-token', 'anything.ics')).status).toBe(200)
  })
})
