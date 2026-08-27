import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

const jar = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    cookies: async () => ({
      get: (k: string) => (store.has(k) ? { value: store.get(k) } : undefined),
      set: (k: string, v: string) => void store.set(k, v),
      delete: (k: string) => void store.delete(k),
    }),
  }
})
vi.mock('next/headers', () => ({ cookies: jar.cookies }))

const { GET } = await import('@/app/api/month/route')
const { createSession } = await import('@/lib/auth/session')

let client: PGlite
const get = (month?: string) =>
  GET(new Request(`https://h/api/month${month ? `?month=${month}` : ''}`))

beforeEach(async () => {
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.TIMEZONE = 'Australia/Melbourne'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('the month API', () => {
  it('needs a session, since the family calendar is not public here', async () => {
    expect((await get('2026-09')).status).toBe(401)
  })

  it('serves a month to any recognised member, not just admins', async () => {
    await createSession({ email: 'ada@han.life', name: 'Ada', provider: 'google', role: 'member' })
    const res = await get('2026-09')
    expect(res.status).toBe(200)
    const { calendar } = await res.json()
    expect(calendar.label).toBe('September 2026')
    expect(calendar.days.length % 7).toBe(0)
  })

  it('returns the current month when none is asked for', async () => {
    await createSession({ email: 'a@b.com', name: 'A', provider: 'google', role: 'admin' })
    const now = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit',
    }).format(new Date()).slice(0, 7)
    expect((await (await get()).json()).calendar.key).toBe(now)
  })

  it('carries the events, placed on their Melbourne day', async () => {
    await createSession({ email: 'a@b.com', name: 'A', provider: 'google', role: 'admin' })
    await q.addFamilyEvent({
      title: 'Assembly',
      startsAt: new Date('2026-09-08T22:30:00Z'),
      endsAt: new Date('2026-09-08T23:30:00Z'),
    })
    const { calendar } = await (await get('2026-09')).json()
    const ninth = calendar.days.find((d: { date: string }) => d.date === '2026-09-09')
    expect(ninth.events).toHaveLength(1)
    expect(ninth.events[0].title).toBe('Assembly')
  })

  it('hands back neighbours so the client can prefetch them', async () => {
    await createSession({ email: 'a@b.com', name: 'A', provider: 'google', role: 'admin' })
    const { calendar } = await (await get('2026-09')).json()
    expect(calendar.prev).toBe('2026-08')
    expect(calendar.next).toBe('2026-10')
  })
})
