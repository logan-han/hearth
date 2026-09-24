import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { installBuiltins } from '@/lib/builtins'
import { WATCHERS, BUILTIN_WATCHERS, type Watcher } from '@/lib/watchers'

/** How many people Telegram counts in a room that the household cannot account for. */
const unaccountedIn = vi.hoisted(() => vi.fn(async (_chatId: string): Promise<number | null> => 0))
vi.mock('@/lib/headcount', () => ({ unaccountedIn }))

let client: PGlite
/** Tuesday 15 September 2026, 10:30am in Melbourne. */
const now = new Date('2026-09-15T00:30:00Z')

beforeEach(async () => {
  unaccountedIn.mockReset()
  unaccountedIn.mockResolvedValue(0)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('the built-in watchers', () => {
  it('are installed once in every household group, never in a DM or a room with a stranger in it', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await q.rememberChat('-200', 'supergroup', 'Cousins')
    await q.rememberChat('111', 'private', null)
    await q.noteStranger('-200', { id: '555', name: 'Someone' })

    const first = await installBuiltins(now)
    expect(first.installed).toEqual(['Morning brief in Family', 'Money snapshot in Family'])
    const rows = await q.listAutomations('-100')
    expect(rows.map((a) => a.kind).sort()).toEqual(['morning', 'snapshot'])
    expect(rows.every((a) => a.memberId === null && a.enabled)).toBe(true)
    expect(rows.find((a) => a.kind === 'morning')!.instruction).toContain('whose mailbox')
    expect(rows.find((a) => a.kind === 'morning')!.nextRunAt.toISOString()).toBe('2026-09-15T21:00:00.000Z')
    expect(await q.listAutomations('-200')).toHaveLength(0)
    expect(await q.listAutomations('111')).toHaveLength(0)

    const again = await installBuiltins(now)
    expect(again).toEqual({ installed: [], converted: 0, retired: 0, synced: 0 })
    expect(await q.listAutomations()).toHaveLength(2)
  })

  it('installs nothing where Telegram counts people the household cannot account for', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await q.rememberChat('-400', 'group', 'School parents')
    await q.rememberChat('-500', 'group', 'Gone')
    unaccountedIn.mockImplementation(async (chatId) => (chatId === '-100' ? 0 : chatId === '-400' ? 23 : null))

    const report = await installBuiltins(now)
    expect(report.installed).toEqual(['Morning brief in Family', 'Money snapshot in Family'])
    expect(await q.listAutomations('-400')).toHaveLength(0)
    expect(await q.listAutomations('-500')).toHaveLength(0)
    // Asked once per room, not once per watcher.
    expect(unaccountedIn.mock.calls.filter(([id]) => id === '-400')).toHaveLength(1)
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('23 people there are not recognised'))
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('an unknown number of people'))
  })

  it('passes every count it takes back to the caller, so an admin can be told why a room has none', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await q.rememberChat('-400', 'group', 'School parents')
    unaccountedIn.mockImplementation(async (chatId) => (chatId === '-100' ? 0 : 23))
    const counted = vi.fn(async () => {})
    await installBuiltins(now, { counted })
    expect(counted).toHaveBeenCalledTimes(2)
    expect(counted).toHaveBeenCalledWith(expect.objectContaining({ chatId: '-100', title: 'Family' }), 0)
    expect(counted).toHaveBeenCalledWith(expect.objectContaining({ chatId: '-400', title: 'School parents' }), 23)
  })

  it('does not ask Telegram about a room that already has its watchers', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await installBuiltins(now)
    unaccountedIn.mockClear()
    await installBuiltins(now)
    expect(unaccountedIn).not.toHaveBeenCalled()
  })

  it('falls back to the chat id when a group has no title', async () => {
    await q.rememberChat('-100', 'group', null)
    const report = await installBuiltins(now)
    expect(report.installed).toEqual(['Morning brief in -100', 'Money snapshot in -100'])
  })

  it('skips installing a watcher whose cron can never fire, rather than crashing', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    const impossible: Watcher = {
      kind: 'money', label: 'Impossible watcher', cron: '0 0 30 2 *', builtin: true, instruction: 'x', tools: [],
    }
    BUILTIN_WATCHERS.push(impossible)
    try {
      const report = await installBuiltins(now)
      expect(report.installed).toEqual(['Morning brief in Family', 'Money snapshot in Family'])
      expect((await q.listAutomations('-100')).map((a) => a.kind).sort()).toEqual(['morning', 'snapshot'])
    } finally {
      BUILTIN_WATCHERS.pop()
    }
  })

  it('leave a paused one paused', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await installBuiltins(now)
    const brief = (await q.listAutomations('-100')).find((a) => a.kind === 'morning')!
    await q.setAutomationEnabled(brief.id, false)
    await installBuiltins(now)
    expect((await q.getAutomation(brief.id))!.enabled).toBe(false)
    expect(await q.listAutomations('-100')).toHaveLength(2)
  })

  it('come back in step with their definitions, rescheduled only when the cron changed', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    const stale = await q.addAutomation({
      chatId: '-100', label: 'Morning brief', cronExpr: '0 7 * * 1-5', instruction: 'old words', kind: 'morning',
      nextRunAt: new Date('2026-09-16T21:00:00Z'),
    })
    const worded = await q.addAutomation({
      chatId: '-100', label: 'Weekly money', cronExpr: WATCHERS.snapshot.cron, instruction: 'old words', kind: 'snapshot',
      nextRunAt: new Date('2026-09-20T08:00:00Z'),
    })

    const report = await installBuiltins(now)
    expect(report.synced).toBe(2)
    const brief = (await q.getAutomation(stale.id))!
    expect(brief.cronExpr).toBe(WATCHERS.morning.cron)
    expect(brief.instruction).toContain('whose mailbox')
    // A daily brief from a Tuesday morning is next due Wednesday 7am, not Thursday.
    expect(brief.nextRunAt.toISOString()).toBe('2026-09-15T21:00:00.000Z')
    const snapshot = (await q.getAutomation(worded.id))!
    expect(snapshot.label).toBe('Money snapshot')
    expect(snapshot.nextRunAt.toISOString()).toBe('2026-09-20T08:00:00.000Z')
  })

  it('converts a legacy watcher that was paused without giving it a fresh run time', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    const legacy = await q.addAutomation({
      chatId: '-100', label: "Ada's inbox", cronExpr: '0 8 * * *', instruction: 'mail', kind: 'inbox',
      nextRunAt: new Date('2026-09-10T22:00:00Z'),
    })
    await q.setAutomationEnabled(legacy.id, false)
    await installBuiltins(now)
    const converted = (await q.getAutomation(legacy.id))!
    expect(converted.kind).toBe('morning')
    expect(converted.enabled).toBe(false)
    expect(converted.nextRunAt.toISOString()).toBe('2026-09-10T22:00:00.000Z')
  })

  it('turn a legacy inbox sweep into the brief, owner and all, or retire it beside a brief the chat already has', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    const ada = await q.upsertMember('111', 'Ada', { allowed: true })
    const personal = await q.addAutomation({
      chatId: '111', memberId: ada.id, label: "Ada's inbox", cronExpr: '0 8 * * *', instruction: 'mail', kind: 'inbox',
      nextRunAt: new Date('2026-09-15T22:00:00Z'),
    })
    await q.addAutomation({
      chatId: '-100', label: 'Family inbox sweep', cronExpr: '0 8 * * *', instruction: 'mail', kind: 'inbox',
      nextRunAt: new Date('2026-09-15T22:00:00Z'),
    })
    await q.addAutomation({
      chatId: '-100', label: 'Morning brief', cronExpr: WATCHERS.morning.cron, instruction: 'x', kind: 'morning',
      nextRunAt: new Date('2026-09-15T21:00:00Z'),
    })

    const report = await installBuiltins(now)
    expect(report.converted).toBe(1)
    expect(report.retired).toBe(1)
    const converted = (await q.getAutomation(personal.id))!
    expect(converted.kind).toBe('morning')
    expect(converted.label).toBe('Morning brief')
    expect(converted.cronExpr).toBe(WATCHERS.morning.cron)
    expect(converted.memberId).toBe(ada.id)
    expect(converted.instruction).not.toContain('whose mailbox')
    expect(converted.nextRunAt.toISOString()).toBe('2026-09-15T21:00:00.000Z')
    expect((await q.listAutomations('-100')).map((a) => a.kind).sort()).toEqual(['morning', 'snapshot'])
    expect(await q.listAutomations()).toHaveLength(3)
  })
})
