import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'
import { merge, freeSpans, nextQuarter } from '@/lib/free-time'
import { localToUtc, localDateKey, daysAfter } from '@/lib/cron'

const listEvents = vi.fn()
const clientsFor = vi.fn(async (_id: number) => [{ provider: 'google', listEvents }] as unknown[])
vi.mock('@/lib/providers', async (orig) => ({ ...(await orig<typeof import('@/lib/providers')>()), clientsFor: (id: number) => clientsFor(id) }))
type Person = { telegramUserId: string; name: string }
const presentIn = vi.hoisted(() => vi.fn(async (_chatId: string, people: Person[]) => people))
vi.mock('@/lib/headcount', () => ({ presentIn }))

const { calendarTools } = await import('@/lib/tools/calendar')

const at = (local: string) => localToUtc(local)
const span = (a: string, b: string) => ({ start: at(a), end: at(b) })

describe('free time, worked out in code', () => {
  it('merges busy spans that overlap or touch', () => {
    const merged = merge([span('2026-11-02T09:00', '2026-11-02T10:00'), span('2026-11-02T09:30', '2026-11-02T11:00'), span('2026-11-02T11:00', '2026-11-02T12:00'), span('2026-11-02T13:00', '2026-11-02T13:00')])
    expect(merged).toEqual([span('2026-11-02T09:00', '2026-11-02T12:00')])
    // Something wholly inside another changes nothing.
    expect(merge([span('2026-11-02T09:00', '2026-11-02T12:00'), span('2026-11-02T10:00', '2026-11-02T11:00')])).toEqual([span('2026-11-02T09:00', '2026-11-02T12:00')])
  })

  it('gives the stretches of each window nobody is busy in, long enough', () => {
    const windows = [span('2026-11-02T08:00', '2026-11-02T18:00'), span('2026-11-03T08:00', '2026-11-03T18:00')]
    const busy = [
      span('2026-11-02T07:00', '2026-11-02T09:00'),
      span('2026-11-02T12:00', '2026-11-02T12:30'),
      span('2026-11-02T17:45', '2026-11-03T09:00'),
      span('2026-11-03T10:00', '2026-11-03T19:00'),
    ]
    expect(freeSpans(windows, busy, 60)).toEqual([
      span('2026-11-02T09:00', '2026-11-02T12:00'),
      span('2026-11-02T12:30', '2026-11-02T17:45'),
      span('2026-11-03T09:00', '2026-11-03T10:00'),
    ])
    expect(freeSpans(windows, busy, 240)).toEqual([span('2026-11-02T12:30', '2026-11-02T17:45')])
    expect(freeSpans(windows, [], 60)).toEqual(windows)
  })

  it('starts a slot on the quarter hour', () => {
    expect(nextQuarter(new Date('2026-11-02T00:07:00Z')).toISOString()).toBe('2026-11-02T00:15:00.000Z')
    expect(nextQuarter(new Date('2026-11-02T00:15:00Z')).toISOString()).toBe('2026-11-02T00:15:00.000Z')
  })
})

describe('find_free_time', () => {
  let client: PGlite
  let ctx: ToolContext
  const call = (args: Record<string, unknown>, over: Partial<ToolContext> = {}) =>
    ((calendarTools({ ...ctx, ...over }) as Record<string, { execute: unknown }>).find_free_time.execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(
      { minutes: 60, everyone: false, earliest: '08:00', latest: '20:00', days: 'any', family_calendar: true, ...args },
      {},
    )
  // A fixed Monday well ahead, so "now" never trims the windows.
  const monday = '2027-03-01'
  const tuesday = daysAfter(monday, 1)

  beforeEach(async () => {
    vi.clearAllMocks()
    client = (await freshDb()).client
    const member = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.upsertMember('222', 'Ada', { allowed: true })
    ctx = { chatId: '-100', member, memberName: 'Rowan', now: new Date('2026-10-30T00:00:00Z'), notices: [], shared: true }
    listEvents.mockResolvedValue({ events: [], more: false })
  })
  afterEach(async () => closeDb(client))

  it("gives the gaps in the asker's own calendar and the family's, and lists the all-day entries by day", async () => {
    listEvents.mockResolvedValue({
      events: [
        { id: 'a', title: 'Dentist', start: at(`${monday}T09:00`).toISOString(), end: at(`${monday}T10:00`).toISOString(), allDay: false },
        { id: 'b', title: 'Holiday', start: monday, end: tuesday, allDay: true },
      ],
      more: false,
    })
    await q.addFamilyEvent({ title: 'Swimming', startsAt: at(`${monday}T16:00`), endsAt: at(`${monday}T17:00`), allDay: false, createdBy: null })
    await q.addFamilyEvent({ title: 'Birthday', startsAt: at(monday), endsAt: at(tuesday), allDay: true, createdBy: null })
    const gone = await q.addFamilyEvent({ title: 'Cancelled', startsAt: at(`${monday}T12:00`), endsAt: at(`${monday}T13:00`), allDay: false, createdBy: null })
    await q.cancelFamilyEvent(gone.id)

    const r = await call({ from: monday, to: monday, minutes: 120 })
    expect(r.checked).toEqual(["Rowan's Google Calendar", 'the family calendar'])
    expect(r.free).toEqual([
      { day: expect.stringContaining('1 Mar 2027'), from: '10:00 am', until: '4:00 pm', minutes: 360 },
      { day: expect.stringContaining('1 Mar 2027'), from: '5:00 pm', until: '8:00 pm', minutes: 180 },
    ])
    expect(r.all_day).toEqual([{ day: expect.stringContaining('1 Mar 2027'), on: ["Holiday (Rowan's Google Calendar)", 'Birthday (family calendar)'] }])
    expect(listEvents).toHaveBeenCalledWith(at(`${monday}T00:00`), at(`${tuesday}T00:00`))
  })

  it("reads everyone's calendars in a group, and keeps to the days and hours asked", async () => {
    const r = await call({ from: monday, to: daysAfter(monday, 6), everyone: true, days: 'weekends', earliest: '10:00', latest: '12:00', family_calendar: false })
    expect(clientsFor).toHaveBeenCalledTimes(2)
    expect(r.checked).toEqual(["Rowan's Google Calendar", "Ada's Google Calendar"])
    expect((r.free as { from: string; until: string }[]).map((f) => [f.from, f.until])).toEqual([['10:00 am', '12:00 pm'], ['10:00 am', '12:00 pm']])
    const weekdays = await call({ from: monday, to: daysAfter(monday, 6), days: 'weekdays', family_calendar: false })
    expect((weekdays.free as unknown[]).length).toBe(5)
  })

  it('offers nothing after the point a calendar could not be read past, and says so', async () => {
    listEvents.mockResolvedValue({
      events: [{ id: 'a', title: 'Busy', start: at(`${tuesday}T09:00`).toISOString(), end: at(`${tuesday}T10:00`).toISOString(), allDay: false }],
      more: true,
    })
    const r = await call({ from: monday, to: daysAfter(monday, 3) })
    expect((r.free as { day: string }[]).every((f) => !f.day.includes('3 Mar'))).toBe(true)
    expect(String(r.note)).toContain('held more events than could be read')
  })

  it('carries on past a calendar that will not answer, and lists only so many stretches', async () => {
    clientsFor.mockResolvedValueOnce([{ provider: 'google', listEvents: vi.fn(async () => { throw new Error('boom') }) }])
    const r = await call({ from: monday, to: daysAfter(monday, 20) })
    expect(r.could_not_read).toEqual(["Rowan's Google Calendar: boom"])
    expect(r.checked).toEqual(['the family calendar'])
    expect((r.free as unknown[]).length).toBe(12)
    expect(r.more_not_shown).toBe(9)
  })

  it('looks at a week from today by default, passes over an event with no end, and stops where the earliest cut-off listing stops', async () => {
    const day1 = localDateKey(new Date(Date.now() + 2 * 86_400_000))
    const day2 = daysAfter(day1, 1)
    clientsFor.mockResolvedValueOnce([
      { provider: 'google', listEvents: vi.fn(async () => ({ events: [{ id: 'x', title: 'Open-ended', start: at(`${day1}T09:00`).toISOString(), end: '', allDay: false }, { id: 'h', title: 'Holiday', start: day2, end: day2, allDay: true }], more: true })) },
      { provider: 'microsoft', listEvents: vi.fn(async () => ({ events: [{ id: 'y', title: 'Later', start: at(`${daysAfter(day1, 4)}T09:00`).toISOString(), end: at(`${daysAfter(day1, 4)}T10:00`).toISOString(), allDay: false }], more: true })) },
    ])
    const r = await call({ family_calendar: false }, { now: new Date() })
    // Nothing offered on or after the all-day entry the first listing stopped at.
    expect(String(r.note)).toContain('held more events than could be read')
    const days = (r.free as { day: string }[]).map((f) => f.day)
    expect(days.length).toBeGreaterThan(0)
    expect(listEvents).not.toHaveBeenCalled()
  })

  it('needs a known member to read their own calendar', async () => {
    await expect(call({ from: monday }, { member: null })).rejects.toThrow(/known family member/)
  })

  it('starts no sooner than the next quarter hour, today included', async () => {
    const now = new Date()
    const r = await call({ from: localDateKey(now), to: localDateKey(now), earliest: '00:00', latest: '23:59' }, { now })
    const free = r.free as { from: string }[]
    if (free.length) expect(free[0].from).toMatch(/:(00|15|30|45) [ap]m$/)
  })

  it('refuses what it cannot search, and anyone else\'s calendar outside a group or with a stranger in it', async () => {
    expect(await call({ from: 'Monday' })).toEqual({ error: 'Give the days as YYYY-MM-DD.' })
    expect(await call({ from: tuesday, to: monday })).toEqual({ error: 'The last day comes before the first.' })
    expect(await call({ from: monday, to: daysAfter(monday, 40) })).toEqual({ error: 'Look at 31 days at most at a time.' })
    expect(String((await call({ from: monday, earliest: '9am' })).error)).toContain('HH:mm')
    expect(String((await call({ from: monday, earliest: '18:00', latest: '09:00' })).error)).toContain('earliest first')
    expect(String((await call({ from: monday, everyone: true }, { shared: false })).error)).toContain('only in the family group')
    await q.rememberChat('-100', 'group', 'Family')
    await q.noteStranger('-100', { id: '9', name: 'Visitor' })
    expect(String((await call({ from: monday, everyone: true })).error)).toContain('Not while someone unrecognised')
  })

  it('says when there is nothing to read at all', async () => {
    clientsFor.mockResolvedValue([])
    expect(await call({ from: monday, family_calendar: false })).toEqual({ error: 'No calendar linked. Send /connect to link one.' })
    expect(String((await call({ from: monday, family_calendar: false, everyone: true })).error)).toContain('Nobody in this chat')
    presentIn.mockRejectedValueOnce(new Error('429'))
    expect(String((await call({ from: monday, everyone: true })).error)).toContain('Could not check who is in this chat: 429')
  })
})
