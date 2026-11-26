import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { Member } from '@/lib/db/schema'
import { jar } from './helpers/next-headers'

vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))

const { GET, POST } = await import('@/app/api/family/route')
const { createSession } = await import('@/lib/auth/session')
const { setSecret } = await import('@/lib/settings')
const { gatherFamilyStats } = await import('@/lib/stats')

let client: PGlite
let ada: Member

const post = (body: unknown) =>
  POST(new Request('https://hearth.example/api/family', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

const add = (name: string) => q.saveMember({ name, email: `${name.toLowerCase()}@hearth.example`, allowed: true, isAdmin: false })

const asMember = async () => {
  ada = await add('Ada')
  await createSession({ email: 'ada@hearth.example', name: 'Ada', provider: 'google', role: 'member' })
}

const job = (memberId: number | null, extra: Partial<Parameters<typeof q.addAutomation>[0]> = {}) =>
  q.addAutomation({ memberId, label: 'bins', cronExpr: '0 19 * * 1', instruction: 'x', nextRunAt: new Date('2026-09-07T09:00:00Z'), ...extra })

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  // The route reads the settings store now, which would take a zone left here as the deployment's.
  delete process.env.TIMEZONE
  delete process.env.ADMIN_EMAILS
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

  describe('a proposal', () => {
    const carnival = () =>
      q.addProposal({ title: 'Aths carnival', location: 'School oval', startsAt: new Date('2030-09-03T03:30:00Z'), endsAt: new Date('2030-09-03T05:00:00Z') })

    it('goes on the calendar on a yes, once, and drops on a no', async () => {
      await asMember()
      const yes = await carnival()
      const no = await q.addProposal({ title: 'Pharmacist call', startsAt: new Date('2030-09-01T00:00:00Z'), endsAt: new Date('2030-09-02T00:00:00Z'), allDay: true })
      expect(await q.pendingProposals()).toHaveLength(2)

      const res = await post({ action: 'accept_proposal', id: yes.id })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, status: 'added', title: 'Aths carnival', event_id: expect.any(Number) })
      const [event] = await q.listFamilyEvents(new Date('2030-09-01'), new Date('2030-09-30'))
      expect(event).toMatchObject({ title: 'Aths carnival', location: 'School oval', createdBy: ada.id })
      // A second click is told why there is nothing left to add, and adds nothing.
      const again = await post({ action: 'accept_proposal', id: yes.id })
      expect(again.status).toBe(409)
      expect(await again.json()).toMatchObject({ status: 'failed', reason: expect.stringContaining('already accepted') })
      expect(await q.listFamilyEvents(new Date('2030-09-01'), new Date('2030-09-30'))).toHaveLength(1)

      expect((await post({ action: 'reject_proposal', id: no.id })).status).toBe(200)
      expect(await q.pendingProposals()).toHaveLength(0)
      expect((await post({ action: 'reject_proposal', id: no.id })).status).toBe(404)
    })

    it('is held, naming the clash, when that day already has something on the calendar, until the member says it is different', async () => {
      await asMember()
      const p = await carnival()
      await q.addFamilyEvent({ title: 'Swimming lessons', startsAt: new Date('2030-09-02T23:00:00Z'), endsAt: new Date('2030-09-03T00:00:00Z') })

      const first = await post({ action: 'accept_proposal', id: p.id })
      expect(first.status).toBe(200)
      const held = await first.json()
      expect(held).toMatchObject({ status: 'needs_confirmation', proposal_id: p.id, clashes: [expect.objectContaining({ title: 'Swimming lessons' })] })
      expect(held.reason).toContain('"Swimming lessons"')
      // Nothing was claimed or added, and nothing went on the record.
      expect(await q.pendingProposals()).toHaveLength(1)
      expect(await q.listFamilyEvents(new Date('2030-09-01'), new Date('2030-09-30'))).toHaveLength(1)
      expect(await q.recentActivity()).toEqual([])

      const confirmed = await post({ action: 'accept_proposal', id: p.id, confirmedDistinct: true })
      expect(await confirmed.json()).toMatchObject({ status: 'added', title: 'Aths carnival' })
      expect(await q.listFamilyEvents(new Date('2030-09-01'), new Date('2030-09-30'))).toHaveLength(2)
      expect((await q.recentActivity())[0]).toMatchObject({ via: 'web', tool: 'accept_event_proposal', memberId: ada.id })
    })

    it('is refused with why when its event already got there another way, without doubling it', async () => {
      await asMember()
      const p = await q.addProposal({ title: 'Athletics carnival', startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T02:00:00Z') })
      await q.addFamilyEvent({ title: 'athletics carnival', startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T02:00:00Z') })
      const res = await post({ action: 'accept_proposal', id: p.id })
      expect(res.status).toBe(409)
      expect((await res.json()).reason).toContain('already on the family calendar')
      expect(await q.listFamilyEvents(new Date('2030-09-01'), new Date('2030-09-30'))).toHaveLength(1)
    })

    it('says there is no such proposal', async () => {
      await asMember()
      const res = await post({ action: 'accept_proposal', id: 999 })
      expect(res.status).toBe(409)
      expect((await res.json()).reason).toContain('There is no proposal 999')
    })
  })

  describe("a member's own reminders", () => {
    it('pause and resume, recomputing the next run', async () => {
      await asMember()
      const a = await job(ada.id)
      await post({ action: 'pause_automation', id: a.id, enabled: false })
      expect((await q.getAutomation(a.id))!.enabled).toBe(false)
      await post({ action: 'pause_automation', id: a.id, enabled: true })
      const resumed = (await q.getAutomation(a.id))!
      expect(resumed.enabled).toBe(true)
      expect(resumed.nextRunAt.getTime()).toBeGreaterThan(Date.now())
      expect((await post({ action: 'pause_automation', id: 999, enabled: false })).status).toBe(404)
    })

    it("are theirs alone: another member's, or nobody's, cannot be paused or deleted", async () => {
      await asMember()
      const sam = await add('Sam')
      const theirs = await job(sam.id)
      const nobodys = await job(null)
      for (const a of [theirs, nobodys]) {
        expect((await post({ action: 'pause_automation', id: a.id, enabled: false })).status).toBe(404)
        expect((await post({ action: 'delete_automation', id: a.id })).status).toBe(404)
        expect((await q.getAutomation(a.id))!.enabled).toBe(true)
      }
    })

    it('resume on the zone the dashboard holds, on an instance still carrying the deployed one', async () => {
      await asMember()
      await setSecret('TIMEZONE', 'Europe/London', 'ada@hearth.example')
      // What an instance that has not read the store since the change still holds.
      process.env.TIMEZONE = 'Australia/Melbourne'
      const a = await job(ada.id, { label: 'wake up', cronExpr: '0 7 * * *' })
      await post({ action: 'pause_automation', id: a.id, enabled: false })
      await post({ action: 'pause_automation', id: a.id, enabled: true })
      const next = (await q.getAutomation(a.id))!.nextRunAt
      const londonHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(next)
      expect(londonHour).toBe('07')
    })

    it('are deleted for good', async () => {
      await asMember()
      const a = await job(ada.id, { label: 'gone' })
      expect((await post({ action: 'delete_automation', id: a.id })).status).toBe(200)
      expect(await q.getAutomation(a.id)).toBeUndefined()
      expect((await post({ action: 'delete_automation', id: a.id })).status).toBe(404)
    })

    it('report one that vanished between being found and being deleted', async () => {
      await asMember()
      const a = await job(ada.id, { label: 'gone' })
      vi.spyOn(q, 'deleteAutomation').mockResolvedValueOnce(false)
      const res = await post({ action: 'delete_automation', id: a.id })
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe(`No reminder ${a.id}.`)
    })

    it('resume a paused one-off at its own time, not a year on', async () => {
      await asMember()
      const at = new Date(Date.now() + 5 * 86_400_000)
      const once = await job(ada.id, { label: 'plumber', cronExpr: '0 17 1 1 *', nextRunAt: at, repeat: 'once' })
      await post({ action: 'pause_automation', id: once.id, enabled: false })
      await post({ action: 'pause_automation', id: once.id, enabled: true })
      expect((await q.getAutomation(once.id))!.nextRunAt.getTime()).toBe(at.getTime())
    })
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

  it("ticks a goal's steps for its owner alone", async () => {
    await asMember()
    const sam = await add('Sam')
    const theirs = await q.createGoal({ memberId: sam.id, title: 'Private' })
    const [hidden] = await q.addGoalSteps(theirs.id, ['Secret step'])
    const mine = await q.createGoal({ memberId: ada.id, title: 'Mine' })
    const [own] = await q.addGoalSteps(mine.id, ['My step'])

    expect(await (await post({ action: 'toggle_goal_step', id: own.id, done: true })).json()).toEqual({ ok: true, done: true })
    expect((await q.getGoalStep(own.id))!.done).toBe(true)
    expect((await post({ action: 'toggle_goal_step', id: hidden.id, done: true })).status).toBe(404)
    expect((await q.getGoalStep(hidden.id))!.done).toBe(false)
    expect((await post({ action: 'toggle_goal_step', id: 999, done: true })).status).toBe(404)
  })

  it("closes a goal as done or dropped, once, ending its check-ins, and leaves another member's alone", async () => {
    await asMember()
    const sam = await add('Sam')
    const check = await job(ada.id, { label: 'Goal check-in: Trip', cronExpr: '0 19 * * 0' })
    const trip = await q.createGoal({ memberId: ada.id, title: 'Trip' })
    await q.updateGoal(trip.id, { automationId: check.id })
    const theirs = await q.createGoal({ memberId: sam.id, title: 'Private' })
    const mine = await q.createGoal({ memberId: ada.id, title: 'Mine' })

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

  describe("the signed-in member's own linked accounts", () => {
    beforeEach(async () => {
      await asMember()
      await q.saveConnection({ memberId: ada.id, provider: 'google', email: 'ada@gmail.example', refreshToken: 'r', scopes: null })
    })

    it('are made read only, and writable again', async () => {
      expect(await (await post({ action: 'set_read_only', provider: 'google', readOnly: true })).json()).toEqual({ ok: true, readOnly: true })
      expect((await q.connectionFor(ada.id, 'google'))!.readOnly).toBe(true)
      expect(await (await post({ action: 'set_read_only', provider: 'google', readOnly: false })).json()).toEqual({ ok: true, readOnly: false })
      expect((await q.connectionFor(ada.id, 'google'))!.readOnly).toBe(false)
    })

    it('are unlinked', async () => {
      expect(await (await post({ action: 'unlink_account', provider: 'google' })).json()).toEqual({ ok: true, unlinked: 'google' })
      expect(await q.connectionFor(ada.id, 'google')).toBeUndefined()
    })

    it("never reach another member's", async () => {
      const sam = await add('Sam')
      await q.saveConnection({ memberId: sam.id, provider: 'microsoft', email: 'sam@outlook.example', refreshToken: 'r', scopes: null })
      const res = await post({ action: 'set_read_only', provider: 'microsoft', readOnly: true })
      expect(res.status).toBe(404)
      expect((await res.json()).error).toContain('No microsoft account of yours')
      await post({ action: 'unlink_account', provider: 'microsoft' })
      expect(await q.connectionFor(sam.id, 'microsoft')).toMatchObject({ readOnly: false })
    })

    it('need to be named as one Hearth knows', async () => {
      expect((await post({ action: 'set_read_only', provider: 'yahoo', readOnly: true })).status).toBe(400)
      expect((await post({ action: 'unlink_account' })).status).toBe(400)
    })

    it('are only a family member\'s to change', async () => {
      process.env.ADMIN_EMAILS = 'boss@hearth.example'
      await createSession({ email: 'boss@hearth.example', name: 'Boss', provider: 'google', role: 'admin' })
      const res = await post({ action: 'unlink_account', provider: 'google' })
      expect(res.status).toBe(403)
      expect(await q.connectionFor(ada.id, 'google')).toBeDefined()
    })
  })

  it('lists the helpers on Home, and lets any member let one go', async () => {
    await asMember()
    const chef = (await q.addHelper({ name: 'Chef', role: 'Plans meals. Keeps to allergies.', createdBy: null }))!
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

  it('turns away a cookie whose member has since been revoked, or was never recognised', async () => {
    await asMember()
    await q.saveMember({ id: ada.id, name: 'Ada', email: ada.email, allowed: false, isAdmin: false })
    expect((await post({ action: 'add_item', list: 'shopping', content: 'milk' })).status).toBe(401)

    await createSession({ email: 'stranger@else.example', name: 'S', provider: 'google', role: 'admin' })
    expect((await post({ action: 'add_item', list: 'shopping', content: 'milk' })).status).toBe(401)
  })
})
