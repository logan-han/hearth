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

const { POST } = await import('@/app/api/family/route')
const { createSession } = await import('@/lib/auth/session')

let client: PGlite

const post = (body: unknown) =>
  POST(new Request('https://hearth.han.life/api/family', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

const asMember = () => createSession({ email: 'ada@han.life', name: 'Ada', provider: 'google', role: 'member' })

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('the family API', () => {
  it('needs a session, but an ordinary member is enough', async () => {
    expect((await post({ action: 'delete_item', id: 1 })).status).toBe(401)
    await asMember()
    expect((await post({ action: 'nonsense' })).status).toBe(400)
  })

  it('rejects a malformed body', async () => {
    await asMember()
    const res = await POST(new Request('https://h/api/family', { method: 'POST', body: 'nope' }))
    expect(res.status).toBe(400)
  })

  it('cancels an event for everyone', async () => {
    await asMember()
    const e = await q.addFamilyEvent({ title: 'Swimming', startsAt: new Date('2026-09-01T00:00:00Z'), endsAt: new Date('2026-09-01T01:00:00Z') })
    expect((await post({ action: 'cancel_event', id: e.id })).status).toBe(200)
    const [row] = await q.listFamilyEvents(new Date('2026-08-01'), new Date('2026-10-01'))
    expect(row.cancelled).toBe(true)
    expect((await post({ action: 'cancel_event', id: 999 })).status).toBe(404)
  })

  it('adds a proposal to the calendar on a yes, once, and drops it on a no', async () => {
    await asMember()
    const yes = await q.addProposal({
      chatId: '-100', title: 'Aths carnival', location: 'School oval',
      startsAt: new Date('2030-09-03T03:30:00Z'), endsAt: new Date('2030-09-03T05:00:00Z'), allDay: false,
    })
    const no = await q.addProposal({
      chatId: '-100', title: 'Pharmacist call',
      startsAt: new Date('2030-09-01T00:00:00Z'), endsAt: new Date('2030-09-02T00:00:00Z'), allDay: true,
    })
    expect(await q.pendingProposals('-100')).toHaveLength(2)

    const res = await post({ action: 'accept_proposal', id: yes.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, added: true })
    const [event] = await q.listFamilyEvents(new Date('2030-09-01'), new Date('2030-09-30'))
    expect(event).toMatchObject({ title: 'Aths carnival', location: 'School oval' })
    // A second click finds nothing left to accept and adds nothing.
    expect((await post({ action: 'accept_proposal', id: yes.id })).status).toBe(404)
    expect(await q.listFamilyEvents(new Date('2030-09-01'), new Date('2030-09-30'))).toHaveLength(1)

    expect((await post({ action: 'reject_proposal', id: no.id })).status).toBe(200)
    expect(await q.pendingProposals('-100')).toHaveLength(0)
    expect((await post({ action: 'reject_proposal', id: no.id })).status).toBe(404)
  })

  it('settles a proposal whose event already got there another way without doubling it', async () => {
    await asMember()
    const p = await q.addProposal({
      chatId: '-100', title: 'Sports day',
      startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T02:00:00Z'), allDay: false,
    })
    await q.addFamilyEvent({ title: 'sports day', startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T02:00:00Z') })
    // Already off the list, and a late click still cannot double the event.
    expect(await q.pendingProposals('-100')).toHaveLength(0)
    const res = await post({ action: 'accept_proposal', id: p.id })
    expect(await res.json()).toMatchObject({ ok: true, added: false, already: 'sports day' })
    expect(await q.listFamilyEvents(new Date('2030-09-01'), new Date('2030-09-30'))).toHaveLength(1)
  })

  it('pauses and resumes a reminder, recomputing its next run', async () => {
    await asMember()
    const a = await q.addAutomation({
      chatId: '-100', memberId: null, label: 'bins', cronExpr: '0 19 * * 1',
      instruction: 'x', nextRunAt: new Date('2026-09-07T09:00:00Z'),
    })
    await post({ action: 'pause_automation', id: a.id, enabled: false })
    expect((await q.getAutomation(a.id))!.enabled).toBe(false)
    await post({ action: 'pause_automation', id: a.id, enabled: true })
    const resumed = (await q.getAutomation(a.id))!
    expect(resumed.enabled).toBe(true)
    expect(resumed.nextRunAt.getTime()).toBeGreaterThan(Date.now())
    expect((await post({ action: 'pause_automation', id: 999, enabled: false })).status).toBe(404)
  })

  it('deletes a reminder for good', async () => {
    await asMember()
    const a = await q.addAutomation({
      chatId: '-100', memberId: null, label: 'gone', cronExpr: '0 19 * * 1',
      instruction: 'x', nextRunAt: new Date('2026-09-07T09:00:00Z'),
    })
    expect((await post({ action: 'delete_automation', id: a.id })).status).toBe(200)
    expect(await q.getAutomation(a.id)).toBeUndefined()
  })

  it('ticks, unticks, deletes and adds list items', async () => {
    await asMember()
    const list = await q.findOrCreateList('shopping')
    const [milk] = await q.addListItems(list.id, ['milk'])

    await post({ action: 'toggle_item', id: milk.id, done: true })
    expect((await q.listContents(list.id))[0].done).toBe(true)
    await post({ action: 'toggle_item', id: milk.id, done: false })
    expect((await q.listContents(list.id))[0].done).toBe(false)

    expect((await post({ action: 'delete_item', id: milk.id })).status).toBe(200)
    expect(await q.listContents(list.id)).toHaveLength(0)
    expect((await post({ action: 'delete_item', id: milk.id })).status).toBe(404)

    const res = await post({ action: 'add_item', list: 'shopping', content: ' bread ' })
    expect(res.status).toBe(200)
    expect((await q.listContents(list.id)).map((i) => i.content)).toEqual(['bread'])
  })

  it('starts a brand-new list on first add, and insists on both halves', async () => {
    await asMember()
    expect((await post({ action: 'add_item', list: 'camping', content: 'tent pegs' })).status).toBe(200)
    const made = await q.findList('camping')
    expect((await q.listContents(made!.id)).map((i) => i.content)).toEqual(['tent pegs'])
    expect((await post({ action: 'add_item', list: '', content: 'x' })).status).toBe(400)
    expect((await post({ action: 'add_item', list: 'camping', content: '  ' })).status).toBe(400)
  })
})
