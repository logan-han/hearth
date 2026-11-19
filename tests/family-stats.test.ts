import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { gatherFamilyStats, gatherStats, readableLine } from '@/lib/stats'
import { formatLocalDate } from '@/lib/cron'

let client: PGlite
beforeEach(async () => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

const ID = 'microsoft:AQMkADAwATY3ZmYAZS04MWZkLTEyY2UtMDACLTAwCgBGAAADOnrpfBGf8UG1TdWDYew9mQcAnDRj4NeJRUKNigAOR4'
const add = (name: string) => q.saveMember({ name, email: `${name.toLowerCase()}@hearth.example`, allowed: true, isAdmin: false })

describe('what Home shows the family', () => {
  it('describes a proposal by its first readable line, never by a bare message id, with whose it was', async () => {
    const ada = await add('Ada')
    const soon = new Date(Date.now() + 7 * 86_400_000)
    const later = new Date(soon.getTime() + 86_400_000)
    await q.addProposal({
      memberId: ada.id, title: 'Wild Bunch Match', location: 'Range 3, SSPC',
      description: `Source: ${ID}\nRound 4 of the season, bring water.`,
      startsAt: soon, endsAt: new Date(soon.getTime() + 3600_000), source: `${ID}/2026-09-20`,
    })
    await q.addProposal({
      title: 'Term Four starts', description: ID, allDay: true,
      startsAt: later, endsAt: new Date(later.getTime() + 86_400_000), source: `${ID}/2026-10-05`,
    })
    const stats = await gatherFamilyStats()
    expect(stats.proposals.map((p) => [p.title, p.detail, p.who])).toEqual([
      ['Wild Bunch Match', 'Range 3, SSPC · Round 4 of the season, bring water.', 'Ada'],
      ['Term Four starts', '', null],
    ])
  })

  it('lists what is remembered, newest first with who asked, and the questions still open', async () => {
    const ada = await add('Ada')
    await q.addMemory('bin night is Monday', ada.id)
    await q.addMemory('milk allergy', null)
    const gone = await q.addMemory('gone', null)
    await q.deleteMemory(gone.id)
    await q.askQuestion({ question: 'Who attends Hillside Grammar?', candidate: 'Juno attends Hillside Grammar' })
    const settled = await q.askQuestion({ question: 'Does anyone attend Riverbend College?', candidate: 'Someone attends Riverbend College' })
    await q.answerQuestion(settled.row.id, null)

    const stats = await gatherFamilyStats()
    expect(stats.memories.map((m) => [m.fact, m.who])).toEqual([['milk allergy', null], ['bin night is Monday', 'Ada']])
    expect(stats.memories[0].since).toMatch(/\d{4}$/)
    expect(stats.questions.map((qn) => [qn.question, qn.candidate])).toEqual([['Who attends Hillside Grammar?', 'Juno attends Hillside Grammar']])
  })

  it("lists the viewer's own reminders, saying which run once or until something happens, and nobody else's", async () => {
    const ada = await add('Ada')
    const sam = await add('Sam')
    await q.addAutomation({ memberId: ada.id, label: 'bins', cronExpr: '0 19 * * 1', instruction: 'x', nextRunAt: new Date('2026-09-21T09:00:00Z') })
    await q.addAutomation({ memberId: ada.id, label: 'plumber', cronExpr: '0 17 22 9 *', instruction: 'x', repeat: 'once', nextRunAt: new Date('2026-09-22T07:00:00Z') })
    await q.addAutomation({ memberId: ada.id, label: 'camp dates', cronExpr: '0 8-20 * * *', instruction: 'x', repeat: 'until', nextRunAt: new Date('2026-09-23T22:00:00Z') })
    await q.addAutomation({ memberId: sam.id, label: 'his', cronExpr: '0 7 * * *', instruction: 'x', nextRunAt: new Date('2026-09-16T21:00:00Z') })

    expect((await gatherFamilyStats(undefined, ada.id)).automations.map((a) => [a.label, a.repeat])).toEqual([
      ['bins', null],
      ['plumber', 'once'],
      ['camp dates', 'until'],
    ])
    expect((await gatherFamilyStats()).automations).toEqual([])
  })

  it("lists the viewer's own goals with their steps and latest progress, and nobody else's", async () => {
    const ada = await add('Ada')
    const sam = await add('Sam')
    const trip = await q.createGoal({ memberId: ada.id, title: 'Bali trip', outcome: '$6,000 saved', targetDate: '2030-03-01' })
    const [flights] = await q.addGoalSteps(trip.id, ['Book flights', 'Pack'])
    await q.setGoalStepDone(flights.id, true)
    await q.addGoalUpdate(trip.id, 'Another $400 in', ada.id)
    await q.createGoal({ memberId: ada.id, title: 'Someday' })
    await q.createGoal({ memberId: sam.id, title: 'Sell the car' })
    const done = await q.createGoal({ memberId: ada.id, title: 'Finished' })
    await q.closeGoal(done.id, 'done')

    const { goals } = await gatherFamilyStats(undefined, ada.id)
    expect(goals.map((g) => g.title)).toEqual(['Bali trip', 'Someday'])
    expect(goals[0]).toMatchObject({
      outcome: '$6,000 saved', done: 1, latest: 'Another $400 in',
      steps: [{ content: 'Book flights', done: true }, { content: 'Pack', done: false }],
    })
    expect(goals[0].target).toBe(formatLocalDate(new Date('2030-02-28T13:00:00Z')))
    expect(goals[0].daysLeft).toBeGreaterThan(1000)
    expect(goals[1]).toMatchObject({ outcome: null, target: null, daysLeft: null, steps: [], latest: null })
    expect((await gatherFamilyStats(undefined, sam.id)).goals.map((g) => g.title)).toEqual(['Sell the car'])
  })

  it("lists what was changed in the viewer's name, saying how, and nobody else's", async () => {
    const ada = await add('Ada')
    const sam = await add('Sam')
    await q.recordActivity({ memberId: ada.id, via: 'mcp', tool: 'add_to_list', summary: 'added milk to the shopping list' })
    await q.recordActivity({ memberId: ada.id, via: 'web', tool: 'send_email', summary: 'sent the email' })
    await q.recordActivity({ memberId: ada.id, via: 'watcher', tool: 'propose_family_event', summary: 'proposed the carnival' })
    await q.recordActivity({ memberId: sam.id, via: 'mcp', tool: 'add_to_list', summary: 'his change' })

    const { activity } = await gatherFamilyStats(undefined, ada.id)
    expect(activity.map((a) => [a.summary, a.how])).toEqual([
      ['proposed the carnival', 'by a scheduled job'],
      ['sent the email', 'on Home'],
      ['added milk to the shopping list', 'through an MCP client'],
    ])
    expect(activity[0].when).toEqual(expect.any(String))
  })

  it("lists the viewer's own reports, newest first, held and problem ones marked, and nobody else's", async () => {
    const ada = await add('Ada')
    const sam = await add('Sam')
    await q.addReport({ memberId: ada.id, automationId: null, label: 'Camp dates', status: 'ready', body: 'The camp is 3 to 5 March.', helper: 'Researcher' })
    await q.addReport({ memberId: ada.id, automationId: null, label: 'Bills', status: 'held', body: 'Draft', detail: 'Held back: a figure was invented.' })
    await q.addReport({ memberId: sam.id, automationId: null, label: 'His', status: 'ready', body: 'Not hers' })

    const { reports } = await gatherFamilyStats(undefined, ada.id)
    expect(reports).toEqual([
      { id: expect.any(Number), label: 'Bills', helper: null, status: 'held', body: 'Draft', detail: 'Held back: a figure was invented.', when: expect.any(String) },
      { id: expect.any(Number), label: 'Camp dates', helper: 'Researcher', status: 'ready', body: 'The camp is 3 to 5 March.', detail: null, when: expect.any(String) },
    ])
    expect((await gatherFamilyStats()).reports).toEqual([])
  })

  it("lists the viewer's own MCP keys, never the keys themselves", async () => {
    const ada = await add('Ada')
    const sam = await add('Sam')
    const laptop = await q.issueMcpKey(ada.id, 'Laptop')
    const phone = await q.issueMcpKey(ada.id, 'Phone')
    await q.issueMcpKey(sam.id, 'His')
    await q.memberByMcpKey(laptop.key)

    const { keys } = await gatherFamilyStats(undefined, ada.id)
    expect(keys.map((k) => k.label)).toEqual(['Phone', 'Laptop'])
    expect(keys[0]).toEqual({ id: phone.row.id, label: 'Phone', created: formatLocalDate(phone.row.createdAt), lastUsed: null })
    expect(keys[1].lastUsed).toEqual(expect.any(String))
    expect(JSON.stringify(keys)).not.toContain(laptop.key)
  })
})

describe("Home's month", () => {
  it('puts an event that runs past the end of the month on each of its days in it, and no further', async () => {
    // 29 September to 3 October, all day.
    await q.addFamilyEvent({ title: 'Spring camp', startsAt: new Date('2026-09-28T14:00:00Z'), endsAt: new Date('2026-10-03T14:00:00Z'), allDay: true })
    const { calendar } = await gatherFamilyStats('2026-09')
    const camp = calendar.days.filter((d) => d.events.some((e) => e.title === 'Spring camp')).map((d) => d.date)
    expect(camp).toEqual(['2026-09-29', '2026-09-30'])
  })
})

describe("Home's word on the scheduler", () => {
  it('says when reminders can fire once the ticks show the grid, and nothing before', async () => {
    expect((await gatherFamilyStats()).scheduler).toBeNull()
    const hour = Math.floor(Date.now() / 3600_000) * 3600_000
    await q.recordTick(new Date(hour - 3600_000))
    await q.recordTick(new Date(hour))
    expect((await gatherFamilyStats()).scheduler).toBe('hourly, on the hour')
  })

  it('still renders when the scheduler pulse cannot be read', async () => {
    await client.query('drop table settings')
    const stats = await gatherFamilyStats()
    expect(stats.scheduler).toBeNull()
    expect(stats.lists).toEqual([])
  })
})

describe('how much Home and System carry', () => {
  it('shows every open item but only the latest ticked ones, and counts them all', async () => {
    const list = await q.findOrCreateList('shopping')
    const items = await q.addListItems(list.id, Array.from({ length: 15 }, (_, i) => `ticked ${i + 1}`))
    for (const i of items) await q.setListItemDone(i.id, true)
    await q.addListItems(list.id, ['milk', 'bread'])
    await q.findOrCreateList('camping')

    const { lists } = await gatherFamilyStats()
    const shopping = lists.find((l) => l.name === 'shopping')!
    expect(shopping).toMatchObject({ id: list.id, open: 2, ticked: 15, total: 17 })
    expect(shopping.items.filter((i) => !i.done).map((i) => i.content)).toEqual(['milk', 'bread'])
    // The newest ten of the fifteen, still in the order they were added.
    expect(shopping.items.filter((i) => i.done).map((i) => i.content)).toEqual(
      Array.from({ length: 10 }, (_, i) => `ticked ${i + 6}`),
    )
    // A list with nothing on it is still a list to add to.
    expect(lists.find((l) => l.name === 'camping')).toMatchObject({ open: 0, ticked: 0, items: [] })
  })

  it("lists every one of the viewer's reminders on Home, the paused ones that sort last included, and every member's on System", async () => {
    const ada = await add('Ada')
    const made = []
    for (let i = 1; i <= 11; i++) {
      made.push(await q.addAutomation({
        memberId: ada.id, label: `reminder ${i}`, cronExpr: '0 7 * * *', instruction: 'x',
        nextRunAt: new Date(Date.UTC(2030, 0, i)),
      }))
    }
    const paused = made[0]
    await q.setAutomationEnabled(paused.id, false)

    const home = (await gatherFamilyStats(undefined, ada.id)).automations
    expect(home).toHaveLength(11)
    expect(home.at(-1)).toMatchObject({ id: paused.id, label: 'reminder 1', enabled: false })

    const system = (await gatherStats()).automations
    expect(system).toHaveLength(11)
    expect(system.at(-1)).toMatchObject({ id: paused.id, label: 'reminder 1', cron: '0 7 * * *', enabled: false, lastRun: null, owner: 'Ada' })
  })
})

describe('readableLine', () => {
  it('passes over ids, links and labelled ids, and keeps words', () => {
    expect(readableLine(`Source: ${ID}\nBring water`)).toBe('Bring water')
    expect(readableLine('https://example.org/notice/2026\nSee the attached notice')).toBe('See the attached notice')
    expect(readableLine('google:18f2ab')).toBeNull()
    expect(readableLine('Cancelled')).toBe('Cancelled')
    expect(readableLine('From the school newsletter: photo day is Friday')).toBe('From the school newsletter: photo day is Friday')
    expect(readableLine('  \n\n')).toBeNull()
    expect(readableLine(null)).toBeNull()
    expect(readableLine('x'.repeat(200))).toBeNull()
    expect(readableLine(`${'word '.repeat(40)}end`)).toHaveLength(140)
  })
})
