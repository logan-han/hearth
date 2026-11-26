import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { describeWrite, noteActivity } from '@/lib/activity'
import { buildTools, type ToolContext } from '@/lib/tools'
import { activityLine } from '@/lib/tools/activity'
import { gatherFamilyStats } from '@/lib/stats'
import { localDateKey } from '@/lib/cron'

let client: PGlite
let ctx: ToolContext

const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})
const sam = () => q.saveMember({ name: 'Sam', email: 'sam@hearth.example', allowed: true, isAdmin: false })

beforeEach(async () => {
  client = (await freshDb()).client
  const member = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
  ctx = { member, memberName: 'Rowan', now: new Date(), via: 'mcp' }
})
afterEach(async () => closeDb(client))

describe('describeWrite', () => {
  it('words a write from what was asked and what came back', () => {
    expect(describeWrite('add_family_event', { title: 'Dentist' }, { title: 'Dentist', start_local: 'Tue 3 Nov, 9:00 am' }))
      .toBe('put "Dentist" on the family calendar, Tue 3 Nov, 9:00 am')
    expect(describeWrite('add_family_event', { title: 'Dentist' }, {})).toBe('put "Dentist" on the family calendar')
    expect(describeWrite('jira_create_issue', { summary: 'Fix gutter' }, { key: 'HTL-9', summary: 'Fix gutter' })).toBe('added HTL-9 "Fix gutter" to the board')
    expect(describeWrite('jira_create_issue', { summary: 'Fix gutter' }, { key: 'HTL-9' })).toBe('added HTL-9 "Fix gutter" to the board')
    expect(describeWrite('add_to_list', { items: ['milk', 'eggs'] }, { list: 'shopping', added: ['milk', 'eggs'] })).toBe('added milk, eggs to the shopping list')
    expect(describeWrite('add_to_list', { items: ['nails'], list: 'hardware' }, {})).toBe('added nails to the hardware list')
    expect(describeWrite('check_off_list', { items: ['milk'] }, { list: 'shopping', ticked_off: ['2L milk'] })).toBe('ticked off 2L milk on the shopping list')
    expect(describeWrite('check_off_list', { items: ['milk'], undo: true }, { list: 'shopping', unticked: ['2L milk'] })).toBe('put 2L milk back on the shopping list')
    expect(describeWrite('remember', { fact: 'Bin night is Monday' }, {})).toBe('remembered "Bin night is Monday"')
    expect(describeWrite('pause_automation', { id: 4, enabled: false }, {})).toBe('paused automation 4')
    expect(describeWrite('pause_automation', { id: 4, enabled: true }, {})).toBe('resumed automation 4')
    expect(describeWrite('create_automation', { label: 'bins' }, { next_run_local: 'Mon 2 Nov, 7:00 pm' })).toBe('set up "bins", first Mon 2 Nov, 7:00 pm')
    expect(describeWrite('answer_question', { id: 2 }, { kept: 'Ada is in year 4' })).toBe('kept "Ada is in year 4"')
    expect(describeWrite('answer_question', { id: 2 }, { dismissed: 2 })).toBe('settled question 2')
  })

  it('reads no posted line, since nothing is posted anywhere', () => {
    expect(describeWrite('add_family_event', { title: 'Dentist' }, { posted: 'Added to the family calendar: **Dentist**' })).toBe('put "Dentist" on the family calendar')
  })

  it('words every other write, from what came back or else from what was asked', () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
      ['update_family_event', { id: 4, title: 'Dentist' }, {}, 'changed "Dentist" on the family calendar'],
      ['update_family_event', { id: 4 }, { title: 'Dentist' }, 'changed "Dentist" on the family calendar'],
      ['update_family_event', { id: 4 }, {}, 'changed "event 4" on the family calendar'],
      ['cancel_family_event', { id: 4 }, { title: 'Dentist' }, 'cancelled "Dentist" on the family calendar'],
      ['cancel_family_event', { id: 4 }, {}, 'cancelled "event 4" on the family calendar'],
      ['propose_family_event', { title: 'Camp' }, {}, 'proposed "Camp" for the family calendar, waiting on a yes'],
      ['accept_event_proposal', { proposal_id: 2 }, { title: 'Camp' }, 'put "Camp" on the family calendar'],
      ['accept_event_proposal', { proposal_id: 2 }, {}, 'put "proposal 2" on the family calendar'],
      ['reject_event_proposal', { proposal_id: 2 }, {}, 'declined proposal 2'],
      ['check_off_list', { items: ['milk'], list: 'shop' }, {}, 'ticked off milk on the shop list'],
      ['check_off_list', { items: ['milk'], undo: true }, {}, 'put milk back on the shopping list'],
      ['remove_from_list', { ids: [1] }, { list: 'shopping', removed: ['milk'] }, 'removed milk from the shopping list'],
      ['remove_from_list', { ids: [1], list: 'hardware' }, {}, 'removed items from the hardware list'],
      ['clear_list', { list: 'shopping' }, { list: 'shopping', cleared: 3 }, 'cleared 3 item(s) from the shopping list'],
      ['clear_list', {}, {}, 'cleared the ticked item(s) from the shopping list'],
      ['forget', { id: 9 }, {}, 'forgot fact 9'],
      ['unsure', { question: 'Who is Sam?' }, {}, 'asked the family "Who is Sam?"'],
      ['create_calendar_event', { title: 'Gym' }, {}, 'added "Gym" to a personal calendar'],
      ['notion_append_to_page', { id: 'p' }, {}, 'added to a Notion page'],
      ['jira_update_issue', { key: 'HTL-1' }, {}, 'changed HTL-1 on the board'],
      ['jira_move_issue', { key: 'HTL-1', status: 'Done' }, {}, 'moved HTL-1 to Done'],
      ['jira_comment', { key: 'HTL-1' }, {}, 'commented on HTL-1'],
      ['create_automation', { label: 'bins' }, {}, 'set up "bins"'],
      ['delete_automation', { id: 5 }, {}, 'deleted automation 5'],
      ['create_helper', { name: 'Chef' }, {}, 'added the helper Chef'],
      ['save_routine', { name: 'Bins' }, {}, 'kept the routine "Bins"'],
      ['delete_routine', { name: 'Bins' }, {}, 'forgot the routine "Bins"'],
    ]
    for (const [tool, input, result, line] of cases) expect(describeWrite(tool, input, result), tool).toBe(line)
  })

  it('falls back to the tool, and keeps a line short', () => {
    expect(describeWrite('some_new_tool', null, null)).toBe('some new tool')
    const long = describeWrite('remember', { fact: 'x'.repeat(500) }, {})
    expect(long.length).toBeLessThanOrEqual(200)
    expect(describeWrite('add_to_list', { items: ['y'.repeat(300)] }, {})).toMatch(/…$/)
  })
})

describe('the activity log', () => {
  it('keeps every write that goes through, on the record of the member it was done for, with how', async () => {
    const tools = buildTools(ctx)
    await call(tools, 'add_to_list', { items: ['milk'], list: 'shopping' })
    await call(tools, 'remember', { fact: 'Bin night is Monday' })
    // A read changes nothing, and is not on record.
    await call(tools, 'show_list', { list: 'shopping' })
    // Nor is a write that failed.
    await call(tools, 'check_off_list', { items: ['bread'], list: 'nowhere' })

    const rows = await q.recentActivity({ memberId: ctx.member!.id })
    expect(rows.map((r) => [r.tool, r.summary, r.via, r.who])).toEqual([
      ['remember', 'remembered "Bin night is Monday"', 'mcp', 'Rowan'],
      ['add_to_list', 'added milk to the shopping list', 'mcp', 'Rowan'],
    ])
  })

  it('keeps nothing for a write that turned out to change nothing', async () => {
    const tools = buildTools(ctx)
    // A fact already known, a question already put, an event already there.
    await call(tools, 'remember', { fact: 'Bin night is Monday' })
    await call(tools, 'remember', { fact: 'Bin night is Monday by the way' })
    await call(tools, 'unsure', { question: 'Who is at Hillside?', fact: 'Juno attends Hillside' })
    await call(tools, 'unsure', { question: 'Who goes to Hillside?', fact: 'Juno attends Hillside' })
    await call(tools, 'add_family_event', { title: 'Soccer', start: '2026-12-05T09:00', all_day: false })
    await call(tools, 'add_family_event', { title: 'soccer', start: '2026-12-05T09:00', all_day: false })
    // A proposal already standing, and one still to be judged against the same day.
    const soon = localDateKey(new Date(Date.now() + 30 * 86_400_000))
    await call(tools, 'propose_family_event', { title: 'Swim carnival', start: soon, source: 'google:m1' })
    expect((await call(tools, 'propose_family_event', { title: 'Swim carnival', start: soon, source: 'google:m1' })).already_proposed).toBe(true)
    expect((await call(tools, 'propose_family_event', { title: 'Parent night', start: `${soon}T18:00` })).not_proposed_yet).toBe(true)
    expect((await q.recentActivity({ memberId: ctx.member!.id })).map((r) => r.tool)).toEqual([
      'propose_family_event', 'add_family_event', 'unsure', 'remember',
    ])
  })

  it('says how a run came to be: a scheduled job, a client, a click on Home', async () => {
    await call(buildTools({ ...ctx, via: 'watcher' }), 'add_to_list', { items: ['bread'], list: 'shopping' })
    await call(buildTools({ ...ctx, via: undefined }), 'add_to_list', { items: ['jam'], list: 'shopping' })
    const rows = await q.recentActivity({ memberId: ctx.member!.id })
    // A call that does not say how is an MCP client's, the only other way in.
    expect(rows.map((r) => [r.summary, r.via])).toEqual([['added jam to the shopping list', 'mcp'], ['added bread to the shopping list', 'watcher']])
  })

  it("files what a member's client changed on their own record, and shows it to them alone", async () => {
    await call(buildTools(ctx), 'remember', { fact: 'Bin night is Monday' })
    await call(buildTools(ctx), 'add_to_list', { items: ['jam'], list: 'shopping' })
    const own = await q.recentActivity({ memberId: ctx.member!.id })
    expect(own.map((r) => [r.tool, r.via])).toEqual([['add_to_list', 'mcp'], ['remember', 'mcp']])
    // Home shows it to its member, and to nobody else.
    const other = await sam()
    expect(await q.recentActivity({ memberId: other.id })).toEqual([])
    expect((await gatherFamilyStats(undefined, other.id)).activity).toEqual([])
    expect((await gatherFamilyStats(undefined, ctx.member!.id)).activity.map((a) => a.summary)).toContain('added jam to the shopping list')
  })

  it('is never the reason a write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await client.exec('drop table activity cascade')
    const r = await call(buildTools(ctx), 'add_to_list', { items: ['milk'], list: 'shopping' })
    expect(r.added).toEqual(['milk'])
    expect(warn).toHaveBeenCalledWith('[activity] could not record add_to_list:', expect.stringContaining('activity'))
    warn.mockRestore()
  })

  it('records directly too, with no member, and every member\'s record together for the admin pages', async () => {
    await noteActivity({ memberId: null, via: 'watcher', tool: 'remember', input: { fact: 'Ada is 8' }, result: {} })
    await noteActivity({ memberId: ctx.member!.id, via: 'web', tool: 'forget', input: { id: 2 }, result: {} })
    const all = await q.recentActivity()
    expect(all.map((r) => [r.summary, r.who])).toEqual([['forgot fact 2', 'Rowan'], ['remembered "Ada is 8"', null]])
    // Nobody's record holds the one with no member, Home's included.
    expect((await gatherFamilyStats()).activity).toEqual([])
    expect((await gatherFamilyStats(undefined, ctx.member!.id)).activity.map((a) => a.summary)).toEqual(['forgot fact 2'])
  })

  it('forgets what is older than ninety days', async () => {
    await noteActivity({ memberId: null, via: 'mcp', tool: 'remember', input: { fact: 'old' }, result: {} })
    await noteActivity({ memberId: null, via: 'mcp', tool: 'remember', input: { fact: 'new' }, result: {} })
    await client.query(`update activity set created_at = now() - interval '91 days' where summary like '%old%'`)
    expect(await q.pruneActivity(90)).toBe(1)
    expect((await q.recentActivity()).map((r) => r.summary)).toEqual(['remembered "new"'])
  })
})

describe('recent_activity', () => {
  it("lists the caller's own changes, newest first, and says so when there are none", async () => {
    expect(await call(buildTools(ctx), 'recent_activity', { limit: 5 })).toMatchObject({ activity: [], note: expect.stringContaining('Nothing has been changed in your name') })
    await call(buildTools(ctx), 'add_to_list', { items: ['milk'], list: 'shopping' })
    const other = await sam()
    await call(buildTools({ ...ctx, member: other, memberName: 'Sam' }), 'add_to_list', { items: ['secret'], list: 'shopping' })
    const r = await call(buildTools(ctx), 'recent_activity', { limit: 5 })
    expect(r.activity).toEqual([expect.stringMatching(/: added milk to the shopping list \(Rowan, through an MCP client\)$/)])
  })

  it('needs a member to say whose record to read', async () => {
    await expect(call(buildTools({ ...ctx, member: null }), 'recent_activity', { limit: 5 })).rejects.toThrow(/family member/)
  })

  it('says how each change came to be', () => {
    const at = new Date('2026-10-30T09:00:00Z')
    expect(activityLine({ createdAt: at, who: null, via: 'watcher', summary: 'x' })).toMatch(/: x \(Hearth, on a schedule\)$/)
    expect(activityLine({ createdAt: at, who: 'Ada', via: 'mcp', summary: 'x' })).toMatch(/\(Ada, through an MCP client\)$/)
    expect(activityLine({ createdAt: at, who: 'Ada', via: 'web', summary: 'x' })).toMatch(/\(Ada, on Home\)$/)
    expect(activityLine({ createdAt: at, who: 'Ada', via: 'other', summary: 'x' })).toMatch(/\(Ada, other\)$/)
  })
})

describe('Home lists what changed lately', () => {
  it("shows the viewer's own changes with how each was asked for, never another member's", async () => {
    const other = await sam()
    await noteActivity({ memberId: ctx.member!.id, via: 'mcp', tool: 'add_to_list', input: { items: ['milk'] }, result: {} })
    await noteActivity({ memberId: other.id, via: 'mcp', tool: 'remember', input: { fact: 'Private' }, result: {} })
    await noteActivity({ memberId: ctx.member!.id, via: 'web', tool: 'remember', input: { fact: 'mine' }, result: {} })
    await noteActivity({ memberId: ctx.member!.id, via: 'watcher', tool: 'add_to_list', input: { items: ['bread'] }, result: {} })

    const rowan = await gatherFamilyStats(undefined, ctx.member!.id)
    expect(rowan.activity.map((a) => [a.summary, a.how])).toEqual([
      ['added bread to the shopping list', 'by a scheduled job'],
      ['remembered "mine"', 'on Home'],
      ['added milk to the shopping list', 'through an MCP client'],
    ])
    expect((await gatherFamilyStats(undefined, other.id)).activity.map((a) => a.summary)).toEqual(['remembered "Private"'])
    // An admin signed in with no member row has no record of their own.
    expect((await gatherFamilyStats()).activity).toEqual([])
  })
})
