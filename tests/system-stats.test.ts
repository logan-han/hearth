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
const INTEGRATION_KEYS = ['POCKETSMITH_DEVELOPER_KEY', 'NOTION_TOKEN', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'OPENWEATHER_API_KEY', 'TAVILY_API_KEY', 'QSTASH_CURRENT_SIGNING_KEY']

const add = (name: string, extra: Partial<{ email: string | null; allowed: boolean; isAdmin: boolean }> = {}) =>
  q.saveMember({ name, email: extra.email === undefined ? `${name.toLowerCase()}@hearth.example` : extra.email, allowed: extra.allowed ?? true, isAdmin: extra.isAdmin ?? false })

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
    const rowan = await add('Rowan', { isAdmin: true })
    await add('Ada', { email: null })
    await add('Sam', { email: null, allowed: false, isAdmin: true })
    await q.saveConnection({ memberId: rowan.id, provider: 'google', email: 'rowan@hearth.example', refreshToken: 'r', scopes: null })
    await q.issueMcpKey(rowan.id, 'Laptop')
    await q.issueMcpKey(rowan.id, 'Phone')
    const soon = new Date(Date.now() + DAY)
    await q.addFamilyEvent({ title: 'Swimming', startsAt: soon, endsAt: new Date(soon.getTime() + HOUR) })
    const called = await q.addFamilyEvent({ title: 'Called off', startsAt: soon, endsAt: new Date(soon.getTime() + HOUR) })
    await q.cancelFamilyEvent(called.id)
    await q.addMemory('bin night is Monday', null)
    await q.deleteMemory((await q.addMemory('gone', null)).id)
    await q.addProposal({ title: 'Working bee', startsAt: soon, endsAt: new Date(soon.getTime() + HOUR) })
    const draft = { memberId: rowan.id, provider: 'google', to: ['a@b.com'], subject: 's', body: 'b' }
    await q.createDraft(draft)
    await q.markDraft((await q.createDraft(draft)).id, 'sent')

    const stats = await gatherStats()
    expect(stats.totals).toEqual({ members: 2, admins: 1, connections: 1, keys: 2, events: 1, memories: 1, proposals: 1, drafts: 1, sent: 1 })
    expect(stats.timezone).toBe('Australia/Melbourne')
  })

  it('counts a proposal as still open exactly when the query layer does', async () => {
    const soon = new Date(Date.now() + DAY)
    const later = new Date(Date.now() + 2 * DAY)
    const past = new Date(Date.now() - DAY)
    const hour = (at: Date) => new Date(at.getTime() + HOUR)
    await q.addProposal({ title: 'Working bee', startsAt: soon, endsAt: hour(soon) })
    // The same title on another day is another occasion, and leaves the question open.
    await q.addFamilyEvent({ title: 'Working bee', startsAt: later, endsAt: hour(later) })
    await q.addProposal({ title: 'Last week', startsAt: past, endsAt: hour(past) })
    // On the calendar already, under a title that differs only in case and spacing.
    await q.addFamilyEvent({ title: 'school fete', startsAt: soon, endsAt: hour(soon) })
    await q.addProposal({ title: '  School Fete ', startsAt: soon, endsAt: hour(soon) })
    // A cancelled event does not answer the question.
    const off = await q.addFamilyEvent({ title: 'Book club', startsAt: soon, endsAt: hour(soon) })
    await q.cancelFamilyEvent(off.id)
    await q.addProposal({ title: 'Book club', startsAt: soon, endsAt: hour(soon) })
    const answered = await q.addProposal({ title: 'Picnic', startsAt: soon, endsAt: hour(soon) })
    await db().execute(sql`update event_proposals set status = 'accepted' where id = ${answered.id}`)

    const live = (await q.pendingProposals()).map((p) => p.title)
    expect(live).toEqual(['Working bee', 'Book club'])
    expect((await gatherStats()).totals.proposals).toBe(live.length)
    expect((await gatherFamilyStats()).proposals.map((p) => p.title)).toEqual(live)
  })

  it('shows the fortnight of changes by how they were asked for, with quiet days as zeroes', async () => {
    const rowan = await add('Rowan')
    for (const via of ['mcp', 'mcp', 'web', 'watcher']) {
      await q.recordActivity({ memberId: rowan.id, via, tool: 'add_to_list', summary: 'added milk' })
    }
    // Too old for the fortnight.
    await q.recordActivity({ memberId: rowan.id, via: 'mcp', tool: 'add_to_list', summary: 'long ago' })
    await db().execute(sql`update activity set created_at = now() - interval '40 days' where summary = 'long ago'`)

    const stats = await gatherStats()
    expect(stats.activity).toHaveLength(14)
    expect(stats.activity.at(-1)).toEqual({ day: localDateKey(new Date()), mcp: 2, web: 1, scheduled: 1 })
    expect(stats.activity.slice(0, -1).every((d) => d.mcp + d.web + d.scheduled === 0)).toBe(true)
  })

  it('shares out the scheduled runs by the model that ran them, over the month', async () => {
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.watcher', outcome: 'answered' })
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.watcher', outcome: 'answered' })
    await recordModelEvent({ slot: 'openrouter:free', purpose: 'hearth.watcher', outcome: 'answered' })
    // A slot that failed, and a check rather than a run, say nothing about who ran the jobs.
    await recordModelEvent({ slot: 'groq:llama', purpose: 'hearth.watcher', outcome: 'failed', error: '429' })
    await recordModelEvent({ slot: 'groq:llama', purpose: 'hearth.decision', outcome: 'answered' })
    // Older than the month.
    await recordModelEvent({ slot: 'openrouter:old', purpose: 'hearth.watcher', outcome: 'answered' })
    await db().execute(sql`update model_events set created_at = now() - interval '40 days' where slot = 'openrouter:old'`)

    expect((await gatherStats()).models).toEqual([
      { model: 'gemini:gemini-flash', count: 2 },
      { model: 'openrouter:free', count: 1 },
    ])
  })

  it('lists every MCP key with its member and when it was last used, the live ones first, never the key itself', async () => {
    const rowan = await add('Rowan')
    const ada = await add('Ada')
    const idle = await q.issueMcpKey(rowan.id, 'Old laptop')
    const live = await q.issueMcpKey(ada.id, 'Claude Desktop')
    await q.memberByMcpKey(live.key)

    const { keys } = await gatherStats()
    expect(keys.map((k) => [k.label, k.member])).toEqual([['Claude Desktop', 'Ada'], ['Old laptop', 'Rowan']])
    expect(keys[0].lastUsed).toEqual(expect.any(String))
    expect(keys[1]).toMatchObject({ id: idle.row.id, lastUsed: null, created: formatLocalDate(idle.row.createdAt) })
    expect(JSON.stringify(keys)).not.toContain(live.key)
  })

  it('says whose each reminder is, when it is due, and when an off-grid one will really run once the ticks show the grid', async () => {
    const rowan = await add('Rowan')
    const hour = Math.floor(Date.now() / HOUR) * HOUR
    const due = new Date(hour + 2 * HOUR + 30 * 60_000)
    const bins = await q.addAutomation({ memberId: rowan.id, label: 'bins', cronExpr: '30 19 * * 1', instruction: 'x', nextRunAt: due })
    await db().execute(sql`update automations set last_run_at = ${new Date(hour - DAY)} where id = ${bins.id}`)
    const paused = await q.addAutomation({ memberId: null, label: 'paused', cronExpr: '0 7 * * *', instruction: 'x', nextRunAt: due })
    await q.setAutomationEnabled(paused.id, false)

    let stats = await gatherStats()
    expect(stats.scheduler).toMatchObject({ lastTick: null, stale: true, grid: null })
    expect(stats.automations).toEqual([
      expect.objectContaining({ label: 'bins', owner: 'Rowan', enabled: true, nextRun: formatLocal(due), offGrid: false, runsAt: null, lastRun: formatLocal(new Date(hour - DAY)) }),
      expect.objectContaining({ label: 'paused', owner: null, enabled: false, nextRun: null, offGrid: false, runsAt: null, lastRun: null }),
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
    process.env.POCKETSMITH_DEVELOPER_KEY = 'ps'
    process.env.TAVILY_API_KEY = 'tv'
    const stats = await gatherStats()
    const on = Object.fromEntries(stats.connected.flatMap((g) => g.items.map((i) => [i.name, i.on])))
    expect(on).toMatchObject({ PocketSmith: true, Tavily: true, Jira: false, Notion: false, OpenWeatherMap: false, QStash: false })
    expect(stats.chain.find((t) => t.name === 'gemini')).toMatchObject({ configured: true, models: ['gemini-flash'] })
  })

  it('reports how the chain has fared, and still renders when the diagnostics cannot be read', async () => {
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.watcher', outcome: 'answered', ms: 900 })
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
