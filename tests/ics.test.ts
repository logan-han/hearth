import { describe, it, expect, vi } from 'vitest'
import type { FamilyEvent } from '@/lib/db/schema'

// The real ics library by default, so every other test exercises real output; a test
// that needs to force the error/no-output path overrides it just for that one call.
vi.mock('ics', async (orig) => {
  const actual = await orig<typeof import('ics')>()
  return { ...actual, createEvents: vi.fn(actual.createEvents) }
})
const { buildCalendar } = await import('@/lib/ics')
const { createEvents } = await import('ics')
// createEvents is overloaded (a callback form returns void); the mock always uses
// the synchronous (events, headerAttributes?) => ReturnObject form the app calls.
const mockedCreateEvents = createEvents as unknown as {
  mockReturnValueOnce: (v: { error: Error | null; value: string | null }) => void
}

const MEL = 'Australia/Melbourne'

function event(over: Partial<FamilyEvent> = {}): FamilyEvent {
  return {
    id: 1,
    uid: 'abc123@hearth',
    title: 'Soccer training',
    description: null,
    location: null,
    startsAt: new Date('2026-09-05T23:00:00Z'), // Sat 6 Sep, 9am Melbourne
    endsAt: new Date('2026-09-06T00:00:00Z'),
    allDay: false,
    createdBy: null,
    cancelled: false,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  } as FamilyEvent
}

/** Undo RFC 5545 line folding so assertions can match whole property lines. */
function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, '')
}

describe('buildCalendar', () => {
  it('emits a well-formed VCALENDAR', () => {
    const ics = unfold(buildCalendar([event()], 'Family', MEL))
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true)
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true)
    expect(ics).toContain('VERSION:2.0')
    expect(ics).toContain('BEGIN:VEVENT')
    expect(ics).toContain('END:VEVENT')
    expect(ics).toContain('UID:abc123@hearth')
    expect(ics).toContain('SUMMARY:Soccer training')
  })

  it('uses CRLF line endings throughout', () => {
    const ics = buildCalendar([event()], 'Family', MEL)
    expect(ics).toContain('\r\n')
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('writes timed events as UTC instants', () => {
    const ics = unfold(buildCalendar([event()], 'Family', MEL))
    expect(ics).toContain('DTSTART:20260905T230000Z')
    expect(ics).toContain('DTEND:20260906T000000Z')
  })

  it('writes all-day events as local dates without a time', () => {
    const ics = unfold(
      buildCalendar(
        [
          event({
            allDay: true,
            startsAt: new Date('2026-09-05T14:00:00Z'), // 6 Sep in Melbourne
            endsAt: new Date('2026-09-06T14:00:00Z'),
          }),
        ],
        'Family',
        MEL,
      ),
    )
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20260906/)
    expect(ics).not.toMatch(/DTSTART[^\r\n]*T\d{6}/)
  })

  it('marks cancelled events so subscribers remove them', () => {
    const ics = unfold(buildCalendar([event({ cancelled: true })], 'Family', MEL))
    expect(ics).toContain('STATUS:CANCELLED')
  })

  it('carries the calendar name and refresh hints', () => {
    const ics = unfold(buildCalendar([event()], 'Han Family', MEL))
    expect(ics).toContain('X-WR-CALNAME:Han Family')
    expect(ics.match(/X-WR-CALNAME:/g)).toHaveLength(1)
    expect(ics.match(/X-PUBLISHED-TTL:/g)).toHaveLength(1)
    expect(ics).toContain(`X-WR-TIMEZONE:${MEL}`)
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H')
  })

  it('returns a valid empty calendar when there are no events', () => {
    const ics = buildCalendar([], 'Family', MEL)
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('END:VCALENDAR')
    expect(ics).not.toContain('BEGIN:VEVENT')
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H')
  })

  it('escapes special characters in text fields', () => {
    const ics = unfold(
      buildCalendar([event({ title: 'Dinner; with, family', location: 'Home\\Kitchen' })], 'Family', MEL),
    )
    expect(ics).toContain('SUMMARY:Dinner\\; with\\, family')
    expect(ics).toContain('LOCATION:Home\\\\Kitchen')
  })

  it('bumps SEQUENCE when an event is updated', () => {
    const first = unfold(buildCalendar([event()], 'Family', MEL))
    const later = unfold(
      buildCalendar([event({ updatedAt: new Date('2026-08-02T00:00:00Z') })], 'Family', MEL),
    )
    const seq = (s: string) => Number(s.match(/SEQUENCE:(\d+)/)![1])
    expect(seq(later)).toBeGreaterThan(seq(first))
  })

  it('renders every event it is given', () => {
    const ics = buildCalendar(
      [event({ uid: 'a@hearth' }), event({ uid: 'b@hearth' }), event({ uid: 'c@hearth' })],
      'Family',
      MEL,
    )
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3)
  })

  it('throws whatever the ics library reports', () => {
    mockedCreateEvents.mockReturnValueOnce({ error: new Error('ics blew up'), value: null })
    expect(() => buildCalendar([event()], 'Family', MEL)).toThrow('ics blew up')
  })

  it('throws a fallback error when ics reports neither an error nor any output', () => {
    mockedCreateEvents.mockReturnValueOnce({ error: null, value: null })
    expect(() => buildCalendar([event()], 'Family', MEL)).toThrow('ICS generation produced no output')
  })

  it('adds the refresh hint even when ics has not already included one', () => {
    mockedCreateEvents.mockReturnValueOnce({ error: null, value: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n' })
    const ics = buildCalendar([event()], 'Family', MEL)
    expect(ics).toContain('BEGIN:VCALENDAR\r\nX-WR-TIMEZONE:')
    expect(ics).toContain('X-PUBLISHED-TTL:PT1H')
  })
})
