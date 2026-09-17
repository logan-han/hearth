import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { FamilyEvent } from '@/lib/db/schema'

const processInBackground = vi.fn()
const calendarToken = vi.fn<() => Promise<string>>()
const allFamilyEventsForFeed = vi.fn<(since: Date) => Promise<FamilyEvent[]>>()

vi.mock('@/lib/handler', () => ({ processInBackground }))
vi.mock('@/lib/summary', () => ({ maybeSummarise: vi.fn(async () => false) }))
vi.mock('@/lib/db/queries', () => ({ calendarToken, allFamilyEventsForFeed }))
// The webhook route hydrates dashboard settings before checking the secret;
// here the environment is the whole configuration.
vi.mock('@/lib/settings', () => ({ hydrateSecrets: vi.fn(async () => {}) }))

const { POST: telegramPost, GET: telegramGet } = await import('@/app/api/telegram/route')
const { GET: calendarGet } = await import('@/app/api/calendar/[token]/route')

const UPDATE = { update_id: 1, message: { message_id: 2, text: 'hi', chat: { id: 5, type: 'private' } } }

function webhookRequest(secret?: string, body: unknown = UPDATE) {
  return new Request('https://hearth.test/api/telegram', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.TELEGRAM_WEBHOOK_SECRET = 'correct-horse'
})

describe('POST /api/telegram', () => {
  it('accepts an update carrying the right secret and acks immediately', async () => {
    const res = await telegramPost(webhookRequest('correct-horse'))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
    expect(processInBackground).toHaveBeenCalledWith(UPDATE)
  })

  it('rejects a wrong secret without processing anything', async () => {
    const res = await telegramPost(webhookRequest('wrong'))
    expect(res.status).toBe(401)
    expect(processInBackground).not.toHaveBeenCalled()
  })

  it('rejects a missing secret header', async () => {
    const res = await telegramPost(webhookRequest())
    expect(res.status).toBe(401)
    expect(processInBackground).not.toHaveBeenCalled()
  })

  it('refuses every update when the server has no secret configured', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET
    const res = await telegramPost(webhookRequest('anything'))
    expect(res.status).toBe(503)
    expect(processInBackground).not.toHaveBeenCalled()
  })

  it('rejects a malformed body after the secret check passes', async () => {
    const req = new Request('https://hearth.test/api/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'correct-horse' },
      body: 'not json',
    })
    expect((await telegramPost(req)).status).toBe(400)
    expect(processInBackground).not.toHaveBeenCalled()
  })

  it('answers a plain GET health check', async () => {
    expect((await telegramGet()).status).toBe(200)
  })
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

  it('only publishes events from the recent past onwards', async () => {
    await request('s3cret-feed-token')
    const since = allFamilyEventsForFeed.mock.calls[0][0]
    const daysAgo = (Date.now() - since.getTime()) / 86_400_000
    expect(daysAgo).toBeGreaterThan(29)
    expect(daysAgo).toBeLessThan(31)
  })
})
