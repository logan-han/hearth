import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'
import { goalTools, checkInInstruction, daysUntil, canSee, DEFAULT_CHECK_IN } from '@/lib/tools/goals'
import { daysAfter, localDateKey } from '@/lib/cron'
import { context } from '@/lib/mcp'
import { describeWrite } from '@/lib/activity'
import { gatherFamilyStats } from '@/lib/stats'
import { CUSTOM_AUTOMATION_TOOLS } from '@/lib/tools'

let client: PGlite
let ctx: ToolContext

const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})
const goals = (over: Partial<ToolContext> = {}) => goalTools({ ...ctx, ...over })
const ada = () => q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })

const now = new Date()
const inDays = (n: number) => daysAfter(localDateKey(now), n)

beforeEach(async () => {
  client = (await freshDb()).client
  const member = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
  ctx = { member, memberName: 'Rowan', now }
})
afterEach(async () => closeDb(client))

describe('create_goal', () => {
  it("starts a goal of the caller's own, with a plan of its own and a weekly check-in, and makes no shared list", async () => {
    const r = await call(goals(), 'create_goal', {
      title: 'Bali trip', outcome: '$6,000 saved and flights booked', target_date: inDays(120),
      steps: ['Open a savings account', 'Price flights', ' '],
    })
    expect(r).toMatchObject({ title: 'Bali trip', steps: ['Open a savings account', 'Price flights'], days_left: 120 })
    expect(String(r.check_in)).toMatch(/^next .*7:00 pm, then on that schedule$/)
    const goal = (await q.getGoal(Number(r.goal_id)))!
    expect(goal).toMatchObject({ memberId: ctx.member!.id, status: 'active', outcome: '$6,000 saved and flights booked', targetDate: inDays(120) })
    expect((await q.goalStepsOf(goal.id)).map((st) => st.content)).toEqual(['Open a savings account', 'Price flights'])
    expect(await q.allLists()).toEqual([])
    const check = (await q.getAutomation(goal.automationId!))!
    expect(check).toMatchObject({ memberId: ctx.member!.id, label: 'Goal check-in: Bali trip', cronExpr: DEFAULT_CHECK_IN, repeat: 'always', instruction: checkInInstruction(goal) })
    expect(check.instruction).toContain(`Call goal_status with id ${goal.id}`)
    expect(check.instruction).toContain('write a short check-in')
  })

  it('says its check-in is kept as a report rather than posted anywhere', async () => {
    const { buildTools } = await import('@/lib/tools')
    expect(String((buildTools(ctx).create_goal as { description?: string }).description)).toContain('kept for you in list_reports and on Home')
  })

  it('takes a check-in schedule of its own, or none at all', async () => {
    const weekly = await call(goals(), 'create_goal', { title: 'Run 5k', steps: [], check_in: '0 8 * * 1' })
    expect((await q.getAutomation((await q.getGoal(Number(weekly.goal_id)))!.automationId!))!.cronExpr).toBe('0 8 * * 1')
    const quiet = await call(goals(), 'create_goal', { title: 'Read more', steps: [], check_in: 'none' })
    expect(quiet.check_in).toBe('none')
    expect((await q.getGoal(Number(quiet.goal_id)))!.automationId).toBeNull()
  })

  it('gives a second goal of the same name a plan of its own', async () => {
    const first = await call(goals(), 'create_goal', { title: 'Garage clean-out', steps: ['Sort the shelves'] })
    const again = await call(goals(), 'create_goal', { title: 'Garage clean-out', steps: ['Hire a skip'] })
    expect((await q.goalStepsOf(Number(first.goal_id))).map((st) => st.content)).toEqual(['Sort the shelves'])
    expect((await q.goalStepsOf(Number(again.goal_id))).map((st) => st.content)).toEqual(['Hire a skip'])
  })

  it('labels the check-in with the goal, and follows a rename', async () => {
    const r = await call(goals(), 'create_goal', { title: 'Leave my job', steps: ['Update CV'] })
    const check = (await q.getAutomation((await q.getGoal(Number(r.goal_id)))!.automationId!))!
    expect(check.label).toBe('Goal check-in: Leave my job')
    await call(goals(), 'update_goal', { id: r.goal_id, title: 'New role' })
    expect((await q.getAutomation(check.id))!.label).toBe('Goal check-in: New role')
    expect((await q.getAutomation(check.id))!.instruction).toContain('"New role"')
  })

  it('makes nothing when a date or a schedule will not do', async () => {
    expect(String((await call(goals(), 'create_goal', { title: 'x', steps: [], target_date: 'March' })).error)).toContain('is not a date')
    expect(String((await call(goals(), 'create_goal', { title: 'x', steps: [], target_date: '2026-02-30' })).error)).toContain('is not a date')
    expect(String((await call(goals(), 'create_goal', { title: 'x', steps: [], target_date: inDays(-1) })).error)).toContain('has already passed')
    expect(String((await call(goals(), 'create_goal', { title: 'x', steps: [], check_in: 'weekly' })).error)).toContain('not a valid')
    expect(String((await call(goals(), 'create_goal', { title: '  ', steps: [] })).error)).toContain('needs a name')
    expect(await q.goalsIn({ memberId: ctx.member!.id })).toEqual([])
    expect(await q.listAutomations()).toEqual([])
  })
})

describe('list_goals and goal_status', () => {
  it('shows each member their own goals, and never another member\'s', async () => {
    const other = await ada()
    await call(goals(), 'create_goal', { title: 'Family trip', steps: ['Book flights', 'Pack'] })
    await call(goals(), 'create_goal', { title: 'Run 5k', steps: ['Buy shoes'] })
    const theirs = await call(goals({ member: other, memberName: 'Ada' }), 'create_goal', { title: "Ada's own", steps: [] })

    const mine = (await call(goals(), 'list_goals', {})).goals as Record<string, unknown>[]
    expect(mine.map((g) => g.title)).toEqual(['Family trip', 'Run 5k'])
    expect(mine[0]).toMatchObject({ steps_done: 0, steps_total: 2, next_step: 'Book flights' })
    const hers = (await call(goals({ member: other }), 'list_goals', {})).goals as Record<string, unknown>[]
    expect(hers.map((g) => g.title)).toEqual(["Ada's own"])
    expect(await call(goals(), 'goal_status', { id: theirs.goal_id })).toEqual({ error: `No goal ${theirs.goal_id} of yours.` })
    expect(await call(goals(), 'update_goal', { id: theirs.goal_id, progress: 'x' })).toEqual({ error: `No goal ${theirs.goal_id} of yours.` })
    const fresh = await q.saveMember({ name: 'Sam', email: 'sam@hearth.example', allowed: true, isAdmin: false })
    expect(await call(goals({ member: fresh }), 'list_goals', {})).toMatchObject({ goals: [], note: expect.stringContaining('create_goal') })
  })

  it('lets a check-in, running as its owner, read the goal, and nobody else', async () => {
    const mine = await call(goals(), 'create_goal', { title: 'Leave my job', steps: ['Update CV'] })
    // The check-in runs as a scheduled job, as Rowan.
    const scheduled = goals({ via: 'watcher', cursorScope: 'auto:1' })
    expect(((await call(scheduled, 'list_goals', {})).goals as unknown[]).length).toBe(1)
    expect(await call(scheduled, 'goal_status', { id: mine.goal_id })).toMatchObject({ title: 'Leave my job' })
    // Another member's run, or one with nobody behind it, cannot.
    expect(await call(goals({ member: await ada(), via: 'watcher' }), 'goal_status', { id: mine.goal_id })).toEqual({ error: `No goal ${mine.goal_id} of yours.` })
    expect(await call(goals({ member: null }), 'goal_status', { id: mine.goal_id })).toEqual({ error: `No goal ${mine.goal_id} of yours.` })
    const goal = (await q.getGoal(Number(mine.goal_id)))!
    expect(canSee(goal, ctx)).toBe(true)
    expect(canSee(goal, { member: null })).toBe(false)
  })

  it('gives one goal in full, and turns away a goal that is not the caller\'s', async () => {
    const made = await call(goals(), 'create_goal', { title: 'Party', outcome: 'Thirty kids fed', target_date: inDays(10), steps: ['Book the hall', 'Send invites'] })
    const goal = (await q.getGoal(Number(made.goal_id)))!
    await call(goals(), 'update_goal', { id: goal.id, steps_done: ['hall'], progress: 'Hall booked for the Saturday' })

    const r = await call(goals(), 'goal_status', { id: goal.id })
    expect(r).toMatchObject({
      title: 'Party', status: 'active', days_left: 10, outcome: 'Thirty kids fed',
      steps: { done: 1, total: 2, open: ['Send invites'], finished: ['Book the hall'] },
      updates: [{ note: 'Hall booked for the Saturday', who: 'Rowan' }],
    })
    expect(String(r.check_in)).toMatch(/7:00 pm/)
    expect(await call(goals(), 'goal_status', { id: 999 })).toEqual({ error: 'No goal 999 of yours.' })
  })

  it('says a goal with no steps has none to take next', async () => {
    const made = await call(goals(), 'create_goal', { title: 'Bare', steps: [], check_in: 'none' })
    const [g] = (await call(goals(), 'list_goals', {})).goals as Record<string, unknown>[]
    expect(g).toMatchObject({ steps_done: 0, steps_total: 0 })
    expect(g.next_step).toBeUndefined()
    const r = await call(goals(), 'goal_status', { id: made.goal_id })
    expect(r).toMatchObject({ check_in: 'none', steps: { total: 0 } })
  })

  it('names nobody when progress was noted for a member removed since', async () => {
    const made = await call(goals(), 'create_goal', { title: 'Shed', steps: [], check_in: 'none' })
    const other = await ada()
    await q.addGoalUpdate(Number(made.goal_id), 'Half done', other.id)
    await q.deleteMember(other.id)
    const status = await call(goals(), 'goal_status', { id: made.goal_id })
    expect(status).toMatchObject({ updates: [{ note: 'Half done', who: 'someone' }] })
    const [g] = (await call(goals(), 'list_goals', {})).goals as Record<string, unknown>[]
    expect(String(g.latest_update)).toMatch(/^Half done \(someone, /)
  })
})

describe('update_goal', () => {
  async function party() {
    const made = await call(goals(), 'create_goal', { title: 'Party', target_date: inDays(10), steps: ['Book the hall'] })
    return (await q.getGoal(Number(made.goal_id)))!
  }

  it('logs progress, moves the target and renames it, the check-in following the name', async () => {
    const goal = await party()
    const r = await call(goals(), 'update_goal', { id: goal.id, progress: 'Invites out', target_date: inDays(20), title: "Ada's party", outcome: 'Fun had' })
    expect(r.changed).toEqual([`renamed to "Ada's party"`, 'what done looks like', expect.stringMatching(/^target /), 'progress noted'])
    expect(await q.getGoal(goal.id)).toMatchObject({ title: "Ada's party", targetDate: inDays(20), outcome: 'Fun had' })
    expect((await q.getAutomation(goal.automationId!))!.label).toBe("Goal check-in: Ada's party")
    const cleared = await call(goals(), 'update_goal', { id: goal.id, target_date: 'none', outcome: '' })
    expect(cleared.changed).toEqual(['what done looks like', 'target cleared'])
    expect(await q.getGoal(goal.id)).toMatchObject({ targetDate: null, outcome: null })
  })

  it('closes a goal once, ending its check-ins, and reopens it with new ones of its owner\'s', async () => {
    const goal = await party()
    const done = await call(goals(), 'update_goal', { id: goal.id, status: 'done' })
    expect(done.changed).toEqual(['marked done, check-ins ended'])
    expect(await q.getAutomation(goal.automationId!)).toBeUndefined()
    expect(await q.getGoal(goal.id)).toMatchObject({ status: 'done', automationId: null })
    expect(await call(goals(), 'update_goal', { id: goal.id, status: 'dropped' })).toMatchObject({ error: `Goal ${goal.id} is already done.` })

    const back = await call(goals(), 'update_goal', { id: goal.id, status: 'active' })
    expect(back.changed).toEqual(['reopened, with check-ins on Sundays at 7pm'])
    const reopened = (await q.getGoal(goal.id))!
    expect(reopened.status).toBe('active')
    const check = (await q.getAutomation(reopened.automationId!))!
    expect(check).toMatchObject({ memberId: ctx.member!.id, label: 'Goal check-in: Party', instruction: checkInInstruction(goal) })

    const gone = await call(goals(), 'update_goal', { id: goal.id, status: 'dropped' })
    expect(gone.changed).toEqual(['dropped, check-ins ended'])
  })

  it('ticks steps off and back by what they say, and adds new ones to the end', async () => {
    const goal = await party()
    const r = await call(goals(), 'update_goal', { id: goal.id, steps_done: ['HALL'], new_steps: ['Send invites', ' ', 'Order the cake'] })
    expect(r.changed).toEqual(['ticked off Book the hall', 'added Send invites, Order the cake'])
    const back = await call(goals(), 'update_goal', { id: goal.id, steps_undone: ['book the hall'] })
    expect(back.changed).toEqual(['put back Book the hall'])
    expect((await q.goalStepsOf(goal.id)).map((st) => [st.content, st.done])).toEqual([['Book the hall', false], ['Send invites', false], ['Order the cake', false]])
    // A step it cannot find is said so, alone or beside another change.
    expect(await call(goals(), 'update_goal', { id: goal.id, steps_done: ['balloons'] })).toEqual({ error: 'No step matched. goal_status lists them as they are written.' })
    expect(await call(goals(), 'update_goal', { id: goal.id, steps_done: ['balloons', ' '], progress: 'Venue rang' })).toMatchObject({
      changed: ['progress noted'],
      note: expect.stringContaining('No step matched'),
    })
    // A step is matched within a longer word as well: "party invites" covers "invites".
    expect((await call(goals(), 'update_goal', { id: goal.id, steps_done: ['the cake order please, order the cake'] })).changed).toEqual(['ticked off Order the cake'])
  })

  it('refuses a date it cannot read, an empty change, and a goal that is not the caller\'s', async () => {
    const goal = await party()
    expect(String((await call(goals(), 'update_goal', { id: goal.id, target_date: 'soon' })).error)).toContain('is not a date')
    expect(String((await call(goals(), 'update_goal', { id: goal.id })).error)).toContain('Nothing to change')
    expect(await call(goals({ member: await ada() }), 'update_goal', { id: goal.id, progress: 'x' })).toEqual({ error: `No goal ${goal.id} of yours.` })
  })
})

describe('goals need a member, and some go without a check-in', () => {
  it('cannot be started or listed by a call with no member behind it', async () => {
    await expect(call(goals({ member: null }), 'create_goal', { title: 'Tidy shed', steps: [], check_in: 'none' })).rejects.toThrow(/family member/)
    await expect(call(goals({ member: null }), 'list_goals', {})).rejects.toThrow(/family member/)
  })

  it('closes one with no check-in, says when it was closed, and turns away a second close with what it did change', async () => {
    const r = await call(goals(), 'create_goal', { title: 'Tidy shed', steps: [], check_in: 'none' })
    expect((await call(goals(), 'update_goal', { id: r.goal_id, status: 'done' })).changed).toEqual(['marked done, check-ins ended'])
    expect(String((await call(goals(), 'goal_status', { id: r.goal_id })).closed)).toMatch(/\d{4}$/)
    expect(await call(goals(), 'update_goal', { id: r.goal_id, status: 'dropped', progress: 'Gave up' })).toEqual({
      error: `Goal ${r.goal_id} is already done.`,
      changed: ['progress noted'],
    })
  })

  it('reopens a goal without a check-in when the scheduler cannot fit Sunday at 7pm', async () => {
    const r = await call(goals(), 'create_goal', { title: 'Tidy shed', steps: [], check_in: 'none' })
    await call(goals(), 'update_goal', { id: r.goal_id, status: 'dropped' })
    await q.recordTick(new Date('2026-08-26T22:00:00Z'))
    await q.recordTick(new Date('2026-08-26T22:22:00Z'))
    await call(goals(), 'update_goal', { id: r.goal_id, status: 'active' })
    expect(await q.getGoal(Number(r.goal_id))).toMatchObject({ status: 'active', automationId: null })
  })

  it('renames one with no check-in, and changes nothing else it was not asked to', async () => {
    const r = await call(goals(), 'create_goal', { title: 'Shed', outcome: 'Tidy', target_date: inDays(9), steps: [], check_in: 'none' })
    expect((await call(goals(), 'update_goal', { id: r.goal_id, title: 'Garage' })).changed).toEqual(['renamed to "Garage"'])
    expect(await q.getGoal(Number(r.goal_id))).toMatchObject({ title: 'Garage', outcome: 'Tidy', targetDate: inDays(9) })
  })
})

describe('goals for an MCP client', () => {
  it("are in their owner's context, with what the goal tools want, and in nobody else's", async () => {
    const made = await call(goals(), 'create_goal', { title: 'Bali trip', target_date: inDays(30), steps: ['Price flights'] })
    const text = await context(ctx.member!, now)
    expect(text).toContain(`- goal_id ${made.goal_id}: "Bali trip", 0 of 1 steps done, target `)
    expect(text).toContain('(30 days), next: Price flights')
    expect(await context(await ada(), now)).not.toContain('Bali trip')
  })

  it('can be read by a check-in, which runs with nothing that writes', () => {
    expect(CUSTOM_AUTOMATION_TOOLS).toEqual(expect.arrayContaining(['goal_status', 'list_goals']))
    expect(CUSTOM_AUTOMATION_TOOLS).not.toContain('update_goal')
  })

  it('are on the record in words', () => {
    expect(describeWrite('create_goal', { title: 'Bali', steps: ['a', 'b'] }, { title: 'Bali' })).toBe('started the goal "Bali" with 2 steps')
    expect(describeWrite('create_goal', { title: 'Bali' }, {})).toBe('started the goal "Bali"')
    expect(describeWrite('update_goal', { id: 3 }, { title: 'Bali', changed: ['progress noted'] })).toBe('goal "Bali": progress noted')
    expect(describeWrite('update_goal', { id: 3 }, {})).toBe('goal "3": changed')
  })

  it('count days by the calendar', () => {
    expect(daysUntil(localDateKey(now), now)).toBe(0)
    expect(daysUntil(inDays(-3), now)).toBe(-3)
  })
})

describe('goals on Home', () => {
  it("lists the viewer's own goals, with steps and the latest progress, and nobody else's", async () => {
    const other = await ada()
    const trip = await call(goals(), 'create_goal', { title: 'Family trip', target_date: inDays(5), steps: ['Book flights', 'Pack'] })
    await call(goals({ member: other }), 'create_goal', { title: "Ada's own", steps: [] })
    await call(goals(), 'create_goal', { title: "Rowan's own", steps: [], target_date: inDays(1) })
    await call(goals(), 'update_goal', { id: trip.goal_id, progress: 'Flights priced' })

    await call(goals(), 'create_goal', { title: 'Someday', outcome: 'A tidy shed', steps: [], check_in: 'none' })
    const rowan = await gatherFamilyStats(undefined, ctx.member!.id)
    expect(rowan.goals.map((g) => g.title)).toEqual(["Rowan's own", 'Family trip', 'Someday'])
    expect(rowan.goals[2]).toMatchObject({ outcome: 'A tidy shed', target: null, daysLeft: null, steps: [] })
    expect(rowan.goals[1]).toMatchObject({ daysLeft: 5, done: 0, latest: 'Flights priced', steps: [{ content: 'Book flights' }, { content: 'Pack' }] })
    expect((await gatherFamilyStats(undefined, other.id)).goals.map((g) => g.title)).toEqual(["Ada's own"])
    expect((await gatherFamilyStats()).goals).toEqual([])
  })
})
