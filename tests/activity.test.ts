import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { describeWrite, noteActivity } from '@/lib/activity'
import { buildTools, type ToolContext } from '@/lib/tools'
import { activityLine } from '@/lib/tools/activity'
import { gatherFamilyStats } from '@/lib/stats'

let client: PGlite
let ctx: ToolContext

const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})

beforeEach(async () => {
  client = (await freshDb()).client
  const member = await q.upsertMember('111', 'Rowan', { allowed: true })
  ctx = { chatId: '-100', member, memberName: 'Rowan', now: new Date(), notices: [], shared: true }
})
afterEach(async () => closeDb(client))

describe('describeWrite', () => {
  it("uses the line a tool posted in the chat, in plain words", () => {
    expect(describeWrite('add_family_event', { title: 'Dentist' }, { posted: 'Added to the family calendar: **Dentist** — Tue 3 Nov, 9:00 am' }))
      .toBe('Added to the family calendar: Dentist — Tue 3 Nov, 9:00 am')
  })

  it('words the rest from what was asked and what came back', () => {
    expect(describeWrite('add_to_list', { items: ['milk', 'eggs'] }, { list: 'shopping', added: ['milk', 'eggs'] })).toBe('added milk, eggs to the shopping list')
    expect(describeWrite('add_to_list', { items: ['nails'], list: 'hardware' }, {})).toBe('added nails to the hardware list')
    expect(describeWrite('check_off_list', { items: ['milk'] }, { list: 'shopping', ticked_off: ['2L milk'] })).toBe('ticked off 2L milk on the shopping list')
    expect(describeWrite('check_off_list', { items: ['milk'], undo: true }, { list: 'shopping', unticked: ['2L milk'] })).toBe('put 2L milk back on the shopping list')
    expect(describeWrite('remember', { fact: 'Bin night is Monday' }, {})).toBe('remembered "Bin night is Monday"')
    expect(describeWrite('draft_email', { to: ['a@b.com'], subject: 'Hello' }, {})).toBe('drafted an email to a@b.com, "Hello", waiting on a yes')
    expect(describeWrite('send_email', { draft_id: 3 }, { to: 'a@b.com', subject: 'Hello' })).toBe('sent the email to a@b.com, "Hello"')
    expect(describeWrite('pause_automation', { id: 4, enabled: false }, {})).toBe('paused automation 4')
    expect(describeWrite('pause_automation', { id: 4, enabled: true }, {})).toBe('resumed automation 4')
    expect(describeWrite('create_automation', { label: 'bins' }, { next_run_local: 'Mon 2 Nov, 7:00 pm' })).toBe('set up "bins", first Mon 2 Nov, 7:00 pm')
    expect(describeWrite('answer_question', { id: 2 }, { kept: 'Ada is in year 4' })).toBe('kept "Ada is in year 4"')
    expect(describeWrite('answer_question', { id: 2 }, { dismissed: 2 })).toBe('settled question 2')
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
      ['send_email', { draft_id: 3 }, {}, 'sent the email to draft 3, ""'],
      ['cancel_draft', { draft_id: 3 }, {}, 'discarded email draft 3'],
      ['create_calendar_event', { title: 'Gym' }, {}, 'added "Gym" to a personal calendar'],
      ['notion_append_to_page', { id: 'p' }, {}, 'added to a Notion page'],
      ['jira_update_issue', { key: 'HTL-1' }, {}, 'changed HTL-1 on the board'],
      ['jira_move_issue', { key: 'HTL-1', status: 'Done' }, {}, 'moved HTL-1 to Done'],
      ['jira_comment', { key: 'HTL-1' }, {}, 'commented on HTL-1'],
      ['jira_attach_email_file', { key: 'HTL-1', filename: 'notice.pdf' }, {}, 'attached notice.pdf to HTL-1'],
      ['create_automation', { label: 'bins' }, {}, 'set up "bins"'],
      ['delete_automation', { id: 5 }, {}, 'deleted automation 5'],
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
  it('keeps every write that goes through, with who asked, how, and where', async () => {
    const tools = buildTools(ctx)
    await call(tools, 'add_to_list', { items: ['milk'], list: 'shopping' })
    await call(tools, 'remember', { fact: 'Bin night is Monday' })
    // A read changes nothing, and is not on record.
    await call(tools, 'show_list', { list: 'shopping' })
    // Nor is a write that failed.
    await call(tools, 'check_off_list', { items: ['bread'], list: 'nowhere' })

    const rows = await q.recentActivity({ chatId: '-100' })
    expect(rows.map((r) => [r.tool, r.summary, r.via, r.who])).toEqual([
      ['remember', 'remembered "Bin night is Monday"', 'chat', 'Rowan'],
      ['add_to_list', 'added milk to the shopping list', 'chat', 'Rowan'],
    ])
  })

  it('says how a run came to be, and keeps a chat to its own', async () => {
    await call(buildTools({ ...ctx, via: 'watcher', member: null }), 'add_to_list', { items: ['bread'], list: 'shopping' })
    const here = await q.recentActivity({ chatId: '-100' })
    expect(here.map((r) => [r.summary, r.via, r.who])).toEqual([['added bread to the shopping list', 'watcher', null]])
  })

  it("files what an MCP client changed on its member's own record, though the client acts in the group", async () => {
    process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
    await q.saveConnection({ memberId: ctx.member!.id, provider: 'google', email: 'r@gmail.example', refreshToken: 'r', scopes: null })
    // As lib/mcp.ts runs a call: in the room the member last talked in, a group.
    const drafted = await call(buildTools({ ...ctx, chatId: '-100', via: 'mcp', shared: false }), 'draft_email', { to: ['clinic@example.org'], subject: 'Results', body: 'x' })
    expect(drafted.draft_id).toBeDefined()
    await call(buildTools({ ...ctx, chatId: '-100', via: 'mcp', shared: false }), 'add_to_list', { items: ['jam'], list: 'shopping' })
    expect(await q.recentActivity({ chatId: '-100' })).toEqual([])
    const own = await q.recentActivity({ chatId: '111' })
    expect(own.map((r) => [r.tool, r.via])).toEqual([['add_to_list', 'mcp'], ['draft_email', 'mcp']])
    // Home shows it to its member, and to nobody else.
    const sam = await q.upsertMember('222', 'Sam', { allowed: true })
    expect((await gatherFamilyStats(undefined, sam.id)).activity).toEqual([])
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

  it('records directly too, with no member, as the nightly pass does under its own id', async () => {
    await noteActivity({ chatId: 'memory-sweep', memberId: null, via: 'sweep', tool: 'remember', input: { fact: 'Ada is 8' }, result: {} })
    const [row] = await q.recentActivity()
    expect(row).toMatchObject({ via: 'sweep', summary: 'remembered "Ada is 8"', who: null })
    // Home shows what the nightly pass filed, as it shows the facts themselves to everyone.
    expect((await gatherFamilyStats()).activity).toEqual([
      expect.objectContaining({ summary: 'remembered "Ada is 8"', who: 'Hearth, on its own', chat: 'the nightly memory pass' }),
    ])
  })

  it('forgets what is older than ninety days', async () => {
    await noteActivity({ chatId: '-100', memberId: null, via: 'chat', tool: 'remember', input: { fact: 'old' }, result: {} })
    await noteActivity({ chatId: '-100', memberId: null, via: 'chat', tool: 'remember', input: { fact: 'new' }, result: {} })
    await client.query(`update activity set created_at = now() - interval '91 days' where summary like '%old%'`)
    expect(await q.pruneActivity(90)).toBe(1)
    expect((await q.recentActivity()).map((r) => r.summary)).toEqual(['remembered "new"'])
  })
})

describe('recent_activity', () => {
  it("lists this chat's changes, newest first, and says so when there are none", async () => {
    expect(await call(buildTools(ctx), 'recent_activity', { limit: 5 })).toMatchObject({ activity: [], note: expect.stringContaining('Nothing has been changed') })
    await call(buildTools(ctx), 'add_to_list', { items: ['milk'], list: 'shopping' })
    await call(buildTools({ ...ctx, chatId: '-200' }), 'add_to_list', { items: ['secret'], list: 'shopping' })
    const r = await call(buildTools(ctx), 'recent_activity', { limit: 5 })
    expect(r.activity).toEqual([expect.stringMatching(/: added milk to the shopping list \(Rowan, asked in the chat\)$/)])
  })

  it('names who did it, or that nobody asked', () => {
    const at = new Date('2026-10-30T09:00:00Z')
    expect(activityLine({ createdAt: at, who: null, via: 'watcher', summary: 'x' })).toMatch(/: x \(Hearth, on a schedule\)$/)
    expect(activityLine({ createdAt: at, who: null, via: 'sweep', summary: 'x' })).toMatch(/\(Hearth, in the nightly memory pass\)$/)
    expect(activityLine({ createdAt: at, who: null, via: 'mcp', summary: 'x' })).toMatch(/\(someone, through an MCP client\)$/)
    expect(activityLine({ createdAt: at, who: 'Ada', via: 'other', summary: 'x' })).toMatch(/\(Ada, other\)$/)
  })
})

describe('Home lists what changed lately', () => {
  it("shows the family's groups and the viewer's own chats, never another member's private chat", async () => {
    const ada = await q.upsertMember('222', 'Ada', { allowed: true })
    await q.rememberChat('-100', 'group', 'Family')
    await noteActivity({ chatId: '-100', memberId: ctx.member!.id, via: 'chat', tool: 'add_to_list', input: { items: ['milk'] }, result: {} })
    await noteActivity({ chatId: '222', memberId: ada.id, via: 'chat', tool: 'draft_email', input: { to: ['x@y.com'], subject: 'Private' }, result: {} })
    await noteActivity({ chatId: '111', memberId: ctx.member!.id, via: 'chat', tool: 'remember', input: { fact: 'mine' }, result: {} })
    await noteActivity({ chatId: '-100', memberId: null, via: 'watcher', tool: 'add_to_list', input: { items: ['bread'] }, result: {} })

    const rowan = await gatherFamilyStats(undefined, ctx.member!.id)
    expect(rowan.activity.map((a) => [a.summary, a.who, a.chat])).toEqual([
      ['added bread to the shopping list', 'Hearth, on its own', 'Family'],
      ['remembered "mine"', 'Rowan', 'Rowan'],
      ['added milk to the shopping list', 'Rowan', 'Family'],
    ])
    const ada2 = await gatherFamilyStats(undefined, ada.id)
    expect(ada2.activity.map((a) => a.summary)).toContain('drafted an email to x@y.com, "Private", waiting on a yes')
    // An admin signed in with no member row sees the groups alone.
    expect((await gatherFamilyStats()).activity.map((a) => a.summary)).toEqual(['added bread to the shopping list', 'added milk to the shopping list'])
  })

  it('says someone when the member has gone', async () => {
    await noteActivity({ chatId: '-100', memberId: null, via: 'mcp', tool: 'add_to_list', input: { items: ['tea'] }, result: {} })
    expect((await gatherFamilyStats()).activity[0]).toMatchObject({ who: 'someone', chat: '-100' })
  })
})
