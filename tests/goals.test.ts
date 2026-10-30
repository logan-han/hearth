import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'
import { goalTools, checkInInstruction, daysUntil, DEFAULT_CHECK_IN } from '@/lib/tools/goals'
import { daysAfter, localDateKey } from '@/lib/cron'
import { ambientContext } from '@/lib/agent'
import { routeGroups } from '@/lib/tools/router'
import { describeWrite } from '@/lib/activity'
import { gatherFamilyStats } from '@/lib/stats'
import { CUSTOM_AUTOMATION_TOOLS } from '@/lib/tools'

let client: PGlite
let ctx: ToolContext

const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})
const goals = (over: Partial<ToolContext> = {}) => goalTools({ ...ctx, ...over })

const now = new Date()
const inDays = (n: number) => daysAfter(localDateKey(now), n)

beforeEach(async () => {
  client = (await freshDb()).client
  const member = await q.upsertMember('111', 'Rowan', { allowed: true })
  ctx = { chatId: '-100', member, memberName: 'Rowan', now, notices: [], shared: true }
})
afterEach(async () => closeDb(client))

describe('create_goal', () => {
  it('starts a goal with a plan of its own and a weekly check-in in this chat, and makes no shared list', async () => {
    const r = await call(goals(), 'create_goal', {
      title: 'Bali trip', outcome: '$6,000 saved and flights booked', target_date: inDays(120),
      steps: ['Open a savings account', 'Price flights', ' '],
    })
    expect(r).toMatchObject({ title: 'Bali trip', steps: ['Open a savings account', 'Price flights'], days_left: 120 })
    expect(String(r.check_in)).toMatch(/^next .*7:00 pm, then on that schedule$/)
    const goal = (await q.getGoal(Number(r.goal_id)))!
    expect(goal).toMatchObject({ chatId: '-100', memberId: ctx.member!.id, status: 'active', outcome: '$6,000 saved and flights booked', targetDate: inDays(120) })
    expect((await q.goalStepsOf(goal.id)).map((st) => st.content)).toEqual(['Open a savings account', 'Price flights'])
    expect(await q.allLists()).toEqual([])
    const check = (await q.getAutomation(goal.automationId!))!
    expect(check).toMatchObject({ chatId: '-100', label: 'Goal check-in: Bali trip', cronExpr: DEFAULT_CHECK_IN, repeat: 'always', instruction: checkInInstruction(goal) })
    expect(check.instruction).toContain(`Call goal_status with id ${goal.id}`)
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

  it("labels a member's own goal's check-in with nothing that gives it away, since Home lists every reminder", async () => {
    const r = await call(goals({ chatId: '111', shared: false }), 'create_goal', { title: 'Leave my job', steps: ['Update CV'] })
    const check = (await q.getAutomation((await q.getGoal(Number(r.goal_id)))!.automationId!))!
    expect(check.label).toBe('Goal check-in')
    await call(goals({ chatId: '111', shared: false }), 'update_goal', { id: r.goal_id, title: 'New role' })
    expect((await q.getAutomation(check.id))!.label).toBe('Goal check-in')
    expect((await q.getAutomation(check.id))!.instruction).toContain('"New role"')
  })

  it('makes nothing when a date or a schedule will not do', async () => {
    expect(String((await call(goals(), 'create_goal', { title: 'x', steps: [], target_date: 'March' })).error)).toContain('is not a date')
    expect(String((await call(goals(), 'create_goal', { title: 'x', steps: [], target_date: '2026-02-30' })).error)).toContain('is not a date')
    expect(String((await call(goals(), 'create_goal', { title: 'x', steps: [], target_date: inDays(-1) })).error)).toContain('has already passed')
    expect(String((await call(goals(), 'create_goal', { title: 'x', steps: [], check_in: 'weekly' })).error)).toContain('not a valid')
    expect(String((await call(goals(), 'create_goal', { title: '  ', steps: [] })).error)).toContain('needs a name')
    expect(await q.goalsIn()).toEqual([])
    expect(await q.listAutomations()).toEqual([])
  })
})

describe('list_goals and goal_status', () => {
  it("shows a group its own goals, and a member's own chat or client theirs from anywhere", async () => {
    await call(goals(), 'create_goal', { title: 'Family trip', steps: ['Book flights', 'Pack'] })
    await call(goals({ chatId: '111', shared: false }), 'create_goal', { title: 'Run 5k', steps: ['Buy shoes'] })
    await call(goals({ chatId: '-200' }), 'create_goal', { title: 'Other group', steps: [] })

    const inGroup = (await call(goals(), 'list_goals', {})).goals as Record<string, unknown>[]
    expect(inGroup.map((g) => g.title)).toEqual(['Family trip'])
    expect(inGroup[0]).toMatchObject({ steps_done: 0, steps_total: 2, next_step: 'Book flights' })
    // In their own chat, the goals they started anywhere.
    const own = (await call(goals({ chatId: '111', shared: false }), 'list_goals', {})).goals as Record<string, unknown>[]
    expect(own.map((g) => g.title)).toEqual(['Family trip', 'Run 5k', 'Other group'])
    // And through their MCP client, which acts in the group but is read by them alone.
    const client = (await call(goals({ via: 'mcp', shared: false }), 'list_goals', {})).goals as Record<string, unknown>[]
    expect(client.map((g) => g.title)).toEqual(['Family trip', 'Run 5k', 'Other group'])
    expect(await call(goals({ chatId: '-300' }), 'list_goals', {})).toMatchObject({ goals: [], note: expect.stringContaining('create_goal') })
  })

  it("never hands a scheduled run in the group a member's own goal, though it runs as them and reads their mail alone", async () => {
    const mine = await call(goals({ chatId: '111', shared: false }), 'create_goal', { title: 'Leave my job', steps: ['Update CV'] })
    // A job handed over in the group, as a custom automation runs it: Rowan's, unshared, posting to the group.
    const scheduled = goals({ via: 'watcher', shared: false })
    expect(((await call(scheduled, 'list_goals', {})).goals as unknown[]).length).toBe(0)
    expect(await call(scheduled, 'goal_status', { id: mine.goal_id })).toEqual({ error: `No goal ${mine.goal_id} here.` })
    expect(await call(scheduled, 'update_goal', { id: mine.goal_id, progress: 'x' })).toEqual({ error: `No goal ${mine.goal_id} here.` })
    // Nor is it in the group's context.
    expect((await ambientContext('-100', ctx.member, 'chat')).text).not.toContain('Leave my job')
    expect((await ambientContext('111', ctx.member, 'chat')).text).toContain('Leave my job')
  })

  it('gives one goal in full, and turns away a goal this room cannot see', async () => {
    const made = await call(goals(), 'create_goal', { title: 'Party', target_date: inDays(10), steps: ['Book the hall', 'Send invites'] })
    const goal = (await q.getGoal(Number(made.goal_id)))!
    await call(goals(), 'update_goal', { id: goal.id, steps_done: ['hall'], progress: 'Hall booked for the Saturday' })

    const r = await call(goals(), 'goal_status', { id: goal.id })
    expect(r).toMatchObject({
      title: 'Party', status: 'active', days_left: 10,
      steps: { done: 1, total: 2, open: ['Send invites'], finished: ['Book the hall'] },
      updates: [{ note: 'Hall booked for the Saturday', who: 'Rowan' }],
    })
    expect(String(r.check_in)).toMatch(/7:00 pm/)
    expect(await call(goals({ chatId: '-999' }), 'goal_status', { id: goal.id })).toEqual({ error: `No goal ${goal.id} here.` })
    expect(await call(goals(), 'goal_status', { id: 999 })).toEqual({ error: 'No goal 999 here.' })
  })

  it('says a goal with no steps has none to take next', async () => {
    const made = await call(goals(), 'create_goal', { title: 'Bare', steps: [], check_in: 'none' })
    const [g] = (await call(goals(), 'list_goals', {})).goals as Record<string, unknown>[]
    expect(g).toMatchObject({ steps_done: 0, steps_total: 0 })
    expect(g.next_step).toBeUndefined()
    const r = await call(goals(), 'goal_status', { id: made.goal_id })
    expect(r).toMatchObject({ check_in: 'none', steps: { total: 0 } })
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

  it('closes a goal once, ending its check-ins, and reopens it with new ones', async () => {
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
    expect((await q.getAutomation(reopened.automationId!))!.instruction).toBe(checkInInstruction(goal))

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

  it('refuses a date it cannot read, an empty change, and a goal this room cannot see', async () => {
    const goal = await party()
    expect(String((await call(goals(), 'update_goal', { id: goal.id, target_date: 'soon' })).error)).toContain('is not a date')
    expect(String((await call(goals(), 'update_goal', { id: goal.id })).error)).toContain('Nothing to change')
    expect(await call(goals({ chatId: '-999' }), 'update_goal', { id: goal.id, progress: 'x' })).toEqual({ error: `No goal ${goal.id} here.` })
  })
})

describe('goals with nobody in particular, and goals without a check-in', () => {
  it('are kept and read for a run with no member, as a scheduled one is', async () => {
    const r = await call(goals({ member: null }), 'create_goal', { title: 'Tidy shed', outcome: 'Room for the bikes', steps: ['Sort'], check_in: 'none' })
    await call(goals({ member: null }), 'update_goal', { id: r.goal_id, progress: 'Half done' })
    const status = await call(goals({ member: null }), 'goal_status', { id: r.goal_id })
    expect(status).toMatchObject({ outcome: 'Room for the bikes', updates: [{ note: 'Half done', who: 'someone' }], check_in: 'none' })
    const [g] = (await call(goals({ member: null }), 'list_goals', {})).goals as Record<string, unknown>[]
    expect(String(g.latest_update)).toMatch(/^Half done \(someone, /)
    // A run with no member sees a group's goals, and nobody's private ones.
    expect(await call(goals({ member: null, chatId: '-999', shared: false }), 'goal_status', { id: r.goal_id })).toEqual({ error: `No goal ${r.goal_id} here.` })
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

describe('goals in the conversation', () => {
  it('are in the chat context, and bring the goal tools with them', async () => {
    const made = await call(goals(), 'create_goal', { title: 'Bali trip', target_date: inDays(30), steps: ['Price flights'] })
    const ambient = await ambientContext('-100', ctx.member, 'chat')
    expect(ambient.text).toContain(`- goal_id ${made.goal_id}: "Bali trip", 0 of 1 steps done, target `)
    expect(ambient.text).toContain('(30 days), next: Price flights')
    expect(ambient.activeGoals).toBe(true)
    expect(routeGroups('we booked the flights', { activeGoals: true })).toContain('goals')
    expect((await ambientContext('-200', ctx.member, 'chat')).activeGoals).toBe(false)
  })

  it('are cued by how people talk about them', () => {
    for (const said of ['we are saving for a new car', 'set a goal to run 5k', 'how is our progress?', 'aiming to finish by March']) {
      expect(routeGroups(said), said).toContain('goals')
    }
    expect(routeGroups('add milk to the list')).not.toContain('goals')
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
  it("lists the groups' goals and the viewer's own, with steps and the latest progress", async () => {
    const ada = await q.upsertMember('222', 'Ada', { allowed: true })
    const family = await call(goals(), 'create_goal', { title: 'Family trip', target_date: inDays(5), steps: ['Book flights', 'Pack'] })
    await call(goals({ chatId: '222', member: ada, shared: false }), 'create_goal', { title: "Ada's own", steps: [] })
    await call(goals({ chatId: '111', shared: false }), 'create_goal', { title: "Rowan's own", steps: [], target_date: inDays(1) })
    await call(goals(), 'update_goal', { id: family.goal_id, progress: 'Flights priced' })

    await call(goals(), 'create_goal', { title: 'Someday', outcome: 'A tidy shed', steps: [], check_in: 'none' })
    const rowan = await gatherFamilyStats(undefined, ctx.member!.id)
    expect(rowan.goals.map((g) => g.title)).toEqual(["Rowan's own", 'Family trip', 'Someday'])
    expect(rowan.goals[2]).toMatchObject({ outcome: 'A tidy shed', target: null, daysLeft: null, steps: [] })
    expect(rowan.goals[1]).toMatchObject({ daysLeft: 5, done: 0, latest: 'Flights priced', steps: [{ content: 'Book flights' }, { content: 'Pack' }] })
    const none = await gatherFamilyStats()
    expect(none.goals.map((g) => g.title)).toEqual(['Family trip', 'Someday'])
  })
})
