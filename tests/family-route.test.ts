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
// The mailbox a draft goes from; sending is the provider's, and stands in here.
const sendMail = vi.hoisted(() => vi.fn())
const clientFor = vi.hoisted(() => vi.fn((_id: number, provider: string) => ({ provider, sendMail })))
vi.mock('@/lib/providers', async (orig) => ({ ...(await orig<typeof import('@/lib/providers')>()), clientFor }))

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

  it("ticks a goal's steps for anyone in a group's, and for its owner alone in a private one", async () => {
    await asMember()
    const ada = (await q.memberByTelegramId('222'))!
    const group = await q.createGoal({ chatId: '-100', memberId: null, title: 'Trip' })
    const [book] = await q.addGoalSteps(group.id, ['Book flights'])
    const theirs = await q.createGoal({ chatId: '333', memberId: null, title: 'Private' })
    const [hidden] = await q.addGoalSteps(theirs.id, ['Secret step'])
    const mine = await q.createGoal({ chatId: '222', memberId: ada.id, title: 'Mine' })
    const [own] = await q.addGoalSteps(mine.id, ['My step'])

    expect(await (await post({ action: 'toggle_goal_step', id: book.id, done: true })).json()).toEqual({ ok: true, done: true })
    expect((await q.getGoalStep(book.id))!.done).toBe(true)
    expect((await post({ action: 'toggle_goal_step', id: hidden.id, done: true })).status).toBe(404)
    expect((await q.getGoalStep(hidden.id))!.done).toBe(false)
    expect((await post({ action: 'toggle_goal_step', id: own.id, done: true })).status).toBe(200)
    expect((await post({ action: 'toggle_goal_step', id: 999, done: true })).status).toBe(404)
  })

  it('resumes a paused one-off from Home at its own time, not a year on', async () => {
    await asMember()
    const at = new Date(Date.now() + 5 * 86_400_000)
    const job = await q.addAutomation({ chatId: '-100', label: 'plumber', cronExpr: '0 17 1 1 *', instruction: 'i', nextRunAt: at, repeat: 'once' })
    await post({ action: 'pause_automation', id: job.id, enabled: false })
    await post({ action: 'pause_automation', id: job.id, enabled: true })
    expect((await q.getAutomation(job.id))!.nextRunAt.getTime()).toBe(at.getTime())
  })

  it("closes a goal as done or dropped, once, ending its check-ins, and leaves another member's private one alone", async () => {
    await asMember()
    const ada = (await q.memberByTelegramId('222'))!
    const check = await q.addAutomation({ chatId: '-100', label: 'Goal check-in: Trip', cronExpr: '0 19 * * 0', instruction: 'i', nextRunAt: new Date(Date.now() + 86_400_000) })
    const trip = await q.createGoal({ chatId: '-100', memberId: ada.id, title: 'Trip' })
    await q.updateGoal(trip.id, { automationId: check.id })
    const theirs = await q.createGoal({ chatId: '333', memberId: null, title: 'Private' })
    const mine = await q.createGoal({ chatId: '222', memberId: ada.id, title: 'Mine' })

    expect((await post({ action: 'close_goal', id: trip.id, status: 'finished' })).status).toBe(400)
    const res = await post({ action: 'close_goal', id: trip.id, status: 'done' })
    expect(await res.json()).toEqual({ ok: true, closed: 'Trip', status: 'done' })
    expect(await q.getGoal(trip.id)).toMatchObject({ status: 'done' })
    expect(await q.getAutomation(check.id)).toBeUndefined()
    expect((await post({ action: 'close_goal', id: trip.id, status: 'dropped' })).status).toBe(404)

    expect((await post({ action: 'close_goal', id: theirs.id, status: 'dropped' })).status).toBe(404)
    expect(await q.getGoal(theirs.id)).toMatchObject({ status: 'active' })
    expect((await post({ action: 'close_goal', id: mine.id, status: 'dropped' })).status).toBe(200)
    expect((await post({ action: 'close_goal', id: 999, status: 'done' })).status).toBe(404)
  })

  describe('email drafts waiting on their writer', () => {
    async function draftOf(memberId: number, subject = 'Excursion form') {
      return q.createDraft({ chatId: '-100', memberId, provider: 'google', to: ['office@example.org'], cc: ['nan@example.org'], subject, body: 'Signed and attached.' })
    }

    it('sends a draft on its writer\'s click, once, as written, and keeps it on record', async () => {
      await asMember()
      const ada = (await q.memberByTelegramId('222'))!
      const draft = await draftOf(ada.id)
      sendMail.mockResolvedValue({ ok: true })
      const res = await post({ action: 'send_draft', id: draft.id })
      expect(await res.json()).toEqual({ ok: true, sent: 'Excursion form' })
      expect(clientFor).toHaveBeenCalledWith(ada.id, 'google')
      expect(sendMail).toHaveBeenCalledWith({ to: ['office@example.org'], cc: ['nan@example.org'], subject: 'Excursion form', body: 'Signed and attached.' })
      expect((await q.getDraft(draft.id))!.status).toBe('sent')
      expect((await post({ action: 'send_draft', id: draft.id })).status).toBe(409)
      expect(sendMail).toHaveBeenCalledTimes(1)
      const [logged] = await q.recentActivity()
      expect(logged).toMatchObject({ via: 'web', tool: 'send_email', summary: 'sent the email to office@example.org, "Excursion form"' })
    })

    it('sends nothing from an account linked read only since the draft was written', async () => {
      await asMember()
      const ada = (await q.memberByTelegramId('222'))!
      await q.saveConnection({ memberId: ada.id, provider: 'google', email: 'ada@gmail.example', refreshToken: 'r', scopes: null })
      await q.setConnectionReadOnly(ada.id, 'google', true)
      const draft = await draftOf(ada.id)
      const res = await post({ action: 'send_draft', id: draft.id })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toContain('linked read-only')
      expect(sendMail).not.toHaveBeenCalled()
      expect((await q.getDraft(draft.id))!.status).toBe('pending')
    })

    it("will not send or discard anyone else's", async () => {
      await asMember()
      const other = await q.upsertMember('333', 'Rowan', { allowed: true })
      const draft = await draftOf(other.id)
      expect((await post({ action: 'send_draft', id: draft.id })).status).toBe(404)
      expect((await post({ action: 'discard_draft', id: draft.id })).status).toBe(404)
      expect((await post({ action: 'send_draft', id: 999 })).status).toBe(404)
      expect(sendMail).not.toHaveBeenCalled()
      expect((await q.getDraft(draft.id))!.status).toBe('pending')
    })

    it('hands a draft back when the send fails, and keeps one that may have gone', async () => {
      await asMember()
      const ada = (await q.memberByTelegramId('222'))!
      const draft = await draftOf(ada.id)
      sendMail.mockRejectedValueOnce(new Error('Gmail said no'))
      const failed = await post({ action: 'send_draft', id: draft.id })
      expect(failed.status).toBe(502)
      expect((await failed.json()).error).toContain('Gmail said no')
      expect((await q.getDraft(draft.id))!.status).toBe('pending')

      const { UnconfirmedError } = await import('@/lib/deadline')
      sendMail.mockRejectedValueOnce(new UnconfirmedError())
      const unsure = await post({ action: 'send_draft', id: draft.id })
      expect(unsure.status).toBe(504)
      expect((await unsure.json()).error).toContain('may or may not have gone')
      expect((await q.getDraft(draft.id))!.status).toBe('sent')
    })

    it('discards a draft, once', async () => {
      await asMember()
      const ada = (await q.memberByTelegramId('222'))!
      const draft = await draftOf(ada.id)
      expect(await (await post({ action: 'discard_draft', id: draft.id })).json()).toEqual({ ok: true, discarded: 'Excursion form' })
      expect((await q.getDraft(draft.id))!.status).toBe('cancelled')
      expect((await post({ action: 'discard_draft', id: draft.id })).status).toBe(409)
      expect((await q.recentActivity())[0]).toMatchObject({ via: 'web', summary: `discarded email draft ${draft.id}` })
    })

    it("are listed on Home for their writer alone", async () => {
      const ada = await q.upsertMember('222', 'Ada', { allowed: true })
      const rowan = await q.upsertMember('333', 'Rowan', { allowed: true })
      await q.rememberChat('-100', 'group', 'Family')
      await draftOf(ada.id, 'Hers')
      await draftOf(rowan.id, 'His')
      const done = await draftOf(ada.id, 'Sent already')
      await q.markDraft(done.id, 'sent')
      await q.createDraft({ chatId: '222', memberId: ada.id, provider: 'microsoft', to: ['bank@example.org'], subject: 'From Outlook', body: 'x' })
      const stats = await gatherFamilyStats(undefined, ada.id)
      expect(stats.drafts).toEqual([
        { id: expect.any(Number), to: 'bank@example.org', cc: null, subject: 'From Outlook', body: 'x', from: 'Outlook', chat: 'Ada', when: expect.any(String) },
        { id: expect.any(Number), to: 'office@example.org', cc: 'nan@example.org', subject: 'Hers', body: 'Signed and attached.', from: 'Gmail', chat: 'Family', when: expect.any(String) },
      ])
      expect((await gatherFamilyStats()).drafts).toEqual([])
    })
  })

  it('lists the helpers on Home, and lets any member let one go', async () => {
    await asMember()
    const chef = (await q.addHelper({ name: 'Chef', role: 'Plans meals. Keeps to allergies.', groups: [], createdBy: null }))!
    expect((await gatherFamilyStats()).helpers).toEqual([{ id: chef.id, name: 'Chef', role: 'Plans meals.' }])
    expect(await (await post({ action: 'remove_helper', id: chef.id })).json()).toEqual({ ok: true, removed: 'Chef' })
    expect((await post({ action: 'remove_helper', id: chef.id })).status).toBe(404)
    expect((await gatherFamilyStats()).helpers).toEqual([])
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
