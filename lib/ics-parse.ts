import { localToUtc, formatLocal, formatLocalDate } from './cron'
import { timezone } from './env'

/**
 * Reading a calendar file someone sends the bot. Only what the family
 * calendar can hold is kept: a title, a start, an end, a place, a note. A
 * repeating event is reported rather than expanded, because the family
 * calendar has no recurrence and guessing at occurrences would invent dates.
 */
export type IcsEvent = {
  uid: string | null
  title: string
  description: string | null
  location: string | null
  startsAt: Date
  endsAt: Date
  allDay: boolean
  /** The RRULE when the event repeats; null for a one-off. */
  repeats: string | null
}

export type ParsedIcs = {
  /** X-WR-CALNAME, when the file names itself. */
  name: string | null
  events: IcsEvent[]
  /** Cancelled or unreadable entries, and anything past the cap. */
  skipped: number
}

const MAX_EVENTS = 200

type Prop = { name: string; params: Record<string, string>; value: string }

/** Undo RFC 5545 line folding: a continuation line starts with a space or tab. */
function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
}

/** `NAME;PARAM=a;OTHER="x:y":value`, splitting on the first colon outside quotes. */
function parseLine(line: string): Prop | null {
  let inQuote = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuote = !inQuote
    else if (c === ':' && !inQuote) {
      colon = i
      break
    }
  }
  if (colon <= 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const segments: string[] = []
  let current = ''
  inQuote = false
  for (const c of head) {
    if (c === '"') inQuote = !inQuote
    if (c === ';' && !inQuote) {
      segments.push(current)
      current = ''
    } else current += c
  }
  segments.push(current)
  const [rawName, ...rawParams] = segments
  const params: Record<string, string> = {}
  for (const p of rawParams) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: rawName.toUpperCase(), params, value }
}

function unescapeText(s: string): string {
  return s.replace(/\\([\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

function validTimezone(tz: string | undefined): string | null {
  if (!tz) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    // Outlook writes Windows names such as "AUS Eastern Standard Time", which
    // Intl does not know. The household's own zone is the sensible reading.
    return null
  }
}

/** A DTSTART or DTEND, as an instant plus whether it was a bare date. */
function parseDateTime(prop: Prop, tz: string): { at: Date; allDay: boolean } | null {
  const v = prop.value.trim()
  const dateOnly = prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', s = '00', utc] = m
  if (dateOnly) return { at: localToUtc(`${y}-${mo}-${d}`, tz), allDay: true }
  if (utc) return { at: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false }
  const zone = validTimezone(prop.params.TZID) ?? tz
  return { at: localToUtc(`${y}-${mo}-${d}T${h}:${mi}:${s}`, zone), allDay: false }
}

/** An RFC 5545 duration (P1D, PT1H30M, P2W) in milliseconds; null when unreadable. */
export function parseDuration(value: string): number | null {
  const m = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const [, sign, w = '0', d = '0', h = '0', mi = '0', s = '0'] = m
  const ms = ((+w * 7 + +d) * 86_400 + +h * 3600 + +mi * 60 + +s) * 1000
  return sign === '-' ? -ms : ms
}

export function parseIcs(text: string, tz: string = timezone()): ParsedIcs {
  const events: IcsEvent[] = []
  let name: string | null = null
  let skipped = 0
  let current: Prop[] | null = null
  let depth = 0 // nesting inside a VEVENT, so a VALARM's own properties are ignored

  for (const line of unfold(text)) {
    const prop = parseLine(line)
    if (!prop) continue
    if (prop.name === 'BEGIN') {
      if (prop.value.toUpperCase() === 'VEVENT' && current === null) current = []
      else if (current) depth++
      continue
    }
    if (prop.name === 'END') {
      if (current && depth > 0) depth--
      else if (current && prop.value.toUpperCase() === 'VEVENT') {
        const event = toEvent(current, tz)
        if (!event) skipped++
        else if (events.length >= MAX_EVENTS) skipped++
        else events.push(event)
        current = null
      }
      continue
    }
    if (current) {
      if (depth === 0) current.push(prop)
    } else if (prop.name === 'X-WR-CALNAME') {
      name = unescapeText(prop.value).trim() || null
    }
  }

  events.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  return { name, events, skipped }
}

function toEvent(props: Prop[], tz: string): IcsEvent | null {
  const get = (n: string) => props.find((p) => p.name === n)
  if ((get('STATUS')?.value ?? '').trim().toUpperCase() === 'CANCELLED') return null
  const startProp = get('DTSTART')
  if (!startProp) return null
  const start = parseDateTime(startProp, tz)
  if (!start) return null

  let endsAt: Date | null = null
  const endProp = get('DTEND')
  if (endProp) endsAt = parseDateTime(endProp, tz)?.at ?? null
  else {
    const duration = get('DURATION')
    const ms = duration ? parseDuration(duration.value) : null
    if (ms !== null) endsAt = new Date(start.at.getTime() + ms)
  }
  // No end at all: a date is a day, a time is an hour, as add_family_event reads them.
  if (!endsAt || endsAt.getTime() <= start.at.getTime()) {
    endsAt = new Date(start.at.getTime() + (start.allDay ? 86_400_000 : 3_600_000))
  }

  const text = (n: string) => {
    const v = get(n)?.value
    const clean = v ? unescapeText(v).trim() : ''
    return clean || null
  }
  return {
    uid: text('UID'),
    title: text('SUMMARY') ?? '(untitled)',
    description: text('DESCRIPTION'),
    location: text('LOCATION'),
    startsAt: start.at,
    endsAt,
    allDay: start.allDay,
    repeats: text('RRULE'),
  }
}

/** The file as a numbered listing the model can read and refer to. */
export function describeIcs(parsed: ParsedIcs, filename: string, tz: string = timezone()): string {
  const total = parsed.events.length
  const head = `Calendar file "${filename}"${parsed.name ? ` (${parsed.name})` : ''}: ${total} ${total === 1 ? 'event' : 'events'}${parsed.skipped ? `, ${parsed.skipped} unreadable or cancelled entries left out` : ''}.`
  if (total === 0) return head
  const lines = parsed.events.map((e, i) => {
    const when = e.allDay ? `${formatLocalDate(e.startsAt, tz)} (all day${daysLong(e)})` : `${formatLocal(e.startsAt, tz)} to ${formatLocal(e.endsAt, tz)}`
    const extra = [
      e.location ? `at ${e.location}` : null,
      e.repeats ? `repeats (${e.repeats})` : null,
      e.description ? `note: ${e.description.replace(/\s+/g, ' ').slice(0, 500)}` : null,
    ].filter(Boolean)
    return `${i + 1}. ${e.title}: ${when}${extra.length ? `; ${extra.join('; ')}` : ''}`
  })
  return [head, ...lines].join('\n')
}

function daysLong(e: IcsEvent): string {
  const days = Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 86_400_000)
  return days > 1 ? `, ${days} days` : ''
}
