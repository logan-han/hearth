import { describe, it, expect } from 'vitest'
import { parseIcs, parseDuration, describeIcs } from '@/lib/ics-parse'

const MEL = 'Australia/Melbourne'

const wrap = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'X-WR-CALNAME:Scouts', ...events, 'END:VCALENDAR'].join('\r\n')

const vevent = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n')

/** A VTIMEZONE as Outlook writes one: a Windows name, and a rule for each change of the clocks. */
const vtimezone = (id: string, ...rules: string[][]) =>
  ['BEGIN:VTIMEZONE', `TZID:${id}`, ...rules.flat(), 'END:VTIMEZONE'].join('\r\n')
const rule = (kind: 'STANDARD' | 'DAYLIGHT', start: string, from: string, to: string, rrule?: string) => [
  `BEGIN:${kind}`, `DTSTART:${start}`, `TZOFFSETFROM:${from}`, `TZOFFSETTO:${to}`, ...(rrule ? [`RRULE:${rrule}`] : []), `END:${kind}`,
]

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

  it('reads a floating time, or a Windows zone name the file does not define, as household time, and notes the guess', () => {
    const { events, unknownZones } = parseIcs(
      wrap(
        vevent('SUMMARY:Floating', 'DTSTART:20260930T090000'),
        vevent('SUMMARY:Outlook', 'DTSTART;TZID="AUS Eastern Standard Time":20260930T090000'),
      ),
      MEL,
    )
    for (const e of events) expect(e.startsAt.toISOString()).toBe('2026-09-29T23:00:00.000Z')
    expect(unknownZones).toEqual(['AUS Eastern Standard Time'])
  })

  it('reads a Windows zone name by the VTIMEZONE the file gives for it, wherever in the file that sits', () => {
    const perth = vtimezone('W. Australia Standard Time', rule('STANDARD', '16010101T000000', '+0800', '+0800'))
    const pacific = vtimezone(
      'Pacific Standard Time',
      rule('STANDARD', '16010101T020000', '-0700', '-0800', 'FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11'),
      rule('DAYLIGHT', '16010101T020000', '-0800', '-0700', 'FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3'),
    )
    const { events, unknownZones } = parseIcs(
      wrap(
        perth,
        vevent('SUMMARY:Perth', 'DTSTART;TZID="W. Australia Standard Time":20261210T090000', 'DTEND;TZID="W. Australia Standard Time":20261210T100000'),
        vevent('SUMMARY:LA summer', 'DTSTART;TZID="Pacific Standard Time":20260715T090000'),
        vevent('SUMMARY:LA winter', 'DTSTART;TZID="Pacific Standard Time":20261210T090000'),
        pacific,
      ),
      MEL,
    )
    const at = Object.fromEntries(events.map((e) => [e.title, e.startsAt.toISOString()]))
    // 9am in Perth is 01:00 UTC, not Melbourne's 9am three hours earlier.
    expect(at.Perth).toBe('2026-12-10T01:00:00.000Z')
    expect(events.find((e) => e.title === 'Perth')!.endsAt.toISOString()).toBe('2026-12-10T02:00:00.000Z')
    // Los Angeles is seven hours behind UTC in July and eight in December.
    expect(at['LA summer']).toBe('2026-07-15T16:00:00.000Z')
    expect(at['LA winter']).toBe('2026-12-10T17:00:00.000Z')
    expect(unknownZones).toEqual([])
  })

  it('follows a zone\'s rules across the new year, a last Sunday, and a fifth Sunday the month lacks', () => {
    const sydney = vtimezone(
      'Customized Time Zone',
      rule('STANDARD', '16010101T030000', '+1100', '+1000', 'FREQ=YEARLY;BYDAY=1SU;BYMONTH=4'),
      rule('DAYLIGHT', '16010101T020000', '+1000', '+1100', 'FREQ=YEARLY;BYDAY=1SU;BYMONTH=10'),
    )
    // Britain changes on the last Sunday of March and of October; older
    // Outlook writes the October one as a fifth Sunday, which 2026 lacks.
    const london = vtimezone(
      'GMT Standard Time',
      rule('DAYLIGHT', '16010101T010000', '+0000', '+0100', 'FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3'),
      rule('STANDARD', '16010101T020000', '+0100', '+0000', 'FREQ=YEARLY;BYDAY=5SU;BYMONTH=10'),
    )
    const { events } = parseIcs(
      wrap(
        sydney,
        london,
        vevent('SUMMARY:New year', 'DTSTART;TZID=Customized Time Zone:20260105T090000'),
        vevent('SUMMARY:Winter', 'DTSTART;TZID=Customized Time Zone:20260715T090000'),
        vevent('SUMMARY:Saturday', 'DTSTART;TZID=GMT Standard Time:20260328T120000'),
        vevent('SUMMARY:Sunday', 'DTSTART;TZID=GMT Standard Time:20260329T120000'),
        vevent('SUMMARY:Last October Saturday', 'DTSTART;TZID=GMT Standard Time:20261024T120000'),
        vevent('SUMMARY:Last October Sunday', 'DTSTART;TZID=GMT Standard Time:20261025T120000'),
      ),
      'America/New_York',
    )
    const at = Object.fromEntries(events.map((e) => [e.title, e.startsAt.toISOString()]))
    // Early January is still under the daylight rule that began last October.
    expect(at['New year']).toBe('2026-01-04T22:00:00.000Z')
    expect(at.Winter).toBe('2026-07-14T23:00:00.000Z')
    expect(at.Saturday).toBe('2026-03-28T12:00:00.000Z')
    expect(at.Sunday).toBe('2026-03-29T11:00:00.000Z')
    expect(at['Last October Saturday']).toBe('2026-10-24T11:00:00.000Z')
    expect(at['Last October Sunday']).toBe('2026-10-25T12:00:00.000Z')
  })

  it('stops a zone rule at its UNTIL, so a changed law does not linger', () => {
    // Melbourne's daylight saving ended on the last Sunday of March until
    // 2007, and on the first Sunday of April since 2008.
    const zone = vtimezone(
      'Old and new',
      rule('STANDARD', '19950326T030000', '+1100', '+1000', 'FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3;UNTIL=20070324T160000Z'),
      rule('STANDARD', '20080406T030000', '+1100', '+1000', 'FREQ=YEARLY;BYDAY=1SU;BYMONTH=4'),
      rule('DAYLIGHT', '19951029T020000', '+1000', '+1100', 'FREQ=YEARLY;BYDAY=1SU;BYMONTH=10'),
    )
    const { events } = parseIcs(
      wrap(
        zone,
        vevent('SUMMARY:Then', 'DTSTART;TZID=Old and new:20060401T090000'),
        vevent('SUMMARY:Now', 'DTSTART;TZID=Old and new:20260401T090000'),
      ),
      'UTC',
    )
    const at = Object.fromEntries(events.map((e) => [e.title, e.startsAt.toISOString()]))
    expect(at.Then).toBe('2006-03-31T23:00:00.000Z')
    expect(at.Now).toBe('2026-03-31T22:00:00.000Z')
  })

  it('treats a zone written in a way it does not read as unknown rather than guessing at it', () => {
    const { events, unknownZones } = parseIcs(
      wrap(
        vtimezone('Odd rule', rule('STANDARD', '16010101T030000', '+1100', '+1000', 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=1')),
        vtimezone('No offsets', ['BEGIN:STANDARD', 'DTSTART:16010101T030000', 'END:STANDARD']),
        vtimezone('No rules'),
        vtimezone('Bad until', rule('STANDARD', '16010101T030000', '+1100', '+1000', 'FREQ=YEARLY;BYDAY=1SU;BYMONTH=4;UNTIL=someday')),
        ['BEGIN:VTIMEZONE', 'END:VTIMEZONE'].join('\r\n'),
        vevent('SUMMARY:A', 'DTSTART;TZID=Odd rule:20260930T090000'),
        vevent('SUMMARY:B', 'DTSTART;TZID=No offsets:20260930T090000'),
        vevent('SUMMARY:C', 'DTSTART;TZID=No rules:20260930T090000'),
        vevent('SUMMARY:D', 'DTSTART;TZID=Bad until:20260930T090000'),
      ),
      MEL,
    )
    for (const e of events) expect(e.startsAt.toISOString()).toBe('2026-09-29T23:00:00.000Z')
    expect(unknownZones).toEqual(['Odd rule', 'No offsets', 'No rules', 'Bad until'])
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

  it('closes an alarm left open when its event ends, and ignores a stray END', () => {
    const ics = wrap(
      'END:VALARM',
      vevent('SUMMARY:Camp', 'DTSTART;VALUE=DATE:20260930', 'BEGIN:VALARM', 'SUMMARY:Alarm summary must not win'),
      vevent('SUMMARY:Fete', 'DTSTART;VALUE=DATE:20261001'),
    )
    expect(parseIcs(ics, MEL).events.map((e) => e.title)).toEqual(['Camp', 'Fete'])
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
    expect(parseIcs('not a calendar at all', MEL)).toEqual({ name: null, events: [], skipped: 0, overCap: 0, unknownZones: [] })
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

  it('stops at the cap and counts the rest apart from the unreadable', () => {
    const many = Array.from({ length: 205 }, (_, i) =>
      vevent(`SUMMARY:Event ${i}`, `DTSTART:202609${String(1 + (i % 28)).padStart(2, '0')}T090000Z`),
    )
    const { events, skipped, overCap } = parseIcs(wrap(...many), MEL)
    expect(events).toHaveLength(200)
    expect([skipped, overCap]).toEqual([0, 5])
  })

  it('keeps what is still to come when an export runs past the cap, the soonest first', () => {
    const weekly = (from: number, count: number) => Array.from({ length: count }, (_, i) => {
      const at = new Date(Date.UTC(2022, 0, 1 + (from + i) * 7, 9)).toISOString().replace(/[-:]|\.\d{3}/g, '')
      return vevent(`SUMMARY:Week ${from + i}`, `DTSTART:${at}`)
    })
    // Weekly from January 2022, oldest first: of 250, only the last six are
    // still ahead on 1 September 2026, and the oldest 50 are what go.
    const now = new Date('2026-09-01T00:00:00Z')
    const old = parseIcs(wrap(...weekly(0, 250)), MEL, now)
    expect([old.events.length, old.overCap]).toEqual([200, 50])
    expect(old.events.filter((e) => e.startsAt > now)).toHaveLength(6)
    expect([old.events[0].title, old.events.at(-1)!.title]).toEqual(['Week 50', 'Week 249'])
    // With more than the cap still ahead, the furthest off go, and the past with them.
    const ahead = parseIcs(wrap(...weekly(240, 210)), MEL, now)
    expect([ahead.events.length, ahead.overCap]).toEqual([200, 10])
    expect([ahead.events[0].title, ahead.events.at(-1)!.title]).toEqual(['Week 244', 'Week 443'])
  })

  it('counts a repeating event as still to come while its rule runs, however long ago it began', () => {
    const now = new Date('2026-09-24T00:00:00Z')
    const past = Array.from({ length: 250 }, (_, i) =>
      vevent(`SUMMARY:Old ${i}`, `DTSTART:2024${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}T090000Z`),
    )
    const soon = Array.from({ length: 5 }, (_, i) => vevent(`SUMMARY:Soon ${i}`, `DTSTART:2026100${i + 1}T090000Z`))
    const series = (title: string, rrule: string) => vevent(`SUMMARY:${title}`, 'DTSTART:20230103T080000Z', `RRULE:${rrule}`)
    const { events, overCap } = parseIcs(
      wrap(
        series('Bin night', 'FREQ=WEEKLY'),
        series('Swimming', 'FREQ=WEEKLY;UNTIL=20261218'),
        series('Piano', 'FREQ=WEEKLY;COUNT=200'),
        series('Old term', 'FREQ=WEEKLY;UNTIL=20231215T000000Z'),
        series('Old lessons', 'FREQ=WEEKLY;COUNT=10'),
        ...past,
        ...soon,
      ),
      MEL,
      now,
    )
    const titles = events.map((e) => e.title)
    expect(events).toHaveLength(200)
    expect(overCap).toBe(60)
    // Still running on 24 September 2026: kept, all three begun in January 2023.
    expect(titles).toEqual(expect.arrayContaining(['Bin night', 'Swimming', 'Piano', 'Soon 0', 'Soon 4']))
    // Ended in 2023, so older than every one-off from 2024 and the first to go.
    expect(titles).not.toContain('Old term')
    expect(titles).not.toContain('Old lessons')
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

  it('says how many were left out over the cap, and which zones were guessed at', () => {
    const many = Array.from({ length: 202 }, (_, i) =>
      vevent(`SUMMARY:Event ${i}`, `DTSTART;TZID=${i % 2 ? 'Nowhere' : 'Elsewhere'}:202609${String(1 + (i % 28)).padStart(2, '0')}T090000`),
    )
    const text = describeIcs(parseIcs(wrap(...many), MEL), 'big.ics', MEL)
    expect(text).toContain('200 events, 2 more left out because only 200 are read, those still to come first.')
    expect(text).toContain('Times given in "Elsewhere", "Nowhere" are read as Australia/Melbourne time, which may be wrong: the file does not say what those zones are.')
    const one = describeIcs(parseIcs(wrap(vevent('SUMMARY:A', 'DTSTART;TZID=Nowhere:20260930T090000')), MEL), 'one.ics', MEL)
    expect(one).toContain('"Nowhere" are read as Australia/Melbourne time, which may be wrong: the file does not say what that zone is.')
  })

  it('keeps a big file within the room a text file gets, listing every event with its note cut shorter', () => {
    const long = 'Bring a hat, water bottle and a signed permission slip. '.repeat(10)
    // In full, 120 notes of 500 characters would be over 60,000.
    const many = Array.from({ length: 120 }, (_, i) =>
      vevent(`SUMMARY:Event ${i}`, `DTSTART:2026${String(10 + (i % 3))}${String(1 + (i % 28)).padStart(2, '0')}T090000Z`, `DESCRIPTION:${long}`),
    )
    const text = describeIcs(parseIcs(wrap(...many), MEL), 'school.ics', MEL)
    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(text).toContain('\n120. ')
    expect(text).toContain('; note: Bring a hat')
    expect(text).not.toContain(long.trim())
    // A small file's notes are left as they were, up to 500 characters.
    const one = describeIcs(parseIcs(wrap(many[0]), MEL), 'one.ics', MEL)
    expect(one).toContain(`note: ${long.slice(0, 500)}`)
  })

  it('stops short, saying how many come after, when even the bare events do not fit', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      vevent(`SUMMARY:Event ${i}`, `DTSTART:202610${String(1 + (i % 28)).padStart(2, '0')}T090000Z`, 'DESCRIPTION:A note'),
    )
    const text = describeIcs(parseIcs(wrap(...many), MEL), 'school.ics', MEL, 2_000)
    expect(text.length).toBeLessThanOrEqual(2_000)
    expect(text).not.toContain('note:')
    const listed = text.split('\n').filter((l) => /^\d+\. /.test(l)).length
    expect(listed).toBeGreaterThan(10)
    expect(text.split('\n').at(-1)).toBe(`The ${50 - listed} events after these are not listed here, to keep this short.`)
  })
})
