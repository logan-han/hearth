import { describe, it, expect } from 'vitest'
import { schedulerPulse } from '@/lib/stats'

const now = new Date('2026-09-14T10:30:00Z')

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
