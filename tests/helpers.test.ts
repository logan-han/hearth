import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'
import type { Helper } from '@/lib/db/schema'
import { helperTools } from '@/lib/tools/helpers'
import { automationTools } from '@/lib/tools/automation'
import { HELPER_TEMPLATES, templateNamed, roleInBrief, namesSomeone, firstName } from '@/lib/helpers'
import { systemPrompt } from '@/lib/agent'
import { context } from '@/lib/mcp'
import { describeWrite } from '@/lib/activity'
import { cronAt, localDateKey } from '@/lib/cron'

let client: PGlite
let ctx: ToolContext

const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})
const helpers = (over: Partial<ToolContext> = {}) => helperTools({ ...ctx, ...over })


beforeEach(async () => {
  client = (await freshDb()).client
  const member = await q.saveMember({ name: 'Rowan Smith', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
  ctx = { member, memberName: 'Rowan', now: new Date() }
  delete process.env.ASSISTANT_NAME
})
afterEach(async () => closeDb(client))

describe('helper names and roles', () => {
  it('knows a family member by their first name or their whole name', () => {
    const family = [{ name: 'Rowan Smith' }, { name: 'Max' }]
    expect(firstName('  Rowan Smith ')).toBe('rowan')
    expect(namesSomeone('rowan', family)).toBe(true)
    expect(namesSomeone('Rowan Smith', family)).toBe(true)
    expect(namesSomeone('MAX', family)).toBe(true)
    expect(namesSomeone('Chef', family)).toBe(false)
  })

  it('has ready-made helpers to add by name, and says each role in brief', () => {
    expect(templateNamed(' treasurer ')?.name).toBe('Treasurer')
    expect(templateNamed('Butler')).toBeUndefined()
    expect(roleInBrief('Cooks. Plans meals.')).toBe('Cooks.')
    expect(roleInBrief('No full stop here')).toBe('No full stop here')
    for (const t of HELPER_TEMPLATES) {
      expect(t.role.length).toBeGreaterThan(40)
      expect(t).not.toHaveProperty('groups')
    }
  })
})

describe('create_helper, list_helpers and remove_helper', () => {
  it('adds a ready-made helper by name alone, and a new one with a role of its own', async () => {
    const treasurer = await call(helpers(), 'create_helper', { name: 'treasurer' })
    expect(treasurer).toMatchObject({ helper: 'treasurer', role: templateNamed('Treasurer')!.role })
    expect(treasurer).not.toHaveProperty('groups')
    expect(String(treasurer.note)).toContain('hand_off gives it a job')
    expect(String(treasurer.note)).toContain('take its role up yourself')
    const custom = await call(helpers(), 'create_helper', { name: 'Gardener', role: 'Looks after the garden.' })
    expect(custom).toMatchObject({ helper: 'Gardener', role: 'Looks after the garden.' })
    expect(await q.helperNamed('GARDENER')).toMatchObject({ name: 'Gardener', role: 'Looks after the garden.' })

    const listed = await call(helpers(), 'list_helpers', {})
    expect((listed.helpers as { name: string }[]).map((h) => h.name)).toEqual(['treasurer', 'Gardener'])
    expect((listed.helpers as Record<string, unknown>[])[1]).toEqual({ name: 'Gardener', role: 'Looks after the garden.' })
    expect((listed.ready_to_add as { name: string }[]).map((h) => h.name)).toEqual(['Chef', 'Planner', 'Researcher', 'Secretary', 'Coach'])
  })

  it('turns away a name it could not answer to, its own, a family member\'s, one taken, or a new one with no role', async () => {
    expect(String((await call(helpers(), 'create_helper', { name: 'Chef 2000' })).error)).toContain('one or two words of letters')
    process.env.ASSISTANT_NAME = 'Pip'
    expect(String((await call(helpers(), 'create_helper', { name: 'pip', role: 'x' })).error)).toContain("Hearth's own name")
    expect(String((await call(helpers(), 'create_helper', { name: 'Rowan', role: 'x' })).error)).toContain('what someone in the family is called')
    expect(String((await call(helpers(), 'create_helper', { name: 'Gardener' })).error)).toContain('every helper needs a role')
    await call(helpers(), 'create_helper', { name: 'Chef' })
    expect(String((await call(helpers(), 'create_helper', { name: 'CHEF' })).error)).toBe('There is already a helper called CHEF.')
  })

  it('adds one for nobody in particular, but hands it a job only for a member, whose report it is', async () => {
    const r = await call(helpers({ member: null }), 'create_helper', { name: 'Gardener', role: 'Looks after the garden.' })
    expect(r.helper).toBe('Gardener')
    expect((await q.helperNamed('gardener'))!.createdBy).toBeNull()
    await expect(call(helpers({ member: null }), 'hand_off', { helper: 'Gardener', task: 'Check the frost forecast' })).rejects.toThrow(/family member/)
    expect(await q.listAutomations()).toEqual([])
    const helper = (await q.helperNamed('gardener'))!
    expect(await q.getHelper(helper.id)).toMatchObject({ name: 'Gardener' })
    expect(await q.getHelper(999)).toBeUndefined()
  })

  it('removes a helper, and says so when there is none of that name', async () => {
    await call(helpers(), 'create_helper', { name: 'Chef' })
    expect(await call(helpers(), 'remove_helper', { name: 'chef' })).toEqual({ removed: 'Chef' })
    expect(await call(helpers(), 'remove_helper', { name: 'chef' })).toEqual({ error: 'There is no helper called chef.' })
  })
})

describe('hand_off', () => {
  it("gives a helper a job for the next tick, once, as that helper's", async () => {
    const chef = await call(helpers(), 'create_helper', { name: 'Chef' })
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000
    await q.recordTick(new Date(hour - 3_600_000))
    await q.recordTick(new Date(hour))
    const r = await call(helpers(), 'hand_off', { helper: 'chef', task: '  Plan five dinners for next week, no mushrooms.  ' })
    expect(r).toMatchObject({ handed_to: chef.helper, task: 'Plan five dinners for next week, no mushrooms.' })
    expect(String(r.note)).toBe('Chef leaves a report when it is done, or nothing if there is nothing to say. It is listed with your reminders until then.')
    const job = (await q.getAutomation(Number(r.automation_id)))!
    expect(job).toMatchObject({ repeat: 'once', label: 'Chef: Plan five dinners for next week, no mushrooms.', memberId: ctx.member!.id })
    expect(job.helperId).toBe((await q.helperNamed('Chef'))!.id)
    // The next tick, on the hour, within the hour.
    expect(job.nextRunAt.getTime() % 3_600_000).toBe(0)
    expect(job.nextRunAt.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000 + 60_000)
  })

  it('takes the top of the next hour before the scheduler has shown its cadence, or a time it is given', async () => {
    await call(helpers(), 'create_helper', { name: 'Researcher' })
    const soon = await call(helpers(), 'hand_off', { helper: 'Researcher', task: 'x'.repeat(80) })
    const job = (await q.getAutomation(Number(soon.automation_id)))!
    expect(job.nextRunAt.getTime() % 3_600_000).toBe(0)
    expect(job.label).toBe(`Researcher: ${'x'.repeat(59)}…`)
    const tomorrow = localDateKey(new Date(Date.now() + 86_400_000))
    const later = await call(helpers(), 'hand_off', { helper: 'Researcher', task: 'Look into plumbers', at: `${tomorrow}T15:00` })
    const job2 = (await q.getAutomation(Number(later.automation_id)))!
    expect(job2.cronExpr).toBe(cronAt(job2.nextRunAt))
    expect(String(later.runs_local)).toMatch(/3:00 pm/)
  })

  it('refuses a helper there is not, an empty job, and a time it cannot use', async () => {
    expect(String((await call(helpers(), 'hand_off', { helper: 'Chef', task: 'x' })).error)).toContain('create_helper adds one')
    await call(helpers(), 'create_helper', { name: 'Chef' })
    expect(String((await call(helpers(), 'hand_off', { helper: 'Butler', task: 'x' })).error)).toContain('The helpers are Chef.')
    expect(String((await call(helpers(), 'hand_off', { helper: 'Chef', task: '  ' })).error)).toBe('Say what the job is.')
    expect(String((await call(helpers(), 'hand_off', { helper: 'Chef', task: 'x', at: 'later' })).error)).toContain('is not a time')
    expect(String((await call(helpers(), 'hand_off', { helper: 'Chef', task: 'x', at: '2020-01-01T09:00' })).error)).toContain('has already passed')
    await q.recordTick(new Date('2026-08-26T22:00:00Z'))
    await q.recordTick(new Date('2026-08-26T23:00:01Z'))
    const tomorrow = localDateKey(new Date(Date.now() + 86_400_000))
    expect(String((await call(helpers(), 'hand_off', { helper: 'Chef', task: 'x', at: `${tomorrow}T15:30` })).error)).toContain('hourly, on the hour')
    expect(await q.listAutomations()).toEqual([])
  })

  it("makes what a helper schedules in its own turn that helper's", async () => {
    await call(helpers(), 'create_helper', { name: 'Chef' })
    const chef = (await q.helperNamed('Chef'))!
    const r = await call(automationTools({ ...ctx, helper: chef }), 'create_automation', { label: 'dinners', cron: '0 16 * * 0', instruction: 'Plan the week of dinners.' })
    expect((await q.getAutomation(Number(r.id)))!.helperId).toBe(chef.id)
    const plain = await call(automationTools(ctx), 'create_automation', { label: 'bins', cron: '0 19 * * 1', instruction: 'Bins.' })
    expect((await q.getAutomation(Number(plain.id)))!.helperId).toBeNull()
  })
})

describe('helpers for an MCP client', () => {
  it('are listed in the context, with what hand_off is for', async () => {
    await call(helpers(), 'create_helper', { name: 'Chef' })
    const text = await context(ctx.member!, new Date())
    expect(text).toContain('Helpers (hand_off gives one a job to do in the background; asked to talk to one, take its role up):')
    expect(text).toContain("- Chef: Plans the household's meals:")
  })

  it('do a job as themselves, in their role, and never sign their own report', () => {
    const p = systemPrompt({ now: new Date(), context: '', helper: { name: 'Chef', role: 'Plans meals.' } })
    expect(p).toContain("You are Chef, one of Hearth's helpers for one family. Your report carries your name, so never sign it yourself.\nROLE: Plans meals.")
    expect(p).not.toContain('You are Hearth, the household assistant')
    expect(systemPrompt({ now: new Date(), context: '' })).toContain('You are Hearth, the household assistant for one family.')
  })

  it('are on the record in words', () => {
    expect(describeWrite('create_helper', { name: 'Chef' }, { helper: 'Chef' })).toBe('added the helper Chef')
    expect(describeWrite('remove_helper', { name: 'chef' }, {})).toBe('removed the helper chef')
    expect(describeWrite('hand_off', { helper: 'chef', task: 'Plan dinners' }, { handed_to: 'Chef', runs_local: 'Fri 30 Oct, 3:00 pm' }))
      .toBe('handed "Plan dinners" to Chef, for Fri 30 Oct, 3:00 pm')
    expect(describeWrite('hand_off', { helper: 'chef', task: 'Plan dinners' }, {})).toBe('handed "Plan dinners" to chef')
  })
})
