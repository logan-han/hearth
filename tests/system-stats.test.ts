import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { freshDb, closeDb } from './helpers/db'
import { db } from '@/lib/db'
import * as q from '@/lib/db/queries'
import { recordModelEvent } from '@/lib/model-events'
import { formatLocal, formatLocalDate, localDateKey } from '@/lib/cron'
import { gatherStats, gatherFamilyStats } from '@/lib/stats'

/**
 * gatherStats is what System and Settings are built from, and it is raw SQL
 * throughout: the compiler cannot see a renamed column in there, so these run
 * every one of its queries against the migrated schema.
 */

let client: PGlite

const HOUR = 3600_000
const DAY = 24 * HOUR
const INTEGRATION_KEYS = ['UP_API_TOKEN', 'POCKETSMITH_DEVELOPER_KEY', 'NOTION_TOKEN', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'OPENWEATHER_API_KEY', 'TYPESAFE_API_KEY', 'TAVILY_API_KEY', 'QSTASH_CURRENT_SIGNING_KEY']

beforeEach(async () => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.TIMEZONE = 'Australia/Melbourne'
  process.env.GEMINI_API_KEY = 'k'
  process.env.GEMINI_MODEL = 'gemini-flash'
  for (const k of INTEGRATION_KEYS) delete process.env[k]
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('what System and Settings show an admin', () => {
  it('counts the household from every table it reads', async () => {
    const rowan = await q.saveMember({ telegramUserId: '111', name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: true })
    await q.saveMember({ telegramUserId: '222', name: 'Ada', email: null, allowed: true, isAdmin: false })
    await q.saveMember({ telegramUserId: '333', name: 'Sam', email: null, allowed: false, isAdmin: true })
    await q.saveConnection({ memberId: rowan.id, provider: 'google', email: 'rowan@hearth.example', refreshToken: 'r', scopes: null })
    await q.recordMessage({ chatId: '-100', role: 'user', content: 'hi' })
    await q.recordMessage({ chatId: '-100', role: 'assistant', content: 'hello' })
    const soon = new Date(Date.now() + DAY)
    await q.addFamilyEvent({ title: 'Swimming', startsAt: soon, endsAt: new Date(soon.getTime() + HOUR) })
    const called = await q.addFamilyEvent({ title: 'Called off', startsAt: soon, endsAt: new Date(soon.getTime() + HOUR) })
    await q.cancelFamilyEvent(called.id)
    await q.addMemory('bin night is Monday', null)
    await q.deleteMemory((await q.addMemory('gone', null)).id)
    await q.addProposal({ chatId: '-100', title: 'Working bee', startsAt: soon, endsAt: new Date(soon.getTime() + HOUR) })
    const draft = { chatId: '-100', memberId: rowan.id, provider: 'google', to: ['a@b.com'], subject: 's', body: 'b' }
    await q.createDraft(draft)
    await q.markDraft((await q.createDraft(draft)).id, 'sent')

    const stats = await gatherStats()
    expect(stats.totals).toEqual({ members: 2, admins: 1, connections: 1, messages: 2, events: 1, memories: 1, proposals: 1, drafts: 1, sent: 1 })
    expect(stats.timezone).toBe('Australia/Melbourne')
  })

  it('counts a proposal as still open exactly when the query layer does', async () => {
    const soon = new Date(Date.now() + DAY)
    const later = new Date(Date.now() + 2 * DAY)
    const past = new Date(Date.now() - DAY)
    const hour = (at: Date) => new Date(at.getTime() + HOUR)
    await q.addProposal({ chatId: '-100', title: 'Working bee', startsAt: soon, endsAt: hour(soon) })
    // The same title on another day is another occasion, and leaves the question open.
    await q.addFamilyEvent({ title: 'Working bee', startsAt: later, endsAt: hour(later) })
    await q.addProposal({ chatId: '-100', title: 'Last week', startsAt: past, endsAt: hour(past) })
    // On the calendar already, under a title that differs only in case and spacing.
    await q.addFamilyEvent({ title: 'school fete', startsAt: soon, endsAt: hour(soon) })
    await q.addProposal({ chatId: '-100', title: '  School Fete ', startsAt: soon, endsAt: hour(soon) })
    // A cancelled event does not answer the question.
    const off = await q.addFamilyEvent({ title: 'Book club', startsAt: soon, endsAt: hour(soon) })
    await q.cancelFamilyEvent(off.id)
    await q.addProposal({ chatId: '-100', title: 'Book club', startsAt: soon, endsAt: hour(soon) })
    const answered = await q.addProposal({ chatId: '-100', title: 'Picnic', startsAt: soon, endsAt: hour(soon) })
    await db().execute(sql`update event_proposals set status = 'accepted' where id = ${answered.id}`)

    const live = (await q.pendingProposals()).map((p) => p.title)
    expect(live).toEqual(['Working bee', 'Book club'])
    expect((await gatherStats()).totals.proposals).toBe(live.length)
    expect((await gatherFamilyStats()).proposals.map((p) => p.title)).toEqual(live)
  })

  it('shows the fortnight with quiet days as zeroes, and which model answered', async () => {
    await q.recordMessage({ chatId: '-100', role: 'user', content: 'hi' })
    await q.recordMessage({ chatId: '-100', role: 'assistant', content: 'hello', model: 'gemini:gemini-flash' })
    await q.recordMessage({ chatId: '-100', role: 'assistant', content: 'hello again' })
    // Too old for the fortnight.
    const old = await q.recordMessage({ chatId: '-100', role: 'assistant', content: 'long ago', model: 'openrouter:old' })
    await db().execute(sql`update messages set created_at = now() - interval '40 days' where id = ${old}`)
    // The shares come from the chain's own record: chat replies and watcher runs that answered, over the month.
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.chat', outcome: 'answered' })
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.watcher', outcome: 'answered' })
    await recordModelEvent({ slot: 'openrouter:free', purpose: 'hearth.chat', outcome: 'answered' })
    // A slot that failed, and a call that was neither a reply nor a watcher run, say nothing about who answered.
    await recordModelEvent({ slot: 'groq:llama', purpose: 'hearth.chat', outcome: 'failed', error: '429' })
    await recordModelEvent({ slot: 'groq:llama', purpose: 'hearth.summary', outcome: 'answered' })
    // Older than the month.
    await recordModelEvent({ slot: 'openrouter:old', purpose: 'hearth.chat', outcome: 'answered' })
    await db().execute(sql`update model_events set created_at = now() - interval '40 days' where slot = 'openrouter:old'`)

    const stats = await gatherStats()
    expect(stats.activity).toHaveLength(14)
    expect(stats.activity.at(-1)).toEqual({ day: localDateKey(new Date()), asked: 1, answered: 2 })
    expect(stats.activity.slice(0, -1).every((d) => d.asked === 0 && d.answered === 0)).toBe(true)
    expect(stats.models).toEqual([
      { model: 'gemini:gemini-flash', count: 2 },
      { model: 'openrouter:free', count: 1 },
    ])
  })

  it('lists the rooms busiest first, a direct message by its person, with the strangers in each', async () => {
    await q.saveMember({ telegramUserId: '222', name: 'Ada', email: null, allowed: true, isAdmin: false })
    await q.rememberChat('-100', 'group', 'The Kitchen')
    await q.rememberChat('222', 'private', null)
    await q.rememberChat('-200', 'group', null)
    await q.noteStranger('-100', { id: '999', name: 'Unknown' })
    await q.recordMessage({ chatId: '-100', role: 'user', content: 'hi' })
    // A room whose stranger list cannot be read counts nobody, rather than breaking the page.
    await db().execute(sql`update chats set strangers = 'not json' where chat_id = '222'`)
    await db().execute(sql`update chats set strangers = '{}' where chat_id = '-200'`)

    const stats = await gatherStats()
    expect(stats.chats[0]).toEqual({ id: '-100', type: 'group', title: 'The Kitchen', person: null, messages: 1, strangers: 1 })
    expect(stats.chats.slice(1)).toEqual(
      expect.arrayContaining([
        { id: '222', type: 'private', title: null, person: 'Ada', messages: 0, strangers: 0 },
        { id: '-200', type: 'group', title: null, person: null, messages: 0, strangers: 0 },
      ]),
    )
  })

  it('says when each reminder is due, and when an off-grid one will really run once the ticks show the grid', async () => {
    const hour = Math.floor(Date.now() / HOUR) * HOUR
    const due = new Date(hour + 2 * HOUR + 30 * 60_000)
    const bins = await q.addAutomation({ chatId: '-100', label: 'bins', cronExpr: '30 19 * * 1', instruction: 'x', nextRunAt: due })
    await db().execute(sql`update automations set last_run_at = ${new Date(hour - DAY)} where id = ${bins.id}`)
    const paused = await q.addAutomation({ chatId: '-100', label: 'paused', cronExpr: '0 7 * * *', instruction: 'x', nextRunAt: due })
    await q.setAutomationEnabled(paused.id, false)

    let stats = await gatherStats()
    expect(stats.scheduler).toMatchObject({ lastTick: null, stale: true, grid: null })
    expect(stats.automations).toEqual([
      expect.objectContaining({ label: 'bins', enabled: true, nextRun: formatLocal(due), offGrid: false, runsAt: null, lastRun: formatLocal(new Date(hour - DAY)) }),
      expect.objectContaining({ label: 'paused', enabled: false, nextRun: null, offGrid: false, runsAt: null, lastRun: null }),
    ])

    await q.recordTick(new Date(hour - HOUR))
    await q.recordTick(new Date(hour))
    stats = await gatherStats()
    expect(stats.scheduler).toMatchObject({ everyMinutes: 60, grid: 'hourly, on the hour' })
    expect(stats.automations[0]).toMatchObject({ offGrid: true, runsAt: formatLocal(new Date(hour + 3 * HOUR)) })
  })

  it('shows the lists, what is coming up and the month asked for', async () => {
    const groceries = await q.findOrCreateList('groceries')
    const [milk] = await q.addListItems(groceries.id, ['milk', 'eggs'])
    await q.setListItemDone(milk.id, true)
    await q.findOrCreateList('hardware')
    const soon = new Date(Date.now() + DAY)
    const later = new Date(Date.now() + 2 * DAY)
    await q.addFamilyEvent({ title: 'Swimming', startsAt: soon, endsAt: new Date(soon.getTime() + HOUR) })
    await q.addFamilyEvent({ title: 'Term Four', startsAt: later, endsAt: new Date(later.getTime() + DAY), allDay: true })

    const stats = await gatherStats('2026-09')
    expect(stats.lists).toEqual([
      { name: 'groceries', open: 1, total: 2 },
      { name: 'hardware', open: 0, total: 0 },
    ])
    expect(stats.upcoming).toEqual([
      { title: 'Swimming', when: formatLocal(soon), allDay: false },
      { title: 'Term Four', when: formatLocalDate(later), allDay: true },
    ])
    expect(stats.calendar.key).toBe('2026-09')
    expect(stats.calendar.days).toHaveLength(42)
  })

  it('marks each integration by whether its key is set, and describes the chain', async () => {
    process.env.UP_API_TOKEN = 'up'
    process.env.TAVILY_API_KEY = 'tv'
    const stats = await gatherStats()
    const on = Object.fromEntries(stats.connected.flatMap((g) => g.items.map((i) => [i.name, i.on])))
    expect(on).toMatchObject({ 'Up Bank': true, Tavily: true, PocketSmith: false, Jira: false, Notion: false, Jev: false, OpenWeatherMap: false, QStash: false })
    expect(stats.chain.find((t) => t.name === 'gemini')).toMatchObject({ configured: true, models: ['gemini-flash'] })
  })

  it('reports how the chain has fared, and still renders when the diagnostics cannot be read', async () => {
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.chat', outcome: 'answered', ms: 900 })
    let stats = await gatherStats()
    expect(stats.chainHealth).toMatchObject({ calls: 1, slots: [{ slot: 'gemini:gemini-flash', answered: 1 }] })
    expect(stats.models).toEqual([{ model: 'gemini:gemini-flash', count: 1 }])

    await db().execute(sql`drop table model_events`)
    await db().execute(sql`drop table settings`)
    stats = await gatherStats()
    expect(stats.chainHealth).toBeNull()
    expect(stats.models).toEqual([])
    expect(stats.scheduler).toMatchObject({ lastTick: null, grid: null })
  })
})
