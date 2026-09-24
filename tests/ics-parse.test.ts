import { describe, it, expect } from 'vitest'
import { parseIcs, parseDuration, describeIcs } from '@/lib/ics-parse'

const MEL = 'Australia/Melbourne'

const wrap = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'X-WR-CALNAME:Scouts', ...events, 'END:VCALENDAR'].join('\r\n')

const vevent = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n')

describe('parseIcs', () => {
  it('reads an all-day event as the local day, ending the next midnight', () => {
    const { name, events } = parseIcs(wrap(vevent('UID:a@x', 'SUMMARY:Scouts Cuboree', 'DTSTART;VALUE=DATE:20260930', 'DTEND;VALUE=DATE:20261001')), MEL)
    expect(name).toBe('Scouts')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ uid: 'a@x', title: 'Scouts Cuboree', allDay: true, repeats: null })
    // Midnight 30 Sep in Melbourne (AEST, UTC+10) is 14:00 UTC the day before.
    expect(events[0].startsAt.toISOString()).toBe('2026-09-29T14:00:00.000Z')
    expect(events[0].endsAt.toISOString()).toBe('2026-09-30T14:00:00.000Z')
  })

  it('reads a UTC time as an instant and a TZID time in that zone', () => {
    const { events } = parseIcs(
      wrap(
        vevent('SUMMARY:Zulu', 'DTSTART:20260930T230000Z', 'DTEND:20261001T000000Z'),
        vevent('SUMMARY:Sydney', 'DTSTART;TZID=Australia/Sydney:20260930T090000', 'DTEND;TZID=Australia/Sydney:20260930T100000'),
      ),
      MEL,
    )
    const byTitle = Object.fromEntries(events.map((e) => [e.title, e]))
    expect(byTitle.Zulu.startsAt.toISOString()).toBe('2026-09-30T23:00:00.000Z')
    expect(byTitle.Zulu.allDay).toBe(false)
    expect(byTitle.Sydney.startsAt.toISOString()).toBe('2026-09-29T23:00:00.000Z')
  })

  it('reads a floating time, or a Windows zone name it does not know, as household time', () => {
    const { events } = parseIcs(
      wrap(
        vevent('SUMMARY:Floating', 'DTSTART:20260930T090000'),
        vevent('SUMMARY:Outlook', 'DTSTART;TZID="AUS Eastern Standard Time":20260930T090000'),
      ),
      MEL,
    )
    for (const e of events) expect(e.startsAt.toISOString()).toBe('2026-09-29T23:00:00.000Z')
  })

  it('takes DURATION when there is no DTEND, and defaults an hour or a day otherwise', () => {
    const { events } = parseIcs(
      wrap(
        vevent('SUMMARY:Ninety', 'DTSTART:20260930T090000Z', 'DURATION:PT1H30M'),
        vevent('SUMMARY:Hour', 'DTSTART:20260930T090000Z'),
        vevent('SUMMARY:Day', 'DTSTART;VALUE=DATE:20260930'),
        vevent('SUMMARY:Long day', 'DTSTART;VALUE=DATE:20260405'),
      ),
      MEL,
    )
    const span = (t: string) => {
      const e = events.find((x) => x.title === t)!
      return e.endsAt.getTime() - e.startsAt.getTime()
    }
    expect(span('Ninety')).toBe(90 * 60_000)
    // A date alone is a day by the calendar: 5 April 2026 is 25 hours long in Melbourne.
    expect(span('Long day')).toBe(25 * 3_600_000)
    expect(span('Hour')).toBe(3_600_000)
    expect(span('Day')).toBe(86_400_000)
  })

  it('unfolds long lines and unescapes text, ignoring an alarm inside the event', () => {
    const ics = wrap(
      vevent(
        'SUMMARY:Camp\\, pack the tent\; and gumboots',
        // A fold is CRLF plus one whitespace, and unfolding removes both; the
        // space that survives is the one before the fold, not the one after.
        'DESCRIPTION:Line one\\nLine two that is folded across ',
        ' the next physical line',
        'LOCATION:Gilwell Park',
        'DTSTART;VALUE=DATE:20260930',
        'BEGIN:VALARM',
        'TRIGGER:-PT15M',
        'DESCRIPTION:Reminder',
        'SUMMARY:Alarm summary must not win',
        'END:VALARM',
      ),
    )
    const [e] = parseIcs(ics, MEL).events
    expect(e.title).toBe('Camp, pack the tent; and gumboots')
    expect(e.description).toBe('Line one\nLine two that is folded across the next physical line')
    expect(e.location).toBe('Gilwell Park')
  })

  it('keeps a repeating event but marks it, and drops cancelled ones', () => {
    const { events, skipped } = parseIcs(
      wrap(
        vevent('SUMMARY:Weekly', 'DTSTART:20260930T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=4'),
        vevent('SUMMARY:Gone', 'DTSTART:20260930T090000Z', 'STATUS:CANCELLED'),
        vevent('SUMMARY:No start at all'),
      ),
      MEL,
    )
    expect(events.map((e) => e.title)).toEqual(['Weekly'])
    expect(events[0].repeats).toBe('FREQ=WEEKLY;COUNT=4')
    expect(skipped).toBe(2)
  })

  it('sorts by start and copes with an empty or foreign file', () => {
    const { events } = parseIcs(
      wrap(vevent('SUMMARY:Later', 'DTSTART;VALUE=DATE:20261002'), vevent('SUMMARY:Sooner', 'DTSTART;VALUE=DATE:20260930')),
      MEL,
    )
    expect(events.map((e) => e.title)).toEqual(['Sooner', 'Later'])
    expect(parseIcs('not a calendar at all', MEL)).toEqual({ name: null, events: [], skipped: 0 })
  })

  it('drops an event with an unparseable start, and defaults a sparse one that has an unparseable end', () => {
    const { events, skipped } = parseIcs(
      wrap(
        vevent('SUMMARY:No good start', 'DTSTART:not-a-date'),
        vevent('DTSTART:20260930T090000Z', 'DTEND:not-a-date'),
      ),
      MEL,
    )
    expect(skipped).toBe(1)
    expect(events).toHaveLength(1)
    // No SUMMARY at all falls back to a title, and an unreadable DTEND falls back to an hour.
    expect(events[0].title).toBe('(untitled)')
    expect(events[0].endsAt.getTime() - events[0].startsAt.getTime()).toBe(3_600_000)
  })

  it('ignores a parameter with no value, and reads an empty calendar name as none', () => {
    const ics = [
      'BEGIN:VCALENDAR', 'X-WR-CALNAME:', 'BEGIN:VEVENT', 'SUMMARY;WEIRD:Odd params', 'DTSTART;VALUE=DATE:20260930', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n')
    const { name, events } = parseIcs(ics, MEL)
    expect(name).toBeNull()
    expect(events[0].title).toBe('Odd params')
  })

  it('stops adding events past the cap and counts the rest as skipped', () => {
    const many = Array.from({ length: 205 }, (_, i) =>
      vevent(`SUMMARY:Event ${i}`, `DTSTART:202609${String(1 + (i % 28)).padStart(2, '0')}T090000Z`),
    )
    const { events, skipped } = parseIcs(wrap(...many), MEL)
    expect(events).toHaveLength(200)
    expect(skipped).toBe(5)
  })
})

describe('parseDuration', () => {
  it('reads days, times and weeks', () => {
    expect(parseDuration('P1D')).toBe(86_400_000)
    expect(parseDuration('PT1H30M')).toBe(5_400_000)
    expect(parseDuration('P2W')).toBe(14 * 86_400_000)
    expect(parseDuration('-PT15M')).toBe(-900_000)
    expect(parseDuration('soon')).toBeNull()
  })
})

describe('describeIcs', () => {
  it('lists the events in household time, numbered, with what the model needs', () => {
    const parsed = parseIcs(
      wrap(
        vevent('SUMMARY:Scouts Cuboree', 'DTSTART;VALUE=DATE:20260930', 'DTEND;VALUE=DATE:20261003', 'LOCATION:Gilwell Park'),
        vevent('SUMMARY:Pack night', 'DTSTART:20260928T080000Z', 'DTEND:20260928T090000Z', 'RRULE:FREQ=WEEKLY'),
      ),
      MEL,
    )
    const text = describeIcs(parsed, 'cuboree.ics', MEL)
    expect(text).toContain('Calendar file "cuboree.ics" (Scouts): 2 events.')
    expect(text).toContain('1. Pack night: Mon, 28 Sept 2026, 6:00 pm to Mon, 28 Sept 2026, 7:00 pm; repeats (FREQ=WEEKLY)')
    expect(text).toContain('2. Scouts Cuboree: Wed, 30 Sept 2026 (all day, 3 days); at Gilwell Park')
  })

  it('says so when there is nothing in it', () => {
    expect(describeIcs(parseIcs('', MEL), 'empty.ics', MEL)).toBe('Calendar file "empty.ics": 0 events.')
  })

  it('mentions unreadable entries left out, and a note from the description', () => {
    const parsed = parseIcs(
      wrap(
        vevent('SUMMARY:Pack night', 'DTSTART:20260928T080000Z', 'DTEND:20260928T090000Z', 'DESCRIPTION:Bring your own snacks'),
        vevent('SUMMARY:Gone', 'DTSTART:20260928T080000Z', 'STATUS:CANCELLED'),
      ),
      MEL,
    )
    const text = describeIcs(parsed, 'term.ics', MEL)
    expect(text).toContain('1 unreadable or cancelled entries left out')
    expect(text).toContain('note: Bring your own snacks')
  })
})
