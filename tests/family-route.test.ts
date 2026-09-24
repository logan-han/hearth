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

const { GET, POST } = await import('@/app/api/family/route')
const { createSession } = await import('@/lib/auth/session')
const { setSecret } = await import('@/lib/settings')
const { gatherFamilyStats } = await import('@/lib/stats')

let client: PGlite

const post = (body: unknown) =>
  POST(new Request('https://hearth.example/api/family', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

const asMember = async () => {
  await q.saveMember({ telegramUserId: '222', name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
  await createSession({ email: 'ada@hearth.example', name: 'Ada', provider: 'google', role: 'member' })
}

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  // The route reads the settings store now, which would take a zone left here as the deployment's.
  delete process.env.TIMEZONE
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
      chatId: '-100', title: 'Athletics carnival',
      startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T02:00:00Z'), allDay: false,
    })
    await q.addFamilyEvent({ title: 'athletics carnival', startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T02:00:00Z') })
    // Already off the list, and a late click still cannot double the event.
    expect(await q.pendingProposals('-100')).toHaveLength(0)
    const res = await post({ action: 'accept_proposal', id: p.id })
    expect(await res.json()).toMatchObject({ ok: true, added: false, already: 'athletics carnival' })
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

  it('resumes a reminder on the zone the dashboard holds, on an instance still carrying the deployed one', async () => {
    await asMember()
    await setSecret('TIMEZONE', 'Europe/London', 'ada@hearth.example')
    // What an instance that has not read the store since the change still holds.
    process.env.TIMEZONE = 'Australia/Melbourne'
    const a = await q.addAutomation({
      chatId: '-100', memberId: null, label: 'wake up', cronExpr: '0 7 * * *',
      instruction: 'x', nextRunAt: new Date('2026-09-07T09:00:00Z'),
    })
    await post({ action: 'pause_automation', id: a.id, enabled: false })
    await post({ action: 'pause_automation', id: a.id, enabled: true })
    const next = (await q.getAutomation(a.id))!.nextRunAt
    const londonHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(next)
    expect(londonHour).toBe('07')
  })

  it('deletes a reminder for good', async () => {
    await asMember()
    const a = await q.addAutomation({
      chatId: '-100', memberId: null, label: 'gone', cronExpr: '0 19 * * 1',
      instruction: 'x', nextRunAt: new Date('2026-09-07T09:00:00Z'),
    })
    expect((await post({ action: 'delete_automation', id: a.id })).status).toBe(200)
    expect(await q.getAutomation(a.id)).toBeUndefined()
    expect((await post({ action: 'delete_automation', id: a.id })).status).toBe(404)
  })

  it('reports a reminder that vanished between being found and being deleted', async () => {
    await asMember()
    const a = await q.addAutomation({
      chatId: '-100', memberId: null, label: 'gone', cronExpr: '0 19 * * 1',
      instruction: 'x', nextRunAt: new Date('2026-09-07T09:00:00Z'),
    })
    vi.spyOn(q, 'deleteAutomation').mockResolvedValueOnce(false)
    const res = await post({ action: 'delete_automation', id: a.id })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe(`No reminder ${a.id}.`)
  })

  it('will not delete a built-in watcher, only pause it', async () => {
    await asMember()
    const a = await q.addAutomation({
      chatId: '-100', memberId: null, label: 'Morning brief', cronExpr: '0 7 * * *',
      instruction: 'x', kind: 'morning', nextRunAt: new Date('2026-09-07T09:00:00Z'),
    })
    const res = await post({ action: 'delete_automation', id: a.id })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('built in')
    expect(await q.getAutomation(a.id)).toBeDefined()
    expect((await post({ action: 'pause_automation', id: a.id, enabled: false })).status).toBe(200)
    expect((await q.getAutomation(a.id))!.enabled).toBe(false)
  })

  it('forgets a remembered fact softly, and only once', async () => {
    await asMember()
    const m = await q.addMemory('bin night is Monday')
    const res = await post({ action: 'forget_memory', id: m.id })
    expect(res.status).toBe(200)
    expect((await res.json()).forgotten).toBe('bin night is Monday')
    expect(await q.listMemories()).toHaveLength(0)
    expect((await post({ action: 'forget_memory', id: m.id })).status).toBe(404)
  })

  it('answers a question with a yes that keeps the fact as written, or a no that keeps nothing', async () => {
    await asMember()
    const { row } = await q.askQuestion({ question: 'Who attends Hillside Grammar?', candidate: 'Juno attends Hillside Grammar' })
    const yes = await post({ action: 'answer_question', id: row.id, fact: ' Juno is in Year 3 at Hillside Grammar ' })
    expect(yes.status).toBe(200)
    expect((await yes.json()).kept).toBe('Juno is in Year 3 at Hillside Grammar')
    expect((await q.listMemories()).map((m) => m.content)).toEqual(['Juno is in Year 3 at Hillside Grammar'])
    expect((await post({ action: 'answer_question', id: row.id })).status).toBe(404)

    const other = await q.askQuestion({ question: 'Does anyone attend Riverbend College?', candidate: 'A family member attends Riverbend College' })
    const no = await post({ action: 'answer_question', id: other.row.id })
    expect(no.status).toBe(200)
    expect((await no.json()).dismissed).toBe(true)
    expect(await q.listMemories()).toHaveLength(1)
    expect(await q.openQuestions()).toHaveLength(0)
  })

  it('answers a question with a correction that retires the fact it corrects', async () => {
    await asMember()
    await q.addMemory('Ada is in year 3')
    const { row } = await q.askQuestion({ question: 'Is Ada in year 4 now?', candidate: 'Ada is in year 4' })
    const yes = await post({ action: 'answer_question', id: row.id, fact: 'Ada is in year 4' })
    expect(yes.status).toBe(200)
    expect((await q.listMemories()).map((m) => m.content)).toEqual(['Ada is in year 4'])
  })

  it('ticks, unticks, deletes and adds list items', async () => {
    await asMember()
    const list = await q.findOrCreateList('shopping')
    const [milk] = await q.addListItems(list.id, ['milk'])

    await post({ action: 'toggle_item', id: milk.id, done: true })
    expect((await q.listContents(list.id))[0].done).toBe(true)
    await post({ action: 'toggle_item', id: milk.id, done: false })
    expect((await q.listContents(list.id))[0].done).toBe(false)
    expect((await post({ action: 'toggle_item', id: 999, done: true })).status).toBe(404)

    expect((await post({ action: 'delete_item', id: milk.id })).status).toBe(200)
    expect(await q.listContents(list.id)).toHaveLength(0)
    expect((await post({ action: 'delete_item', id: milk.id })).status).toBe(404)

    const res = await post({ action: 'add_item', list: 'shopping', content: ' bread ' })
    expect(res.status).toBe(200)
    expect((await q.listContents(list.id)).map((i) => i.content)).toEqual(['bread'])
  })

  it('clears a list of its ticked items, leaving what is still to get', async () => {
    await asMember()
    const list = await q.findOrCreateList('shopping')
    const [milk, , eggs] = await q.addListItems(list.id, ['milk', 'bread', 'eggs'])
    await q.setListItemDone(milk.id, true)
    await q.setListItemDone(eggs.id, true)
    const other = await q.findOrCreateList('hardware')
    const [nails] = await q.addListItems(other.id, ['nails'])
    await q.setListItemDone(nails.id, true)

    const res = await post({ action: 'clear_ticked', id: list.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, cleared: 2 })
    expect((await q.listContents(list.id)).map((i) => i.content)).toEqual(['bread'])
    // Another list's ticked items are that list's to clear.
    expect((await q.listContents(other.id)).map((i) => i.content)).toEqual(['nails'])
  })

  it('hands over a whole list, so an item just ticked that Home leaves out can be unticked', async () => {
    const whole = (id: unknown) => GET(new Request(`https://hearth.example/api/family?list=${id}`))
    const list = await q.findOrCreateList('shopping')
    expect((await whole(list.id)).status).toBe(401)
    await asMember()

    // Batteries waited on the list while last week's ten were bought and ticked.
    const [batteries] = await q.addListItems(list.id, ['batteries'])
    for (const i of await q.addListItems(list.id, Array.from({ length: 10 }, (_, n) => `bought ${n + 1}`))) {
      await q.setListItemDone(i.id, true)
    }
    await post({ action: 'toggle_item', id: batteries.id, done: true })
    const home = (await gatherFamilyStats()).lists.find((l) => l.name === 'shopping')!
    expect(home.items.some((i) => i.id === batteries.id)).toBe(false)
    expect(home.ticked).toBe(11)

    const res = await whole(list.id)
    expect(res.status).toBe(200)
    const { items } = await res.json()
    expect(items).toHaveLength(11)
    expect(items[0]).toEqual({ id: batteries.id, content: 'batteries', done: true })

    expect((await whole('')).status).toBe(400)
    expect((await whole('abc')).status).toBe(400)
  })

  it('starts a brand-new list on first add, and insists on both halves', async () => {
    await asMember()
    expect((await post({ action: 'add_item', list: 'camping', content: 'tent pegs' })).status).toBe(200)
    const made = await q.findList('camping')
    expect((await q.listContents(made!.id)).map((i) => i.content)).toEqual(['tent pegs'])
    expect((await post({ action: 'add_item', list: '', content: 'x' })).status).toBe(400)
    expect((await post({ action: 'add_item', list: 'camping', content: '  ' })).status).toBe(400)
  })

  it('rejects an add_item call with no list or content field at all', async () => {
    await asMember()
    const res = await post({ action: 'add_item' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('A list and an item are needed.')
  })

  it('puts an accepted proposal down to whoever is signed in', async () => {
    await asMember()
    const ada = await q.memberByTelegramId('222')
    const p = await q.addProposal({
      chatId: '-100', title: 'Trivia night', location: 'Corner Cafe',
      startsAt: new Date('2030-09-03T03:30:00Z'), endsAt: new Date('2030-09-03T05:00:00Z'), allDay: false,
    })
    expect((await post({ action: 'accept_proposal', id: p.id })).status).toBe(200)
    const [event] = await q.listFamilyEvents(new Date('2030-09-01'), new Date('2030-09-30'))
    expect(event).toMatchObject({ title: 'Trivia night', createdBy: ada!.id })
  })

  it('turns away a cookie whose member has since been revoked, or was never recognised', async () => {
    await asMember()
    await q.setMemberAllowed('222', false)
    expect((await post({ action: 'add_item', list: 'shopping', content: 'milk' })).status).toBe(401)

    await createSession({ email: 'stranger@else.example', name: 'S', provider: 'google', role: 'admin' })
    expect((await post({ action: 'add_item', list: 'shopping', content: 'milk' })).status).toBe(401)
  })
})
