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
  POST(new Request('https://hearth.example/api/admin/members', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
const del = (id: string) =>
  DELETE(new Request(`https://hearth.example/api/admin/members?telegramUserId=${id}`, { method: 'DELETE' }))

const asAdmin = () => createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
const asMember = () => createSession({ email: 'ada@hearth.example', name: 'Ada', provider: 'google', role: 'member' })

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.ALLOWED_TELEGRAM_IDS = '8734670748'
  process.env.ADMIN_EMAILS = 'rowan@hearth.example'
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

  it('lists members for a signed-in admin', async () => {
    await post({ telegramUserId: '999', name: 'Ada' })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.members.some((m: { telegramUserId: string }) => m.telegramUserId === '999')).toBe(true)
  })

  it('adds someone with an id, a name and an email', async () => {
    const res = await post({ telegramUserId: '999', name: 'Ada', email: 'Ada@Hearth.Example' })
    expect(res.status).toBe(200)
    const saved = await q.memberByTelegramId('999')
    expect(saved).toMatchObject({ name: 'Ada', allowed: true, isAdmin: false })
    // Normalised, so sign-in matching does not depend on how it was typed.
    expect(saved!.email).toBe('ada@hearth.example')
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

  it('rejects the near misses too', async () => {
    for (const email of ['@hearth.example', 'ada@', 'ada@han', 'ada@@hearth.example', 'ada@hearth.example.', 'ada@.life']) {
      expect((await post({ telegramUserId: '999', name: 'Ada', email })).status).toBe(400)
    }
  })

  it('rejects a malformed body', async () => {
    const res = await POST(new Request('https://hearth.example/api/admin/members', { method: 'POST', body: 'oops' }))
    expect(res.status).toBe(400)
  })

  it('updates rather than duplicating on a second save', async () => {
    await post({ telegramUserId: '999', name: 'Ada' })
    await post({ telegramUserId: '999', name: 'Ada Han', email: 'ada@hearth.example' })
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

  it('quiets the rooms a revoked member has talked in, and unmutes every one when they are allowed again', async () => {
    // No bot token here, so Telegram cannot say who is where, and having talked in a room stands in for it.
    delete process.env.TELEGRAM_BOT_TOKEN
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await post({ telegramUserId: '999', name: 'Ada' })
    const ada = await q.memberByTelegramId('999')
    await q.rememberChat('-100', 'group', 'Family')
    await q.rememberChat('-200', 'group', 'Cousins')
    await q.recordMessage({ chatId: '-100', memberId: ada!.id, role: 'user', content: 'hi' })

    await post({ telegramUserId: '999', name: 'Ada', allowed: false })
    expect(await q.strangersIn('-100')).toEqual([{ id: '999', name: 'Ada' }])
    expect(await q.strangersIn('-200')).toEqual([])

    await q.noteStranger('-200', { id: '999', name: 'Ada' })
    // What the row's Allow button sends; a bare re-add keeps them revoked.
    await post({ telegramUserId: '999', name: 'Ada', allowed: true })
    expect(await q.strangersIn('-100')).toEqual([])
    expect(await q.strangersIn('-200')).toEqual([])
  })

  it('refuses to revoke a founding member, whose next message would let them back into one room only', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await post({ telegramUserId: '111', name: 'Boss', isAdmin: true })
    await post({ telegramUserId: '8734670748', name: 'Rowan', isAdmin: true })
    const rowan = await q.memberByTelegramId('8734670748')
    await q.rememberChat('-100', 'group', 'Family')
    await q.recordMessage({ chatId: '-100', memberId: rowan!.id, role: 'user', content: 'hi' })

    const res = await post({ telegramUserId: '8734670748', name: 'Rowan', isAdmin: true, allowed: false })
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toContain('ALLOWED_TELEGRAM_IDS')
    expect(await q.memberByTelegramId('8734670748')).toMatchObject({ allowed: true, isAdmin: true })
    expect(await q.strangersIn('-100')).toEqual([])
  })

  it('updates an email on an existing member, and clears it on empty', async () => {
    await post({ telegramUserId: '999', name: 'Ada', email: 'old@hearth.example' })
    await post({ telegramUserId: '999', name: 'Ada', email: 'new@hearth.example' })
    expect((await q.memberByTelegramId('999'))!.email).toBe('new@hearth.example')
    await post({ telegramUserId: '999', name: 'Ada', email: '' })
    expect((await q.memberByTelegramId('999'))!.email).toBeNull()
  })

  it('adding an id already here renames them and keeps the email and admin the add left out', async () => {
    await post({ telegramUserId: '111', name: 'Boss', isAdmin: true })
    await post({ telegramUserId: '999', name: 'Mun', email: 'mum@hearth.example', isAdmin: true })
    // What the Add row sends when only the id and the corrected name are filled in.
    expect((await post({ telegramUserId: '999', name: 'Mum' })).status).toBe(200)
    expect(await q.memberByTelegramId('999')).toMatchObject({
      name: 'Mum', email: 'mum@hearth.example', allowed: true, isAdmin: true,
    })
    // What was filled in still lands.
    await post({ telegramUserId: '999', name: 'Mum', email: 'mum@else.example' })
    expect((await q.memberByTelegramId('999'))!.email).toBe('mum@else.example')
  })

  it('adding an id already here does not let back in someone who was revoked', async () => {
    await post({ telegramUserId: '999', name: 'Tom', email: 'tom@hearth.example' })
    await post({ telegramUserId: '999', name: 'Tom', email: 'tom@hearth.example', allowed: false })
    // The Add row fixing a spelling, with the email blank and admin unticked.
    expect((await post({ telegramUserId: '999', name: 'Thomas' })).status).toBe(200)
    expect(await q.memberByTelegramId('999')).toMatchObject({
      name: 'Thomas', email: 'tom@hearth.example', allowed: false, isAdmin: false,
    })
    // Saying so outright, as Allow and /setup do, still lets them in.
    await post({ telegramUserId: '999', name: 'Thomas', allowed: true })
    expect((await q.memberByTelegramId('999'))!.allowed).toBe(true)
  })

  it('lets in someone new who is added without saying either way', async () => {
    await post({ telegramUserId: '999', name: 'Kid' })
    expect((await q.memberByTelegramId('999'))!.allowed).toBe(true)
  })

  it('returns the refreshed list with linked mailboxes shown', async () => {
    const m = await q.upsertMember('777', 'Linked', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'l@hearth.example', refreshToken: 'r', scopes: null })
    const body = await (await post({ telegramUserId: '999', name: 'Ada' })).json()
    const linked = body.members.find((x: { telegramUserId: string }) => x.telegramUserId === '777')
    expect(linked.linked).toEqual([{ provider: 'google', email: 'l@hearth.example' }])
  })
})

describe('removing a member', () => {
  beforeEach(asAdmin)

  it('removes an ordinary member', async () => {
    await post({ telegramUserId: '999', name: 'Ada' })
    expect((await del('999')).status).toBe(200)
    expect(await q.memberByTelegramId('999')).toBeUndefined()
  })

  it('quiets the rooms they talked in, before the history forgets it was them', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await post({ telegramUserId: '999', name: 'Ada' })
    await q.rememberChat('-100', 'group', 'Family')
    await q.recordMessage({ chatId: '-100', memberId: (await q.memberByTelegramId('999'))!.id, role: 'user', content: 'hi' })
    expect((await del('999')).status).toBe(200)
    expect(await q.strangersIn('-100')).toEqual([{ id: '999', name: 'Ada' }])
  })

  it('refuses to pretend it removed a founding member', async () => {
    await post({ telegramUserId: '8734670748', name: 'Rowan' })
    const res = await del('8734670748')
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toContain('ALLOWED_TELEGRAM_IDS')
    expect(await q.memberByTelegramId('8734670748')).toBeDefined()
  })

  it('404s on someone it has never seen', async () => {
    expect((await del('123')).status).toBe(404)
  })

  it('needs to be told who', async () => {
    expect((await DELETE(new Request('https://hearth.example/api/admin/members', { method: 'DELETE' }))).status).toBe(400)
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

  it('renames the only admin from the Add row, which leaves admin out rather than saying no', async () => {
    const res = await post({ telegramUserId: '999', name: 'Ada Han' })
    expect(res.status).toBe(200)
    expect(await q.memberByTelegramId('999')).toMatchObject({ name: 'Ada Han', allowed: true, isAdmin: true })
  })

  it('still edits the only admin in place — a new email is not a demotion', async () => {
    const res = await post({ telegramUserId: '999', name: 'Ada', email: 'ada@hearth.example', isAdmin: true })
    expect(res.status).toBe(200)
    expect((await q.memberByTelegramId('999'))!.email).toBe('ada@hearth.example')
  })

  it('lets them go once a successor is appointed', async () => {
    await post({ telegramUserId: '111', name: 'Boss', isAdmin: true })
    expect((await post({ telegramUserId: '999', name: 'Ada', isAdmin: false })).status).toBe(200)
    expect((await del('999')).status).toBe(200)
  })
})
