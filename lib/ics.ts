import { createEvents, type EventAttributes, type DateArray } from 'ics'
import type { FamilyEvent } from './db/schema'
import { timezone, tzOffsetMs } from './cron'

/** UTC calendar parts as an `ics` DateArray. */
function utcParts(d: Date): DateArray {
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]
}

/** Local (family timezone) date parts, for all-day events. */
function localDateParts(d: Date, tz: string): DateArray {
  const shifted = new Date(d.getTime() + tzOffsetMs(d, tz))
  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()]
}

export function toIcsEvent(e: FamilyEvent, tz: string = timezone()): EventAttributes {
  const base = {
    uid: e.uid,
    title: e.title,
    description: e.description ?? undefined,
    location: e.location ?? undefined,
    status: (e.cancelled ? 'CANCELLED' : 'CONFIRMED') as EventAttributes['status'],
    // Bumped on edit so subscribers replace rather than duplicate the event.
    sequence: Math.floor(e.updatedAt.getTime() / 1000) % 2147483647,
    created: utcParts(e.createdAt),
    lastModified: utcParts(e.updatedAt),
    productId: 'hearth/ics',
  }

  if (e.allDay) {
    return {
      ...base,
      start: localDateParts(e.startsAt, tz),
      end: localDateParts(e.endsAt, tz),
    } as EventAttributes
  }
  return {
    ...base,
    start: utcParts(e.startsAt),
    startInputType: 'utc',
    startOutputType: 'utc',
    end: utcParts(e.endsAt),
    endInputType: 'utc',
    endOutputType: 'utc',
  } as EventAttributes
}

/**
 * Build a subscribable VCALENDAR. Returns a valid empty calendar when there are
 * no events, because `ics` refuses an empty array.
 */
export function buildCalendar(events: FamilyEvent[], calName = 'Family', tz: string = timezone()): string {
  if (events.length === 0) return emptyCalendar(calName)

  const { error, value } = createEvents(events.map((e) => toIcsEvent(e, tz)), {
    calName,
    productId: 'hearth/ics',
  })
  if (error || !value) throw error ?? new Error('ICS generation produced no output')

  // `ics` writes X-WR-CALNAME and a 1-hour TTL for us. Tighten the refresh hint
  // and add the timezone label that Google and Apple use for a subscribed feed.
  const extras = `X-WR-TIMEZONE:${tz}\r\nX-PUBLISHED-TTL:PT15M\r\nREFRESH-INTERVAL;VALUE=DURATION:PT15M\r\n`
  if (value.includes('X-PUBLISHED-TTL:')) {
    return value.replace(/X-PUBLISHED-TTL:[^\r\n]*\r\n/, extras)
  }
  return value.replace('BEGIN:VCALENDAR\r\n', `BEGIN:VCALENDAR\r\n${extras}`)
}

function escapeText(s: string): string {
  return s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
}

function emptyCalendar(calName: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'PRODID:-//hearth//ics//EN',
    `X-WR-CALNAME:${escapeText(calName)}`,
    `X-WR-TIMEZONE:${timezone()}`,
    'X-PUBLISHED-TTL:PT15M',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}
