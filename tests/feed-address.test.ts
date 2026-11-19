import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import { jar } from './helpers/next-headers'

vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))

const { POST } = await import('@/app/api/admin/calendar/route')
const { createSession } = await import('@/lib/auth/session')
const q = await import('@/lib/db/queries')

let client: PGlite

beforeEach(async () => {
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.ADMIN_EMAILS = 'rowan@hearth.example'
  process.env.APP_URL = 'https://hearth.example'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
})
afterEach(async () => {
  await closeDb(client)
})

describe('replacing the family calendar address', () => {
  it('is for admins alone', async () => {
    const before = await q.calendarToken()
    expect((await POST()).status).toBe(401)
    await q.saveMember({ name: 'Sam', email: 'sam@hearth.example', allowed: true, isAdmin: false })
    await createSession({ email: 'sam@hearth.example', name: 'Sam', provider: 'google', role: 'member' })
    expect((await POST()).status).toBe(401)
    expect(await q.calendarToken()).toBe(before)
  })

  it('hands an admin the new address, and the old one stops matching', async () => {
    const before = await q.calendarToken()
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
    const res = await POST()
    expect(res.status).toBe(200)
    const body = await res.json()
    const after = await q.calendarToken()
    expect(after).not.toBe(before)
    expect(body.url).toBe(`https://hearth.example/api/calendar/${after}/family.ics`)
    expect(body.cachedForHours).toBe(q.FEED_EDGE_SECONDS / 3600)
  })
})
