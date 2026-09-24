import { localToUtc, formatLocal, formatLocalDate, nextLocalMidnight } from './cron'
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
  /** Cancelled or unreadable entries. */
  skipped: number
  /** Readable events left out past the cap, the past ones first. */
  overCap: number
  /** Zones the file names but neither defines nor Intl knows, read as household time. */
  unknownZones: string[]
}

const MAX_EVENTS = 200

type Prop = { name: string; params: Record<string, string>; value: string }

/** A BEGIN/END block: its own properties, and the blocks inside it. */
type Block = { name: string; props: Prop[]; parts: Block[] }

/** One STANDARD or DAYLIGHT rule of a VTIMEZONE, its times as wall-clock milliseconds. */
type Observance = {
  from: number
  to: number
  start: number
  rule: { month: number; nth: number; weekday: number; until: number } | null
}

type Zones = { tz: string; defined: Map<string, Observance[] | null>; unknown: Set<string> }

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
    // Outlook writes Windows names such as "W. Australia Standard Time",
    // which Intl does not know; the file's own VTIMEZONE says what they mean.
    return null
  }
}

/** The file's BEGIN/END nesting. An END closes the block it names, and anything left open inside it. */
function blocksOf(lines: string[]): Block {
  const root: Block = { name: '', props: [], parts: [] }
  const open = [root]
  for (const line of lines) {
    const prop = parseLine(line)
    if (!prop) continue
    const name = prop.value.trim().toUpperCase()
    if (prop.name === 'BEGIN') {
      const block: Block = { name, props: [], parts: [] }
      open[open.length - 1].parts.push(block)
      open.push(block)
    } else if (prop.name === 'END') {
      const at = open.findLastIndex((b) => b.name === name)
      if (at > 0) open.length = at
    } else open[open.length - 1].props.push(prop)
  }
  return root
}

/** Every block called `name`, however deep, but not one inside another: an alarm stays its event's. */
function find(block: Block, name: string): Block[] {
  return block.parts.flatMap((b) => (b.name === name ? [b] : find(b, name)))
}

/** YYYYMMDD with an optional THHMMSS, as wall-clock milliseconds; null when unreadable. */
function wallClock(v: string): number | null {
  const m = v.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : null
}

/** A UTC offset such as +1000 or -0330, in milliseconds. */
function utcOffset(v: string): number | null {
  const m = v.trim().match(/^([+-])(\d{2})(\d{2})(\d{2})?$/)
  return m ? (m[1] === '-' ? -1 : 1) * ((+m[2] * 60 + +m[3]) * 60 + +(m[4] ?? 0)) * 1000 : null
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/** An RRULE such as FREQ=WEEKLY;UNTIL=20261218, as its parts. */
function ruleParts(rrule: string): Record<string, string> {
  return Object.fromEntries(rrule.toUpperCase().split(';').map((kv) => kv.split('=')))
}

/**
 * A zone's STANDARD and DAYLIGHT rules. Real zones change on a set weekday
 * of a set month each year ("first Sunday in April"), which is all this
 * reads; a zone written any other way is null, and treated as unknown
 * rather than guessed at.
 */
function observances(zone: Block): Observance[] | null {
  const out: Observance[] = []
  for (const part of zone.parts) {
    if (part.name !== 'STANDARD' && part.name !== 'DAYLIGHT') continue
    const get = (n: string) => part.props.find((p) => p.name === n)?.value ?? ''
    const start = wallClock(get('DTSTART'))
    const from = utcOffset(get('TZOFFSETFROM'))
    const to = utcOffset(get('TZOFFSETTO'))
    if (start === null || from === null || to === null) return null
    let rule: Observance['rule'] = null
    if (get('RRULE')) {
      const r = ruleParts(get('RRULE'))
      const day = (r.BYDAY ?? '').match(/^([+-]?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/)
      const month = Number(r.BYMONTH)
      const until = r.UNTIL ? wallClock(r.UNTIL) : Infinity
      if (r.FREQ !== 'YEARLY' || !day || !(month >= 1 && month <= 12) || until === null) return null
      // An UNTIL in UTC is moved onto the wall clock the rule's onsets are in.
      rule = { month, nth: +day[1], weekday: WEEKDAYS.indexOf(day[2]), until: until + (/Z$/.test(r.UNTIL ?? '') ? from : 0) }
    }
    out.push({ from, to, start, rule })
  }
  return out.length ? out : null
}

/** When a yearly rule takes effect in `year`, on the wall clock. */
function onset(o: Observance, year: number): number {
  const { month, nth, weekday } = o.rule!
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate()
  let day = nth > 0
    ? 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7
    : length - ((first + length - 1 - weekday + 7) % 7) + (nth + 1) * 7
  // A fifth Sunday the month lacks is its last, which is what Windows means by it.
  while (day > length) day -= 7
  const time = ((o.start % 86_400_000) + 86_400_000) % 86_400_000
  return Date.UTC(year, month - 1, day) + time
}

/** How far ahead of UTC a zone the file defines is at a wall-clock time in it: the rule that last took effect. */
function zoneOffset(rules: Observance[], wall: number): number {
  const year = new Date(wall).getUTCFullYear()
  let latest = -Infinity
  let ahead = rules.reduce((a, b) => (b.start < a.start ? b : a)).from
  for (const o of rules) {
    const onsets = o.rule
      ? [year - 1, year].map((y) => onset(o, y)).filter((t) => t >= o.start && t <= o.rule!.until)
      : [o.start]
    for (const t of onsets) {
      if (t <= wall && t > latest) {
        latest = t
        ahead = o.to
      }
    }
  }
  return ahead
}

/** A DTSTART or DTEND, as an instant plus whether it was a bare date. */
function parseDateTime(prop: Prop, zones: Zones): { at: Date; allDay: boolean } | null {
  const v = prop.value.trim()
  const dateOnly = prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', s = '00', utc] = m
  if (dateOnly) return { at: localToUtc(`${y}-${mo}-${d}`, zones.tz), allDay: true }
  if (utc) return { at: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false }
  const id = prop.params.TZID
  const named = validTimezone(id)
  if (id && !named) {
    const rules = zones.defined.get(id)
    if (rules) {
      const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
      return { at: new Date(wall - zoneOffset(rules, wall)), allDay: false }
    }
    // Neither a zone Intl knows nor one the file defines: the household's
    // own is the likeliest reading, and the listing says it was a guess.
    zones.unknown.add(id)
  }
  return { at: localToUtc(`${y}-${mo}-${d}T${h}:${mi}:${s}`, named ?? zones.tz), allDay: false }
}

/** An RFC 5545 duration (P1D, PT1H30M, P2W) in milliseconds; null when unreadable. */
export function parseDuration(value: string): number | null {
  const m = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const [, sign, w = '0', d = '0', h = '0', mi = '0', s = '0'] = m
  const ms = ((+w * 7 + +d) * 86_400 + +h * 3600 + +mi * 60 + +s) * 1000
  return sign === '-' ? -ms : ms
}

const DAY_MS = 86_400_000

/** The longest each FREQ's period can be, so a COUNT is reckoned to end late rather than soon. */
const LONGEST_PERIOD: Record<string, number> = {
  SECONDLY: 1000,
  MINUTELY: 60_000,
  HOURLY: 3_600_000,
  DAILY: DAY_MS,
  WEEKLY: 7 * DAY_MS,
  MONTHLY: 31 * DAY_MS,
  YEARLY: 366 * DAY_MS,
}

/**
 * Whether a repeating event still has dates after `now`, near enough to
 * choose what to keep. An UNTIL says when it stops, give or take the day a
 * household date can differ from UTC. A COUNT is reckoned as that many of
 * its longest periods from the first date, which runs late for a rule with
 * several days a week and is near enough for the rest: a finished series
 * kept a while is cheaper than a running one dropped. With neither it runs
 * for good.
 */
function stillRepeating(rrule: string, first: Date, now: Date): boolean {
  const r = ruleParts(rrule)
  if (r.UNTIL) {
    const until = wallClock(r.UNTIL)
    return until === null || until + DAY_MS > now.getTime()
  }
  const period = LONGEST_PERIOD[r.FREQ]
  const count = Number(r.COUNT)
  if (!period || !(count > 0)) return true
  return first.getTime() + count * Math.max(1, Number(r.INTERVAL) || 1) * period > now.getTime()
}

export function parseIcs(text: string, tz: string = timezone(), now: Date = new Date()): ParsedIcs {
  const root = blocksOf(unfold(text))
  // Zones first, wherever in the file they sit, so every time can use them.
  const zones: Zones = { tz, defined: new Map(), unknown: new Set() }
  for (const zone of find(root, 'VTIMEZONE')) {
    const id = zone.props.find((p) => p.name === 'TZID')?.value.trim()
    if (id) zones.defined.set(id, observances(zone))
  }
  const calName = [root, ...find(root, 'VCALENDAR')].flatMap((b) => b.props).find((p) => p.name === 'X-WR-CALNAME')

  const events: IcsEvent[] = []
  let skipped = 0
  for (const block of find(root, 'VEVENT')) {
    const event = toEvent(block.props, zones)
    if (event) events.push(event)
    else skipped++
  }

  // Past the cap, what is still to come is what the family wants. An export
  // of an old calendar runs oldest first, and the file's first 200 would be
  // years of history with everything ahead dropped. A repeating event is
  // still to come while its rule runs, however long ago it first fell.
  const byStart = (a: IcsEvent, b: IcsEvent) => a.startsAt.getTime() - b.startsAt.getTime()
  const isAhead = (e: IcsEvent) => e.endsAt.getTime() > now.getTime() || (e.repeats !== null && stillRepeating(e.repeats, e.startsAt, now))
  const ahead = events.filter(isAhead).sort(byStart)
  const past = events.filter((e) => !isAhead(e)).sort((a, b) => byStart(b, a))
  const kept = [...ahead, ...past].slice(0, MAX_EVENTS).sort(byStart)
  return {
    name: (calName && unescapeText(calName.value).trim()) || null,
    events: kept,
    skipped,
    overCap: events.length - kept.length,
    unknownZones: [...zones.unknown],
  }
}

function toEvent(props: Prop[], zones: Zones): IcsEvent | null {
  const get = (n: string) => props.find((p) => p.name === n)
  if ((get('STATUS')?.value ?? '').trim().toUpperCase() === 'CANCELLED') return null
  const startProp = get('DTSTART')
  if (!startProp) return null
  const start = parseDateTime(startProp, zones)
  if (!start) return null

  let endsAt: Date | null = null
  const endProp = get('DTEND')
  if (endProp) endsAt = parseDateTime(endProp, zones)?.at ?? null
  else {
    const duration = get('DURATION')
    const ms = duration ? parseDuration(duration.value) : null
    if (ms !== null) endsAt = new Date(start.at.getTime() + ms)
  }
  // No end at all: a date is a day, a time is an hour, as add_family_event reads them.
  if (!endsAt || endsAt.getTime() <= start.at.getTime()) {
    // A day by the calendar, which is 25 hours on the day the clocks go back.
    endsAt = start.allDay ? nextLocalMidnight(start.at, zones.tz) : new Date(start.at.getTime() + 3_600_000)
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

/** A note cut shorter than this says too little to be worth its room. */
const SHORTEST_NOTE = 40

/**
 * The file as a numbered listing the model can read and refer to, in at most
 * `maxChars`, so a big file costs no more than any other text. Every event
 * goes in before any note does: the room left is shared among the notes, so a
 * long file lists all its events with shorter notes rather than the first few
 * with theirs in full. Only when the events alone do not fit does the list
 * stop short, and then it says how many it leaves out.
 */
export function describeIcs(parsed: ParsedIcs, filename: string, tz: string = timezone(), maxChars = 20_000): string {
  const total = parsed.events.length
  const left = [
    parsed.skipped ? `, ${parsed.skipped} unreadable or cancelled entries left out` : '',
    parsed.overCap ? `, ${parsed.overCap} more left out because only ${MAX_EVENTS} are read, those still to come first` : '',
  ].join('')
  const head = `Calendar file "${filename}"${parsed.name ? ` (${parsed.name})` : ''}: ${total} ${total === 1 ? 'event' : 'events'}${left}.`
  if (total === 0) return head
  const guessed = parsed.unknownZones.map((z) => `"${z}"`).join(', ')
  const zonesNote = guessed
    ? `Times given in ${guessed} are read as ${tz} time, which may be wrong: the file does not say what ${parsed.unknownZones.length === 1 ? 'that zone is' : 'those zones are'}.`
    : null
  const top = [head, ...(zonesNote ? [zonesNote] : [])]
  const rows = parsed.events.map((e, i) => {
    const when = e.allDay ? `${formatLocalDate(e.startsAt, tz)} (all day${daysLong(e)})` : `${formatLocal(e.startsAt, tz)} to ${formatLocal(e.endsAt, tz)}`
    const extra = [
      e.location ? `at ${e.location}` : null,
      e.repeats ? `repeats (${e.repeats})` : null,
    ].filter(Boolean)
    return { line: `${i + 1}. ${e.title}: ${when}${extra.length ? `; ${extra.join('; ')}` : ''}`, note: e.description?.replace(/\s+/g, ' ') ?? '' }
  })
  const bare = [...top, ...rows.map((r) => r.line)].join('\n').length
  const noted = rows.filter((r) => r.note).length
  const room = noted ? Math.min(500, Math.floor((maxChars - bare) / noted) - '; note: '.length) : 0
  const lines = rows.map((r) => (r.note && room >= SHORTEST_NOTE ? `${r.line}; note: ${r.note.slice(0, room)}` : r.line))
  const full = [...top, ...lines].join('\n')
  if (full.length <= maxChars) return full

  // The events alone are too long, so the list stops where the room runs
  // out, leaving space to say how many come after.
  const listed = [...top]
  let used = top.join('\n').length
  for (const line of lines) {
    if (used + 1 + line.length > maxChars - 80) break
    listed.push(line)
    used += 1 + line.length
  }
  const rest = total - (listed.length - top.length)
  return [...listed, `${rest === 1 ? 'The event after these is' : `The ${rest} events after these are`} not listed here, to keep this short.`].join('\n')
}

function daysLong(e: IcsEvent): string {
  const days = Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 86_400_000)
  return days > 1 ? `, ${days} days` : ''
}
