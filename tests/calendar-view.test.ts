import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { gatherCalendar } from '@/lib/stats'

let client: PGlite

beforeEach(async () => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.TIMEZONE = 'Australia/Melbourne'
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

const at = (iso: string) => new Date(iso)

describe('the month grid', () => {
  it('is Monday-first and always whole weeks', async () => {
    const { calendar } = await gatherCalendar('2026-09')
    expect(calendar.days.length % 7).toBe(0)
    // 1 Sept 2026 is a Tuesday, so Monday 31 Aug leads the grid.
    expect(calendar.days[0].date).toBe('2026-08-31')
    expect(calendar.days[0].inMonth).toBe(false)
  })

  it('is always six weeks tall, so month flicking never moves the page', async () => {
    // Sept 2026 needs five weeks, Aug 2026 six, Feb 2027 exactly four.
    for (const month of ['2026-09', '2026-08', '2027-02']) {
      expect((await gatherCalendar(month)).calendar.days.length).toBe(42)
    }
  })

  it('labels the month it was asked for and links either side', async () => {
    const { calendar } = await gatherCalendar('2026-09')
    expect(calendar.label).toBe('September 2026')
    expect(calendar.prev).toBe('2026-08')
    expect(calendar.next).toBe('2026-10')
  })

  it('rolls the year over at both ends', async () => {
    expect((await gatherCalendar('2026-01')).calendar.prev).toBe('2025-12')
    expect((await gatherCalendar('2026-12')).calendar.next).toBe('2027-01')
  })

  it('falls back to the current month for a missing or malformed value', async () => {
    const now = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit',
    }).format(new Date()).slice(0, 7)
    expect((await gatherCalendar(undefined)).calendar.key).toBe(now)
    expect((await gatherCalendar('rubbish')).calendar.key).toBe(now)
    expect((await gatherCalendar('2026-13-99')).calendar.key).toBe(now)
  })

  it('places a timed event on its Melbourne day, not its UTC one', async () => {
    // 22:30 UTC on 8 Sept is 8:30am on 9 Sept in Melbourne.
    await q.addFamilyEvent({
      title: 'Early start',
      startsAt: at('2026-09-08T22:30:00Z'),
      endsAt: at('2026-09-08T23:30:00Z'),
    })
    const { calendar } = await gatherCalendar('2026-09')
    const ninth = calendar.days.find((d) => d.date === '2026-09-09')!
    expect(ninth.events.map((e) => e.title)).toEqual(['Early start'])
    expect(calendar.days.find((d) => d.date === '2026-09-08')!.events).toEqual([])
  })

  it('shows a time for a timed event and none for an all-day one', async () => {
    await q.addFamilyEvent({
      title: 'Timed', startsAt: at('2026-09-09T23:00:00Z'), endsAt: at('2026-09-10T00:00:00Z'),
    })
    await q.addFamilyEvent({
      title: 'All day', allDay: true,
      startsAt: at('2026-09-09T14:00:00Z'), endsAt: at('2026-09-10T14:00:00Z'),
    })
    const { calendar } = await gatherCalendar('2026-09')
    const day = calendar.days.find((d) => d.date === '2026-09-10')!
    const timed = day.events.find((e) => e.title === 'Timed')!
    expect(timed.time).toMatch(/am|pm/)
    expect(day.events.find((e) => e.title === 'All day')!.time).toBeNull()
  })

  it('repeats a multi-day event on each of its days', async () => {
    await q.addFamilyEvent({
      title: 'School camp', allDay: true,
      startsAt: at('2026-09-14T14:00:00Z'),
      endsAt: at('2026-09-17T14:00:00Z'),
    })
    const { calendar } = await gatherCalendar('2026-09')
    const showing = calendar.days.filter((d) => d.events.some((e) => e.title === 'School camp'))
    expect(showing.map((d) => d.date)).toEqual(['2026-09-15', '2026-09-16', '2026-09-17'])
  })

  it('leaves a cancelled event off the grid', async () => {
    const e = await q.addFamilyEvent({
      title: 'Called off', startsAt: at('2026-09-10T00:00:00Z'), endsAt: at('2026-09-10T01:00:00Z'),
    })
    await q.cancelFamilyEvent(e.id)
    const { calendar } = await gatherCalendar('2026-09')
    expect(calendar.days.flatMap((d) => d.events)).toEqual([])
  })

  it('does not spill an event into a month it does not touch', async () => {
    await q.addFamilyEvent({
      title: 'October thing', startsAt: at('2026-10-05T00:00:00Z'), endsAt: at('2026-10-05T01:00:00Z'),
    })
    const { calendar } = await gatherCalendar('2026-09')
    expect(calendar.days.flatMap((d) => d.events)).toEqual([])
  })

  it('drops the time from an all-day entry in the next-up list', async () => {
    await q.addFamilyEvent({
      title: 'Term starts', allDay: true,
      startsAt: at('2099-01-01T13:00:00Z'), endsAt: at('2099-01-02T13:00:00Z'),
    })
    const { upcoming } = await gatherCalendar('2099-01')
    expect(upcoming[0].when).not.toMatch(/12:00 am/)
  })
})
