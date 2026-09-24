import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { gatherFamilyStats, gatherStats, readableLine } from '@/lib/stats'
import { recordModelEvent } from '@/lib/model-events'

let client: PGlite
beforeEach(async () => {
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

const ID = 'microsoft:AQMkADAwATY3ZmYAZS04MWZkLTEyY2UtMDACLTAwCgBGAAADOnrpfBGf8UG1TdWDYew9mQcAnDRj4NeJRUKNigAOR4'

describe('what Home shows the family', () => {
  it('describes a proposal by its first readable line, never by a bare message id', async () => {
    const soon = new Date(Date.now() + 7 * 86_400_000)
    const later = new Date(soon.getTime() + 86_400_000)
    await q.addProposal({
      chatId: '-100', title: 'Wild Bunch Match', location: 'Range 3, SSPC',
      description: `Source: ${ID}\nRound 4 of the season, bring water.`,
      startsAt: soon, endsAt: new Date(soon.getTime() + 3600_000), source: `${ID}/2026-09-20`,
    })
    await q.addProposal({
      chatId: '-100', title: 'Term Four starts', description: ID, allDay: true,
      startsAt: later, endsAt: new Date(later.getTime() + 86_400_000), source: `${ID}/2026-10-05`,
    })
    const stats = await gatherFamilyStats()
    expect(stats.proposals.map((p) => [p.title, p.detail])).toEqual([
      ['Wild Bunch Match', 'Range 3, SSPC · Round 4 of the season, bring water.'],
      ['Term Four starts', ''],
    ])
  })

  it('lists what is remembered, newest first with who asked, and marks the built-in watchers', async () => {
    const ada = await q.upsertMember('111', 'Ada', { allowed: true })
    await q.addMemory('bin night is Monday', ada.id)
    await q.addMemory('milk allergy', null)
    const gone = await q.addMemory('gone', null)
    await q.deleteMemory(gone.id)
    await q.addAutomation({
      chatId: '-100', label: 'Morning brief', cronExpr: '0 7 * * *', instruction: 'x', kind: 'morning',
      nextRunAt: new Date('2026-09-16T21:00:00Z'),
    })
    await q.addAutomation({
      chatId: '-100', label: 'bins', cronExpr: '0 19 * * 1', instruction: 'x',
      nextRunAt: new Date('2026-09-21T09:00:00Z'),
    })

    await q.askQuestion({ question: 'Who attends Hillside Grammar?', candidate: 'Juno attends Hillside Grammar' })
    const settled = await q.askQuestion({ question: 'Does anyone attend Riverbend College?', candidate: 'Someone attends Riverbend College' })
    await q.answerQuestion(settled.row.id, null)

    const stats = await gatherFamilyStats()
    expect(stats.memories.map((m) => [m.fact, m.who])).toEqual([['milk allergy', null], ['bin night is Monday', 'Ada']])
    expect(stats.memories[0].since).toMatch(/\d{4}$/)
    expect(stats.questions.map((qn) => [qn.question, qn.candidate])).toEqual([['Who attends Hillside Grammar?', 'Juno attends Hillside Grammar']])
    expect(stats.automations.map((a) => [a.label, a.builtin])).toEqual([['Morning brief', true], ['bins', false]])
  })
})

describe('what System shows', () => {
  it("says which model answered from the chain's own month of record, not from the talk it keeps", async () => {
    await recordModelEvent({ slot: 'gemini:flash', purpose: 'hearth.chat', outcome: 'answered' })
    await recordModelEvent({ slot: 'gemini:flash', purpose: 'hearth.watcher', outcome: 'answered' })
    await recordModelEvent({ slot: 'openrouter:free', purpose: 'hearth.chat', outcome: 'answered' })
    // Three weeks back: older than the history keeps, well inside the thirty days shown.
    await client.query(`update model_events set created_at = now() - interval '21 days' where slot = 'openrouter:free'`)
    await recordModelEvent({ slot: 'openrouter:free', purpose: 'hearth.chat', outcome: 'failed', error: '429' })
    await recordModelEvent({ slot: 'jev:jev-latest', purpose: 'hearth.gate', outcome: 'answered' })
    await recordModelEvent({ slot: 'gemini:flash', purpose: 'hearth.summary', outcome: 'answered' })
    const stats = await gatherStats()
    expect(stats.models).toEqual([{ model: 'gemini:flash', count: 2 }, { model: 'openrouter:free', count: 1 }])
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

  it('lists every reminder, the paused ones that sort last included, on Home and on System', async () => {
    const made = []
    for (let i = 1; i <= 11; i++) {
      made.push(await q.addAutomation({
        chatId: '-100', label: `reminder ${i}`, cronExpr: '0 7 * * *', instruction: 'x',
        nextRunAt: new Date(Date.UTC(2030, 0, i)),
      }))
    }
    const paused = made[0]
    await q.setAutomationEnabled(paused.id, false)

    const home = (await gatherFamilyStats()).automations
    expect(home).toHaveLength(11)
    expect(home.at(-1)).toMatchObject({ id: paused.id, label: 'reminder 1', enabled: false })

    const system = (await gatherStats()).automations
    expect(system).toHaveLength(11)
    expect(system.at(-1)).toMatchObject({ id: paused.id, label: 'reminder 1', cron: '0 7 * * *', enabled: false, lastRun: null })
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
