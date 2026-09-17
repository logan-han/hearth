import { describe, it, expect } from 'vitest'
import {
  schedulerPulse, tickCadence, onGrid, nextTickOnOrAfter, fitsGrid, suggestAligned, describeGrid, type TickGrid,
} from '@/lib/scheduler'

const TZ = 'Australia/Melbourne'
const now = new Date('2026-09-14T10:30:00Z')
// Ticks as QStash has been making them: hourly on the hour, or every quarter.
const hourly = tickCadence('2026-09-14T10:00:01Z', '2026-09-14T09:00:00Z') as TickGrid
const quarterly = tickCadence('2026-09-14T10:00:00Z', '2026-09-14T09:45:01Z') as TickGrid

describe('the tick grid', () => {
  it('is read off the last two ticks, and unknown before then', () => {
    expect(hourly.everyMinutes).toBe(60)
    expect(quarterly.everyMinutes).toBe(15)
    expect(tickCadence('2026-09-14T10:00:00Z', null)).toBeNull()
    expect(tickCadence('2026-09-14T10:00:00Z', '2026-09-14T10:00:00Z')).toBeNull()
  })

  it('knows which minutes a tick lands on', () => {
    expect(onGrid(hourly, new Date('2026-09-15T22:00:00Z'))).toBe(true)
    expect(onGrid(hourly, new Date('2026-09-15T21:45:00Z'))).toBe(false)
    expect(onGrid(quarterly, new Date('2026-09-15T21:45:00Z'))).toBe(true)
    expect(nextTickOnOrAfter(hourly, new Date('2026-09-15T21:45:00Z'))).toEqual(new Date('2026-09-15T22:00:00Z'))
    expect(nextTickOnOrAfter(hourly, new Date('2026-09-15T22:00:30Z'))).toEqual(new Date('2026-09-15T22:00:00Z'))
  })

  it('accepts schedules on the grid and reports the first miss of one off it', () => {
    expect(fitsGrid(hourly, '0 8 * * *', now, TZ)).toEqual({ fits: true })
    expect(fitsGrid(hourly, '0 9-22 * * *', now, TZ)).toEqual({ fits: true })
    expect(fitsGrid(hourly, '45 7 * * *', now, TZ)).toEqual({
      fits: false,
      due: new Date('2026-09-14T21:45:00Z'),
      runs: new Date('2026-09-14T22:00:00Z'),
    })
    expect(fitsGrid(hourly, '*/5 * * * *', now, TZ).fits).toBe(false)
    expect(fitsGrid(quarterly, '45 7 * * *', now, TZ)).toEqual({ fits: true })
    expect(fitsGrid(quarterly, '50 7 * * *', now, TZ).fits).toBe(false)
  })

  it('suggests the nearest schedule that lines up', () => {
    expect(suggestAligned(hourly, '45 7 * * *', now, TZ)).toBe('0 8 * * *')
    expect(suggestAligned(hourly, '*/5 * * * *', now, TZ)).toBe('0 * * * *')
    expect(suggestAligned(hourly, '30 9-22 * * *', now, TZ)).toBe('0 9-22 * * *')
    expect(suggestAligned(hourly, '45 23 * * *', now, TZ)).toBe('0 0 * * *')
    // With a day named, rolling into the next hour would move the day, so it rounds down.
    expect(suggestAligned(hourly, '45 23 * * 1', now, TZ)).toBe('0 23 * * 1')
    expect(suggestAligned(quarterly, '50 7 * * *', now, TZ)).toBe('0 8 * * *')
    expect(suggestAligned(quarterly, '*/5 * * * *', now, TZ)).toBe('0,15,30,45 * * * *')
  })

  it('describes the grid in the household clock', () => {
    expect(describeGrid(hourly, TZ)).toBe('hourly, on the hour')
    expect(describeGrid(quarterly, TZ)).toBe('every 15 minutes, at :00, :15, :30, :45')
    // Adelaide sits half an hour off UTC, so an on-the-hour UTC tick is half past there.
    expect(describeGrid(hourly, 'Australia/Adelaide')).toBe('hourly, at 30 past')
  })
})

describe('the scheduler pulse', () => {
  it('has nothing to judge before the first tick', () => {
    expect(schedulerPulse(null, null, now)).toEqual({ lastTick: null, minutesAgo: null, everyMinutes: null, stale: true })
  })

  it('assumes five minutes until a second tick shows the cadence', () => {
    expect(schedulerPulse('2026-09-14T10:20:00Z', null, now)).toMatchObject({ minutesAgo: 10, everyMinutes: null, stale: false })
    expect(schedulerPulse('2026-09-14T10:14:00Z', null, now)).toMatchObject({ minutesAgo: 16, stale: true })
  })

  it('judges an hourly schedule by the hour, not by five minutes', () => {
    expect(schedulerPulse('2026-09-14T10:00:01Z', '2026-09-14T09:00:00Z', now)).toMatchObject({ minutesAgo: 30, everyMinutes: 60, stale: false })
    expect(schedulerPulse('2026-09-14T07:00:00Z', '2026-09-14T06:00:00Z', now).stale).toBe(true)
  })

  it('still flags a five-minute schedule after three missed ticks', () => {
    expect(schedulerPulse('2026-09-14T10:14:00Z', '2026-09-14T10:09:00Z', now)).toMatchObject({ everyMinutes: 5, stale: true })
  })

  it('never takes two ticks close together as the cadence', () => {
    expect(schedulerPulse('2026-09-14T10:20:00Z', '2026-09-14T10:19:30Z', now)).toMatchObject({ everyMinutes: 5, stale: false })
  })
})
