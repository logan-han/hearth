import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'
import { routineTools } from '@/lib/tools/routines'
import { routeGroups } from '@/lib/tools/router'
import { ambientContext } from '@/lib/agent'
import { describeWrite } from '@/lib/activity'
import { CUSTOM_AUTOMATION_TOOLS } from '@/lib/tools'

let client: PGlite
let ctx: ToolContext

const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})
const routines = () => routineTools(ctx)

beforeEach(async () => {
  client = (await freshDb()).client
  const member = await q.upsertMember('111', 'Rowan', { allowed: true })
  ctx = { chatId: '-100', member, memberName: 'Rowan', now: new Date(), notices: [], shared: true }
})
afterEach(async () => closeDb(client))

describe('routines', () => {
  it('keeps the steps of something done the same way each time, and hands them back to run by name', async () => {
    const kept = await call(routines(), 'save_routine', {
      name: 'Sunday reset', steps: ['Show the shopping list', ' ', 'Add bin bags to the shopping list', 'List next week on the family calendar'],
    })
    expect(kept).toMatchObject({ routine: 'Sunday reset', steps: ['1. Show the shopping list', '2. Add bin bags to the shopping list', '3. List next week on the family calendar'] })
    expect(kept.replaced).toBeUndefined()

    const run = await call(routines(), 'run_routine', { name: 'sunday RESET' })
    expect(run).toMatchObject({ routine: 'Sunday reset', steps: (kept.steps as string[]), next_step: expect.stringContaining('Carry these out now') })
  })

  it('replaces the steps of a routine kept again under its name, in any case', async () => {
    await call(routines(), 'save_routine', { name: 'Term start', steps: ['Order uniforms'] })
    const again = await call(routines(), 'save_routine', { name: 'term start', steps: ['Order uniforms', 'Label everything'] })
    expect(again).toMatchObject({ routine: 'Term start', replaced: true })
    expect((await q.listRoutines()).map((r) => r.steps)).toEqual(['Order uniforms\nLabel everything'])
  })

  it('takes a name kept by someone else a moment ago as the one to replace', async () => {
    await Promise.all([
      q.saveRoutine({ name: 'Bins', steps: 'one', createdBy: null }),
      q.saveRoutine({ name: 'bins', steps: 'two', createdBy: null }),
    ])
    expect(await q.listRoutines()).toHaveLength(1)
  })

  it('lists, forgets, and says so when there is nothing of that name', async () => {
    expect(await call(routines(), 'list_routines', {})).toMatchObject({ routines: [], note: expect.stringContaining('keep it as a routine') })
    expect(String((await call(routines(), 'run_routine', { name: 'x' })).error)).toContain('None are kept yet.')
    await call(routines(), 'save_routine', { name: 'Bins', steps: ['Remind everyone'] })
    const listed = await call(routines(), 'list_routines', {})
    expect(listed.routines).toEqual([{ name: 'Bins', steps: ['1. Remind everyone'], kept: expect.any(String) }])
    expect(String((await call(routines(), 'run_routine', { name: 'Recycling' })).error)).toContain('The routines are: Bins.')
    expect(await call(routines(), 'delete_routine', { name: 'BINS' })).toEqual({ deleted: 'Bins' })
    expect(await call(routines(), 'delete_routine', { name: 'Bins' })).toEqual({ error: 'No routine called "Bins".' })
  })

  it('keeps one for nobody in particular', async () => {
    const r = await call(routineTools({ ...ctx, member: null }), 'save_routine', { name: 'Bins', steps: ['Remind everyone'] })
    expect(r.routine).toBe('Bins')
    expect((await q.listRoutines())[0].createdBy).toBeNull()
  })

  it('needs a name and a step', async () => {
    expect(await call(routines(), 'save_routine', { name: ' ', steps: ['x'] })).toEqual({ error: 'A routine needs a name.' })
    expect(await call(routines(), 'save_routine', { name: 'x', steps: ['  '] })).toEqual({ error: 'A routine needs at least one step.' })
  })

  it('are in the chat context by name, and their names bring the routine tools', async () => {
    await call(routines(), 'save_routine', { name: 'Sunday reset', steps: ['x'] })
    const ambient = await ambientContext('-100', ctx.member, 'chat')
    expect(ambient.text).toContain('Routines kept (run_routine by name when one is asked for, then carry out its steps): Sunday reset.')
    expect(routeGroups('can you do the sunday reset', { routineNames: ambient.routineNames })).toContain('routines')
    expect(routeGroups('keep that as our routine')).toContain('routines')
    expect(CUSTOM_AUTOMATION_TOOLS).toContain('run_routine')
  })

  it('are on the record in words', () => {
    expect(describeWrite('save_routine', { name: 'Bins' }, { routine: 'Bins' })).toBe('kept the routine "Bins"')
    expect(describeWrite('save_routine', { name: 'Bins' }, { routine: 'Bins', replaced: true })).toBe('changed the routine "Bins"')
    expect(describeWrite('delete_routine', { name: 'bins' }, { deleted: 'Bins' })).toBe('forgot the routine "Bins"')
  })
})
