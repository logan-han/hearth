import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { jar } from './helpers/next-headers'

vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))

const { GET, POST, DELETE } = await import('@/app/api/admin/members/route')
const { createSession } = await import('@/lib/auth/session')

let client: PGlite

const post = (body: unknown) =>
  POST(new Request('https://hearth.example/api/admin/members', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
const del = (id: number | string) =>
  DELETE(new Request(`https://hearth.example/api/admin/members?id=${id}`, { method: 'DELETE' }))

const asAdmin = () => createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
const asMember = () => createSession({ email: 'ada@hearth.example', name: 'Ada', provider: 'google', role: 'member' })

const byEmail = async (email: string) => (await q.allMembers()).find((m) => m.email === email)

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.ADMIN_EMAILS = 'rowan@hearth.example'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('only an admin may manage the family', () => {
  it('refuses everything without a session', async () => {
    expect((await GET()).status).toBe(401)
    expect((await post({ name: 'X', email: 'x@hearth.example' })).status).toBe(401)
    expect((await del(1)).status).toBe(401)
  })

  it('refuses a member session, which can sign in but not administer', async () => {
    await q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
    await asMember()
    expect((await GET()).status).toBe(401)
    expect((await post({ name: 'X', email: 'x@hearth.example' })).status).toBe(401)
    expect(await byEmail('x@hearth.example')).toBeUndefined()
  })
})

describe('adding and editing a member', () => {
  beforeEach(asAdmin)

  it('lists members for a signed-in admin', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.members.map((m: { name: string }) => m.name)).toEqual(['Ada'])
  })

  it('adds someone by name and the address they sign in with, let in', async () => {
    const res = await post({ name: 'Ada', email: 'Ada@Hearth.Example' })
    expect(res.status).toBe(200)
    // Normalised, so sign-in matching does not depend on how it was typed.
    const saved = await byEmail('ada@hearth.example')
    expect(saved).toMatchObject({ name: 'Ada', allowed: true, isAdmin: false })
  })

  it('adds an admin when asked', async () => {
    await post({ name: 'Sam', email: 'sam@hearth.example', isAdmin: true })
    expect((await byEmail('sam@hearth.example'))!.isAdmin).toBe(true)
  })

  it('needs an address for someone new, since it is how they sign in', async () => {
    const res = await post({ name: 'Kid' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('how they sign in')
    expect(await q.allMembers()).toEqual([])
  })

  it('needs a name', async () => {
    expect((await post({ email: 'ada@hearth.example' })).status).toBe(400)
    expect((await post({ name: '   ', email: 'ada@hearth.example' })).status).toBe(400)
  })

  it('rejects something that is not an email address', async () => {
    const res = await post({ name: 'Ada', email: 'not-an-email' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('does not look like an email')
  })

  it('rejects the near misses too', async () => {
    for (const email of ['@x.com', 'a@b', 'a@@b.com', 'a@b..com', 'a b@c.com', 'a@.com']) {
      expect((await post({ name: 'Ada', email })).status, email).toBe(400)
    }
  })

  it('rejects a malformed body, and a member id that could not be one', async () => {
    const res = await POST(new Request('https://hearth.example/api/admin/members', { method: 'POST', body: '{nope' }))
    expect(res.status).toBe(400)
    for (const id of [0, -1, 2.5, 'x']) {
      expect((await post({ id, name: 'Ada' })).status, String(id)).toBe(400)
    }
  })

  it('changes the person already here when an address is added again, rather than making a second', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    await post({ name: 'Ada Lovelace', email: 'ADA@hearth.example' })
    const all = await q.allMembers()
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe('Ada Lovelace')
  })

  it('adding an address already here keeps the admin the add left out', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example', isAdmin: true })
    await post({ name: 'Ada L', email: 'ada@hearth.example' })
    expect(await byEmail('ada@hearth.example')).toMatchObject({ name: 'Ada L', isAdmin: true, allowed: true })
  })

  it('adding an address already here does not let back in someone who was revoked', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    const ada = (await byEmail('ada@hearth.example'))!
    await post({ id: ada.id, name: 'Ada', allowed: false })
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    expect((await byEmail('ada@hearth.example'))!.allowed).toBe(false)
  })

  it('changes a member by id, keeping whatever the body leaves out', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example', isAdmin: true })
    const ada = (await byEmail('ada@hearth.example'))!
    await post({ id: ada.id, name: 'Ada Lovelace' })
    expect(await q.memberById(ada.id)).toMatchObject({ name: 'Ada Lovelace', email: 'ada@hearth.example', isAdmin: true, allowed: true })
  })

  it('finds an address among members, some of whom have none', async () => {
    await q.saveMember({ name: 'Kid', email: null, allowed: true, isAdmin: false })
    expect((await post({ name: 'Ada', email: 'ada@hearth.example' })).status).toBe(200)
    expect((await q.allMembers()).map((m) => m.name).sort()).toEqual(['Ada', 'Kid'])
  })

  it('keeps no address when a change by id leaves it out of someone who has none', async () => {
    const kid = await q.saveMember({ name: 'Kid', email: null, allowed: true, isAdmin: false })
    expect((await post({ id: kid.id, name: 'Kiddo' })).status).toBe(200)
    expect(await q.memberById(kid.id)).toMatchObject({ name: 'Kiddo', email: null })
  })

  it('changes an address by id, and clears it on empty', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    const ada = (await byEmail('ada@hearth.example'))!
    await post({ id: ada.id, name: 'Ada', email: 'ada.l@hearth.example' })
    expect((await q.memberById(ada.id))!.email).toBe('ada.l@hearth.example')
    await post({ id: ada.id, name: 'Ada', email: '' })
    expect((await q.memberById(ada.id))!.email).toBeNull()
  })

  it("will not give a member another member's address", async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    await post({ name: 'Sam', email: 'sam@hearth.example' })
    const sam = (await byEmail('sam@hearth.example'))!
    const res = await post({ id: sam.id, name: 'Sam', email: 'ada@hearth.example' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("already Ada's address")
  })

  it('404s on a member id it has never seen', async () => {
    expect((await post({ id: 999, name: 'Ghost' })).status).toBe(404)
  })

  it('can promote and demote, while another admin remains', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example', isAdmin: true })
    await post({ name: 'Sam', email: 'sam@hearth.example', isAdmin: true })
    const ada = (await byEmail('ada@hearth.example'))!
    expect((await post({ id: ada.id, name: 'Ada', isAdmin: false })).status).toBe(200)
    expect((await q.memberById(ada.id))!.isAdmin).toBe(false)
  })

  it('revoking access takes admin with it, so they cannot sign in', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example', isAdmin: true })
    await post({ name: 'Sam', email: 'sam@hearth.example', isAdmin: true })
    const ada = (await byEmail('ada@hearth.example'))!
    await post({ id: ada.id, name: 'Ada', allowed: false, isAdmin: true })
    expect(await q.memberById(ada.id)).toMatchObject({ allowed: false, isAdmin: false })
  })

  it('a revoked member holds no key any more, though it stays on record', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    const ada = (await byEmail('ada@hearth.example'))!
    const { key } = await q.issueMcpKey(ada.id, 'Laptop')
    await post({ id: ada.id, name: 'Ada', allowed: false })
    expect(await q.memberByMcpKey(key)).toBeNull()
    await post({ id: ada.id, name: 'Ada', allowed: true })
    expect((await q.memberByMcpKey(key))?.member.id).toBe(ada.id)
  })

  it('returns the refreshed list with linked mailboxes shown', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    const ada = (await byEmail('ada@hearth.example'))!
    await q.saveConnection({ memberId: ada.id, provider: 'google', email: 'ada@gmail.com', refreshToken: 'r', scopes: null })
    const body = await (await post({ id: ada.id, name: 'Ada' })).json()
    expect(body.members[0].linked).toEqual([{ provider: 'google', email: 'ada@gmail.com', readOnly: false }])
  })
})

describe('removing a member', () => {
  beforeEach(asAdmin)

  it('removes an ordinary member, their keys, links and drafts with them', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    const ada = (await byEmail('ada@hearth.example'))!
    const { key } = await q.issueMcpKey(ada.id, 'Laptop')
    expect((await del(ada.id)).status).toBe(200)
    expect(await q.memberById(ada.id)).toBeUndefined()
    expect(await q.memberByMcpKey(key)).toBeNull()
  })

  it('pauses their scheduled jobs before the row that says whose they are goes', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example' })
    const ada = (await byEmail('ada@hearth.example'))!
    const job = await q.addAutomation({ memberId: ada.id, label: 'Bins', cronExpr: '0 19 * * 1', instruction: 'Remind', nextRunAt: new Date() })
    await del(ada.id)
    expect(await q.getAutomation(job.id)).toMatchObject({ enabled: false, memberId: null })
  })

  it('404s on someone it has never seen', async () => {
    expect((await del(999)).status).toBe(404)
  })

  it('needs to be told who', async () => {
    expect((await DELETE(new Request('https://hearth.example/api/admin/members', { method: 'DELETE' }))).status).toBe(400)
    expect((await del('abc')).status).toBe(400)
  })
})

describe('the last admin cannot lock the house out', () => {
  let only: Awaited<ReturnType<typeof q.saveMember>>
  beforeEach(async () => {
    await asAdmin()
    only = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: true })
  })

  it('refuses to demote the only admin', async () => {
    const res = await post({ id: only.id, name: 'Rowan', isAdmin: false })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('only admin')
    expect((await q.memberById(only.id))!.isAdmin).toBe(true)
  })

  it('refuses to revoke the only admin', async () => {
    expect((await post({ id: only.id, name: 'Rowan', allowed: false })).status).toBe(400)
    expect((await q.memberById(only.id))!.allowed).toBe(true)
  })

  it('refuses to remove the only admin', async () => {
    const res = await del(only.id)
    expect(res.status).toBe(400)
    expect(await q.memberById(only.id)).toBeDefined()
  })

  it('renames the only admin from the Add row, which leaves admin out rather than saying no', async () => {
    expect((await post({ name: 'Rowan H', email: 'rowan@hearth.example' })).status).toBe(200)
    expect(await q.memberById(only.id)).toMatchObject({ name: 'Rowan H', isAdmin: true })
  })

  it('still edits the only admin in place: a new address is not a demotion', async () => {
    expect((await post({ id: only.id, name: 'Rowan', email: 'rowan.h@hearth.example' })).status).toBe(200)
    expect(await q.memberById(only.id)).toMatchObject({ email: 'rowan.h@hearth.example', isAdmin: true })
  })

  it('lets them go once a successor is appointed', async () => {
    await post({ name: 'Ada', email: 'ada@hearth.example', isAdmin: true })
    expect((await post({ id: only.id, name: 'Rowan', isAdmin: false })).status).toBe(200)
    expect((await del(only.id)).status).toBe(200)
  })

  it('counts a revoked admin as no admin at all', async () => {
    const ada = await q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: false, isAdmin: false })
    // Ada was never an admin who could step in, so Rowan is still the only one.
    expect((await post({ id: only.id, name: 'Rowan', isAdmin: false })).status).toBe(400)
    expect((await post({ id: ada.id, name: 'Ada', allowed: false })).status).toBe(200)
  })
})
