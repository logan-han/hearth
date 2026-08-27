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

const { GET, POST, DELETE } = await import('@/app/api/admin/members/route')
const { createSession } = await import('@/lib/auth/session')

let client: PGlite

const post = (body: unknown) =>
  POST(new Request('https://hearth.han.life/api/admin/members', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
const del = (id: string) =>
  DELETE(new Request(`https://hearth.han.life/api/admin/members?telegramUserId=${id}`, { method: 'DELETE' }))

const asAdmin = () => createSession({ email: 'logan@han.life', name: 'Logan', provider: 'google', role: 'admin' })
const asMember = () => createSession({ email: 'ada@han.life', name: 'Ada', provider: 'google', role: 'member' })

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.ALLOWED_TELEGRAM_IDS = '8734670748'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('only an admin may manage the family', () => {
  it('refuses everything without a session', async () => {
    expect((await GET()).status).toBe(401)
    expect((await post({ telegramUserId: '1', name: 'X' })).status).toBe(401)
    expect((await del('1')).status).toBe(401)
  })

  it('refuses a member session, which can sign in but not administer', async () => {
    await asMember()
    expect((await GET()).status).toBe(401)
    expect((await post({ telegramUserId: '1', name: 'X' })).status).toBe(401)
    expect(await q.memberByTelegramId('1')).toBeUndefined()
  })
})

describe('adding and editing a member', () => {
  beforeEach(asAdmin)

  it('adds someone with an id, a name and an email', async () => {
    const res = await post({ telegramUserId: '999', name: 'Ada', email: 'Ada@Han.Life' })
    expect(res.status).toBe(200)
    const saved = await q.memberByTelegramId('999')
    expect(saved).toMatchObject({ name: 'Ada', allowed: true, isAdmin: false })
    // Normalised, so sign-in matching does not depend on how it was typed.
    expect(saved!.email).toBe('ada@han.life')
  })

  it('lets a member exist without an email', async () => {
    await post({ telegramUserId: '999', name: 'Kid' })
    expect((await q.memberByTelegramId('999'))!.email).toBeNull()
  })

  it('rejects a missing id or name', async () => {
    expect((await post({ name: 'Ada' })).status).toBe(400)
    expect((await post({ telegramUserId: '999' })).status).toBe(400)
  })

  it('rejects a non-numeric id rather than storing rubbish', async () => {
    expect((await post({ telegramUserId: 'abc', name: 'Ada' })).status).toBe(400)
  })

  it('rejects something that is not an email address', async () => {
    const res = await post({ telegramUserId: '999', name: 'Ada', email: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toContain('not-an-email')
  })

  it('rejects a malformed body', async () => {
    const res = await POST(new Request('https://hearth.han.life/api/admin/members', { method: 'POST', body: 'oops' }))
    expect(res.status).toBe(400)
  })

  it('updates rather than duplicating on a second save', async () => {
    await post({ telegramUserId: '999', name: 'Ada' })
    await post({ telegramUserId: '999', name: 'Ada Han', email: 'ada@han.life' })
    const all = await q.allMembersWithLinks()
    expect(all.filter((m) => m.telegramUserId === '999')).toHaveLength(1)
    expect(all.find((m) => m.telegramUserId === '999')!.name).toBe('Ada Han')
  })

  it('can promote and demote, while another admin remains', async () => {
    await post({ telegramUserId: '111', name: 'Boss', isAdmin: true })
    await post({ telegramUserId: '999', name: 'Ada', isAdmin: true })
    expect((await q.memberByTelegramId('999'))!.isAdmin).toBe(true)
    await post({ telegramUserId: '999', name: 'Ada', isAdmin: false })
    expect((await q.memberByTelegramId('999'))!.isAdmin).toBe(false)
  })

  it('revoking access takes admin with it, so they cannot sign in', async () => {
    await post({ telegramUserId: '111', name: 'Boss', isAdmin: true })
    await post({ telegramUserId: '999', name: 'Ada', isAdmin: true })
    await post({ telegramUserId: '999', name: 'Ada', isAdmin: true, allowed: false })
    const saved = await q.memberByTelegramId('999')
    expect(saved).toMatchObject({ allowed: false, isAdmin: false })
  })

  it('updates an email on an existing member, and clears it on empty', async () => {
    await post({ telegramUserId: '999', name: 'Ada', email: 'old@han.life' })
    await post({ telegramUserId: '999', name: 'Ada', email: 'new@han.life' })
    expect((await q.memberByTelegramId('999'))!.email).toBe('new@han.life')
    await post({ telegramUserId: '999', name: 'Ada', email: '' })
    expect((await q.memberByTelegramId('999'))!.email).toBeNull()
  })

  it('returns the refreshed list with linked mailboxes shown', async () => {
    const m = await q.upsertMember('777', 'Linked', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'l@han.life', refreshToken: 'r', scopes: null })
    const body = await (await post({ telegramUserId: '999', name: 'Ada' })).json()
    const linked = body.members.find((x: { telegramUserId: string }) => x.telegramUserId === '777')
    expect(linked.linked).toEqual([{ provider: 'google', email: 'l@han.life' }])
  })
})

describe('removing a member', () => {
  beforeEach(asAdmin)

  it('removes an ordinary member', async () => {
    await post({ telegramUserId: '999', name: 'Ada' })
    expect((await del('999')).status).toBe(200)
    expect(await q.memberByTelegramId('999')).toBeUndefined()
  })

  it('refuses to pretend it removed a founding member', async () => {
    await post({ telegramUserId: '8734670748', name: 'Logan' })
    const res = await del('8734670748')
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toContain('ALLOWED_TELEGRAM_IDS')
    expect(await q.memberByTelegramId('8734670748')).toBeDefined()
  })

  it('404s on someone it has never seen', async () => {
    expect((await del('123')).status).toBe(404)
  })

  it('needs to be told who', async () => {
    expect((await DELETE(new Request('https://hearth.han.life/api/admin/members', { method: 'DELETE' }))).status).toBe(400)
  })
})

describe('the last admin cannot lock the house out', () => {
  beforeEach(async () => {
    await asAdmin()
    await post({ telegramUserId: '999', name: 'Ada', isAdmin: true })
  })

  it('refuses to demote the only admin', async () => {
    const res = await post({ telegramUserId: '999', name: 'Ada', isAdmin: false })
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toContain('only admin')
    expect(await q.memberByTelegramId('999')).toMatchObject({ allowed: true, isAdmin: true })
  })

  it('refuses to revoke the only admin', async () => {
    const res = await post({ telegramUserId: '999', name: 'Ada', isAdmin: true, allowed: false })
    expect(res.status).toBe(400)
    expect((await q.memberByTelegramId('999'))!.allowed).toBe(true)
  })

  it('refuses to remove the only admin', async () => {
    const res = await del('999')
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toContain('only admin')
    expect(await q.memberByTelegramId('999')).toBeDefined()
  })

  it('still edits the only admin in place — a new email is not a demotion', async () => {
    const res = await post({ telegramUserId: '999', name: 'Ada', email: 'ada@han.life', isAdmin: true })
    expect(res.status).toBe(200)
    expect((await q.memberByTelegramId('999'))!.email).toBe('ada@han.life')
  })

  it('lets them go once a successor is appointed', async () => {
    await post({ telegramUserId: '111', name: 'Boss', isAdmin: true })
    expect((await post({ telegramUserId: '999', name: 'Ada', isAdmin: false })).status).toBe(200)
    expect((await del('999')).status).toBe(200)
  })
})
