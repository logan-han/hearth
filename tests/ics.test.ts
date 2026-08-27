import { describe, it, expect } from 'vitest'
import { buildCalendar } from '@/lib/ics'
import type { FamilyEvent } from '@/lib/db/schema'

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
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT15M')
  })

  it('returns a valid empty calendar when there are no events', () => {
    const ics = buildCalendar([], 'Family', MEL)
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('END:VCALENDAR')
    expect(ics).not.toContain('BEGIN:VEVENT')
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
})
