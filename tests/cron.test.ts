import { describe, it, expect } from 'vitest'
import { nextRun, isValidCron, localToUtc, tzOffsetMs, localDateKey, lastDay } from '@/lib/cron'

const MEL = 'Australia/Melbourne'

describe('nextRun in Australia/Melbourne', () => {
  it('fires Monday 7pm local, which is 09:00 UTC during AEDT', () => {
    // Fri 2 Jan 2026, Melbourne is UTC+11 (AEDT).
    const from = new Date('2026-01-02T00:00:00Z')
    const next = nextRun('0 19 * * 1', from, MEL)!
    expect(next.toISOString()).toBe('2026-01-05T08:00:00.000Z')
    expect(localHour(next)).toBe(19)
  })

  it('fires Monday 7pm local, which is 09:00 UTC during AEST', () => {
    // Winter: Melbourne is UTC+10 (AEST).
    const from = new Date('2026-07-01T00:00:00Z')
    const next = nextRun('0 19 * * 1', from, MEL)!
    expect(next.toISOString()).toBe('2026-07-06T09:00:00.000Z')
    expect(localHour(next)).toBe(19)
  })

  it('keeps the same local wall-clock time across the DST boundary', () => {
    // DST ends the first Sunday in April 2026 (5 April).
    const before = nextRun('0 7 * * *', new Date('2026-04-03T00:00:00Z'), MEL)!
    const after = nextRun('0 7 * * *', new Date('2026-04-07T00:00:00Z'), MEL)!
    expect(localHour(before)).toBe(7)
    expect(localHour(after)).toBe(7)
    // The UTC instant shifts by an hour even though local time does not.
    expect(after.getUTCHours()).toBe(before.getUTCHours() + 1)
  })

  it('advances strictly forward from the given instant', () => {
    const from = new Date('2026-03-10T05:00:00Z')
    const next = nextRun('*/5 * * * *', from, MEL)!
    expect(next.getTime()).toBeGreaterThan(from.getTime())
    expect(next.getTime() - from.getTime()).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  it('returns null for an expression that can never fire', () => {
    // 31 February never happens, so croner can never find a next occurrence.
    expect(nextRun('0 0 31 2 *', new Date('2026-01-01T00:00:00Z'), MEL)).toBeNull()
  })

  it('validates cron expressions', () => {
    expect(isValidCron('0 19 * * 1')).toBe(true)
    expect(isValidCron('*/5 * * * *')).toBe(true)
    expect(isValidCron('not a cron')).toBe(false)
    expect(isValidCron('99 99 * * *')).toBe(false)
  })
})

describe('localToUtc', () => {
  it('reads a summer wall-clock time as AEDT (UTC+11)', () => {
    expect(localToUtc('2026-01-15T09:00', MEL).toISOString()).toBe('2026-01-14T22:00:00.000Z')
  })

  it('reads a winter wall-clock time as AEST (UTC+10)', () => {
    expect(localToUtc('2026-07-15T09:00', MEL).toISOString()).toBe('2026-07-14T23:00:00.000Z')
  })

  it('accepts a space separator and a bare date', () => {
    expect(localToUtc('2026-07-15 09:00', MEL).toISOString()).toBe('2026-07-14T23:00:00.000Z')
    expect(localToUtc('2026-07-15', MEL).toISOString()).toBe('2026-07-14T14:00:00.000Z')
  })

  it('round-trips through localDateKey', () => {
    const utc = localToUtc('2026-11-03T08:30', MEL)
    expect(localDateKey(utc, MEL)).toBe('2026-11-03')
  })

  it('rejects unparseable input', () => {
    expect(() => localToUtc('next tuesday', MEL)).toThrow()
  })

  it('takes a time that carries its own Z or offset as that instant, not as household time', () => {
    // Microsoft's raw start for 9am on 14 October in Melbourne, copied across by the model.
    expect(localToUtc('2026-10-13T22:00:00.0000000Z', MEL).toISOString()).toBe('2026-10-13T22:00:00.000Z')
    expect(localToUtc('2026-10-14T09:00:00+11:00', MEL).toISOString()).toBe('2026-10-13T22:00:00.000Z')
    expect(localToUtc('2026-10-13T18:00-0400', MEL).toISOString()).toBe('2026-10-13T22:00:00.000Z')
  })

  it('refuses anything else after the time rather than dropping it', () => {
    expect(() => localToUtc('2026-10-14T09:00 AEDT', MEL)).toThrow()
    expect(() => localToUtc('2026-10-14T09:00pm', MEL)).toThrow()
  })
})

describe('lastDay', () => {
  it('is the day before an all-day end, and the start day for one that ends where it begins', () => {
    // 5 April 2026 in Melbourne runs 25 hours, midnight 13:00Z to midnight 14:00Z.
    expect(lastDay(new Date('2026-04-04T13:00:00Z'), new Date('2026-04-05T14:00:00Z'), MEL)).toBe('2026-04-05')
    expect(lastDay(new Date('2026-09-09T14:00:00Z'), new Date('2026-09-12T14:00:00Z'), MEL)).toBe('2026-09-12')
    expect(lastDay(new Date('2026-09-09T14:00:00Z'), new Date('2026-09-09T14:00:00Z'), MEL)).toBe('2026-09-10')
  })
})

describe('tzOffsetMs', () => {
  it('reports +11h in January and +10h in July', () => {
    expect(tzOffsetMs(new Date('2026-01-15T00:00:00Z'), MEL)).toBe(11 * 3600_000)
    expect(tzOffsetMs(new Date('2026-07-15T00:00:00Z'), MEL)).toBe(10 * 3600_000)
  })
})

function localHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: MEL, hour: '2-digit', hour12: false }).format(d),
  )
}
