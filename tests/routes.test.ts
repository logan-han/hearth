import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FamilyEvent } from '@/lib/db/schema'

const processInBackground = vi.fn()
const calendarToken = vi.fn<() => Promise<string>>()
const allFamilyEventsForFeed = vi.fn<(since: Date) => Promise<FamilyEvent[]>>()

vi.mock('@/lib/handler', () => ({ processInBackground }))
vi.mock('@/lib/summary', () => ({ maybeSummarise: vi.fn(async () => false) }))
vi.mock('@/lib/db/queries', () => ({ calendarToken, allFamilyEventsForFeed }))
// Here the environment is the whole configuration: a read of the store finds
// nothing new, and a test that needs a second look says what it finds.
const { hydrateSecrets, recheckSecrets } = vi.hoisted(() => ({
  hydrateSecrets: vi.fn(async () => {}),
  recheckSecrets: vi.fn(async () => true),
}))
vi.mock('@/lib/settings', () => ({ hydrateSecrets, recheckSecrets }))

const settings = await vi.importActual<typeof import('@/lib/settings')>('@/lib/settings')
const { __setDb } = await import('@/lib/db')

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

  it('checks the secret it holds before reading the store, and reads it fresh only once that passes', async () => {
    expect((await telegramPost(webhookRequest('correct-horse'))).status).toBe(200)
    expect(hydrateSecrets).toHaveBeenCalledTimes(1)
    expect(recheckSecrets).not.toHaveBeenCalled()
  })

  it('turns a stranger away without touching the database once it has looked this hour', async () => {
    recheckSecrets.mockResolvedValueOnce(false)
    expect((await telegramPost(webhookRequest('guess'))).status).toBe(401)
    recheckSecrets.mockResolvedValueOnce(false)
    delete process.env.TELEGRAM_WEBHOOK_SECRET
    expect((await telegramPost(webhookRequest('guess'))).status).toBe(503)
    expect(hydrateSecrets).not.toHaveBeenCalled()
    expect(processInBackground).not.toHaveBeenCalled()
  })

  it('takes the new secret once a second look finds it was changed on another instance', async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'before-the-change'
    recheckSecrets.mockImplementationOnce(async () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'correct-horse'
      return true
    })
    expect((await telegramPost(webhookRequest('correct-horse'))).status).toBe(200)
    expect(processInBackground).toHaveBeenCalledWith(UPDATE)
  })

  it('refuses the secret it held once the store says it has changed', async () => {
    hydrateSecrets.mockImplementationOnce(async () => {
      process.env.TELEGRAM_WEBHOOK_SECRET = 'rotated'
    })
    expect((await telegramPost(webhookRequest('correct-horse'))).status).toBe(401)
    expect(processInBackground).not.toHaveBeenCalled()
  })
})

// What /setup leaves behind: the webhook secret is a row in the store and was
// never in the deployment's environment, so a fresh instance holds nothing and
// its first deliveries have to be let in by a read of the store.
describe('POST /api/telegram on a fresh instance, the secret kept only in the store', () => {
  let stored = 'correct-horse'
  let down = false
  let reads = 0

  beforeEach(async () => {
    process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
    for (const key of settings.MANAGED_KEYS) delete process.env[key]
    stored = 'correct-horse'
    down = false
    reads = 0
    const { encrypt } = await import('@/lib/crypto')
    __setDb({
      select: () => {
        reads++
        return {
          from: async () => {
            // Neon waking up.
            await new Promise((resolve) => setTimeout(resolve, 20))
            if (down) throw new Error('no database')
            return [{ key: 'TELEGRAM_WEBHOOK_SECRET', value: await encrypt(stored), updatedAt: new Date(), updatedBy: 'setup' }]
          },
        }
      },
    })
    settings.resetHydration()
    hydrateSecrets.mockImplementation(settings.hydrateSecrets)
    recheckSecrets.mockImplementation(settings.recheckSecrets)
  })
  afterEach(() => {
    hydrateSecrets.mockImplementation(async () => {})
    recheckSecrets.mockImplementation(async () => true)
    __setDb(null)
  })

  it('lets in every page of an album that arrives while its first read is under way', async () => {
    const pages = await Promise.all([1, 2, 3].map((n) => telegramPost(webhookRequest('correct-horse', { ...UPDATE, update_id: n }))))
    expect(pages.map((res) => res.status)).toEqual([200, 200, 200])
    expect(processInBackground).toHaveBeenCalledTimes(3)
    expect(reads).toBe(1)
  })

  it('looks again once the database is back, when its first read failed', async () => {
    down = true
    expect((await telegramPost(webhookRequest('correct-horse'))).status).toBe(503)
    down = false
    expect((await telegramPost(webhookRequest('correct-horse'))).status).toBe(200)
    expect(processInBackground).toHaveBeenCalledTimes(1)
  })

  it('still takes a secret changed on another instance after its first delivery', async () => {
    expect((await telegramPost(webhookRequest('correct-horse'))).status).toBe(200)
    stored = 'battery-staple'
    expect((await telegramPost(webhookRequest('battery-staple'))).status).toBe(200)
    expect(processInBackground).toHaveBeenCalledTimes(2)
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
