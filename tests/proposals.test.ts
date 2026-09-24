import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EventProposal } from '@/lib/db/schema'

let rows: EventProposal[] = []
let nextId = 1

const proposalForSource = vi.fn(async (source: string) => rows.find((r) => r.source === source))
const addProposal = vi.fn(async (input: Record<string, unknown>) => {
  const row = { id: nextId++, status: 'pending', ...input } as unknown as EventProposal
  rows.push(row)
  return row
})
const pendingProposals = vi.fn(async () => rows.filter((r) => r.status === 'pending'))
const settleProposal = vi.fn(async (id: number, status: string) => {
  const row = rows.find((r) => r.id === id && r.status === 'pending')
  if (!row) return undefined
  row.status = status
  return row
})
const addFamilyEvent = vi.fn(async (i: Record<string, unknown>) => ({ id: 99, ...i }))
const listFamilyEvents = vi.fn(async () => [] as unknown[])

vi.mock('@/lib/db/queries', () => ({ proposalForSource, addProposal, pendingProposals, settleProposal, addFamilyEvent, listFamilyEvents }))

const { proposalTools } = await import('@/lib/tools/proposals')

const ctx = { chatId: '-100999', member: { id: 3 }, memberName: 'Rowan', now: new Date(), notices: [] as string[] }
const tools = proposalTools(ctx as never)
const run = (name: keyof ReturnType<typeof proposalTools>, args: unknown) =>
  (tools[name].execute as unknown as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})

const NOTICE = {
  title: 'School photo day',
  start: '2026-09-09T09:00',
  all_day: false,
  location: 'Brighton Primary',
  source: 'google:18f2ab',
}

beforeEach(() => {
  rows = []
  nextId = 1
  ctx.notices.length = 0
  vi.clearAllMocks()
  listFamilyEvents.mockResolvedValue([])
})

describe('propose_family_event', () => {
  it('stores a proposal rather than adding the event', async () => {
    const r = await run('propose_family_event', NOTICE)
    expect(r.proposal_id).toBe(1)
    expect(addFamilyEvent).not.toHaveBeenCalled()
    expect(String(r.next_step)).toContain('Do not add it yourself')
  })

  it('reads a date alone as all day, a whole local day long even on the day the clocks go back', async () => {
    const r = await run('propose_family_event', { title: 'Swap day', start: '2026-04-05', all_day: false, source: 'google:swap' })
    const row = rows.at(-1)!
    expect(row.allDay).toBe(true)
    // Melbourne midnight on 5 April 2026 is 13:00 UTC the day before, and the day is 25 hours long.
    expect((row.startsAt as Date).toISOString()).toBe('2026-04-04T13:00:00.000Z')
    expect((row.endsAt as Date).getTime() - (row.startsAt as Date).getTime()).toBe(25 * 3_600_000)
    expect(r).toMatchObject({ all_day: true, start_local: 'Sun, 5 Apr 2026' })
  })

  it('reads the local time as Melbourne, not UTC', async () => {
    await run('propose_family_event', NOTICE)
    // 9am on 9 Sep in Melbourne is 23:00 UTC the day before (AEST, UTC+10).
    expect((rows[0].startsAt as Date).toISOString()).toBe('2026-09-08T23:00:00.000Z')
  })

  it('defaults the end to an hour after the start', async () => {
    await run('propose_family_event', NOTICE)
    expect(rows[0].endsAt.getTime() - rows[0].startsAt.getTime()).toBe(3_600_000)
  })

  it('gives an all-day event a full day', async () => {
    await run('propose_family_event', { ...NOTICE, start: '2026-09-09', all_day: true })
    expect(rows[0].endsAt.getTime() - rows[0].startsAt.getTime()).toBe(86_400_000)
  })

  it('refuses to propose the same email twice', async () => {
    await run('propose_family_event', NOTICE)
    const again = await run('propose_family_event', NOTICE)
    expect(again.skipped).toBe(true)
    expect(rows).toHaveLength(1)
  })

  it('holds a same-day repeat for judgement instead of proposing blind', async () => {
    await run('propose_family_event', { ...NOTICE, source: undefined })
    const again = await run('propose_family_event', {
      ...NOTICE, title: 'Photo day (school notice)', source: undefined,
    })
    expect(again.not_proposed_yet).toBe(true)
    const listed = (again.that_day_already_has as { awaiting_yes: { title: string }[] }).awaiting_yes
    expect(listed.map((p) => p.title)).toEqual(['School photo day'])
    expect(rows).toHaveLength(1)
  })

  it('proposes a judged-distinct event on a busy day', async () => {
    await run('propose_family_event', { ...NOTICE, source: undefined })
    const r = await run('propose_family_event', {
      ...NOTICE, title: 'Swimming carnival', source: undefined, confirmed_distinct: true,
    })
    expect(r.proposal_id).toBe(2)
    expect(rows).toHaveLength(2)
  })

  it('honours an explicit end time instead of defaulting the duration', async () => {
    await run('propose_family_event', { ...NOTICE, end: '2026-09-09T11:00', source: 'google:with-end' })
    expect(rows[0].endsAt.toISOString()).toBe('2026-09-09T01:00:00.000Z')
  })

  it('records no member for both proposing and accepting when nobody is attributed', async () => {
    const guestCtx = { ...ctx, member: null }
    const guestTools = proposalTools(guestCtx as never)
    const exec = (name: keyof ReturnType<typeof proposalTools>, args: unknown) =>
      (guestTools[name].execute as unknown as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})
    await exec('propose_family_event', { ...NOTICE, source: 'google:guest' })
    expect(rows[0].memberId).toBeNull()
    const r = await exec('accept_event_proposal', { proposal_id: rows[0].id })
    expect(r.added).toBe(true)
    expect(addFamilyEvent).toHaveBeenCalledWith(expect.objectContaining({ createdBy: null }))
  })

  it('hands the model whatever the calendar already holds that day', async () => {
    listFamilyEvents.mockResolvedValue([
      { id: 32, title: "Junior School Father's Day Breakfast", startsAt: new Date('2026-09-08T21:30:00Z'), cancelled: false, location: 'Junior Schools' },
    ] as never)
    const r = await run('propose_family_event', { ...NOTICE, title: "Riverbend Junior School Fathers' Day Brekky" })
    expect(r.not_proposed_yet).toBe(true)
    const cal = (r.that_day_already_has as { on_calendar: { title: string }[] }).on_calendar
    expect(cal[0].title).toContain("Father's Day Breakfast")
    expect(rows).toHaveLength(0)
  })
})

describe('accepting and rejecting', () => {
  it('adds the event to the family calendar and announces it', async () => {
    await run('propose_family_event', NOTICE)
    const r = await run('accept_event_proposal', { proposal_id: 1 })
    expect(r.added).toBe(true)
    expect(addFamilyEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'School photo day' }))
    expect(ctx.notices.join(' ')).toContain('School photo day')
    expect(r.posted).toBe(ctx.notices[0])
    expect(r.note).toMatch(/do not say the same thing again.*few hours/i)
  })

  it('cannot add the same proposal twice', async () => {
    await run('propose_family_event', NOTICE)
    await run('accept_event_proposal', { proposal_id: 1 })
    const again = await run('accept_event_proposal', { proposal_id: 1 })
    expect(again.error).toBeDefined()
    expect(addFamilyEvent).toHaveBeenCalledTimes(1)
  })

  it('a rejected proposal cannot then be accepted', async () => {
    await run('propose_family_event', NOTICE)
    await run('reject_event_proposal', { proposal_id: 1 })
    const r = await run('accept_event_proposal', { proposal_id: 1 })
    expect(r.error).toBeDefined()
    expect(addFamilyEvent).not.toHaveBeenCalled()
  })

  it('holds a yes when the calendar has since gained a same-day entry', async () => {
    await run('propose_family_event', NOTICE)
    listFamilyEvents.mockResolvedValue([
      { id: 5, title: 'Photo day', startsAt: new Date('2026-09-08T23:00:00Z'), cancelled: false, location: null },
    ] as never)
    const held = await run('accept_event_proposal', { proposal_id: 1 })
    expect(held.held).toBe(true)
    expect(addFamilyEvent).not.toHaveBeenCalled()
    const r = await run('accept_event_proposal', { proposal_id: 1, confirmed_distinct: true })
    expect(r.added).toBe(true)
  })

  it('says so when rejecting a proposal that is not pending', async () => {
    const r = await run('reject_event_proposal', { proposal_id: 999 })
    expect(String(r.error)).toContain('not pending')
  })

  it('lists only what is still waiting', async () => {
    await run('propose_family_event', NOTICE)
    await run('propose_family_event', { ...NOTICE, title: 'Athletics carnival', start: '2026-09-10T09:00', source: 'google:other' })
    await run('accept_event_proposal', { proposal_id: 1 })
    const r = await run('list_event_proposals', {})
    expect((r.proposals as { title: string }[]).map((p) => p.title)).toEqual(['Athletics carnival'])
  })
})
