import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { installBuiltins } from '@/lib/builtins'
import { WATCHERS } from '@/lib/watchers'

let client: PGlite
/** Tuesday 15 September 2026, 10:30am in Melbourne. */
const now = new Date('2026-09-15T00:30:00Z')

beforeEach(async () => {
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
