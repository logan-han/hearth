import { tool } from 'ai'
import { z } from 'zod'
import { clientFor, clientsFor, MAX_EVENTS } from '../providers'
import { NotConnectedError, ReconnectNeededError } from '../providers/token'
import type { CalendarEvent } from '../providers/types'
import type { Member } from '../db/schema'
import { allowedMembers, strangersIn, listFamilyEvents, connectionsFor } from '../db/queries'
import { readOnlyRefusal } from './mail'
import { presentIn } from '../headcount'
import { providerConfig, type Provider } from '../oauth/providers'
import { localToUtc, formatLocal, formatLocalDate, formatLocalTime, resolveSpan, rangeEnd, lastDay, localDateKey, daysAfter, dayAfter } from '../cron'
import { freeSpans, nextQuarter, type Span } from '../free-time'
import { timezone } from '../env'
import type { ToolContext } from './context'
import { requireMember, writeFailure } from './context'
import { ALL_DAY_END } from './familycal'
import { describeError } from '../errors'

const providerEnum = z.enum(['google', 'microsoft'])

const LOCAL_DATETIME = z
  .string()
  .describe(`Local ${timezone()} time as YYYY-MM-DDTHH:mm (or YYYY-MM-DD for all-day)`)

/** A calendar as the family names it, owner first, the way a mailbox is named. */
const calendarName = (owner: string, provider: Provider) => `${owner}'s ${providerConfig(provider).calendar}`

export function calendarTools(ctx: ToolContext) {
  return {
    list_calendar: tool({
      description:
        "List events from the asker's own linked calendar(s) in a date range. Use this for 'what's on today/tomorrow/this week'. " +
        "Set everyone to read every linked member's calendar in this chat at once, for a shared chat; each account then says whose it is.",
      inputSchema: z.object({
        from: LOCAL_DATETIME,
        to: LOCAL_DATETIME,
        provider: providerEnum.optional(),
        everyone: z
          .boolean()
          .default(false)
          .describe("Every family member with a linked calendar, for a shared chat; off for the asker's own"),
      }),
      execute: async ({ from, to, provider, everyone }) => {
        // Several people's days read into one room follow the mail sweep's
        // house rules: only a room the family shares, not in front of
        // strangers, and only the calendars of those there to see it asked for.
        if (everyone && !ctx.shared) {
          return { error: 'A family-wide look is only for the family group. Here, leave everyone off for your own calendar.' }
        }
        if (everyone && (await strangersIn(ctx.chatId)).length > 0) {
          return { error: 'Not while someone unrecognised is in this chat. An admin can vouch for them with /allow.' }
        }
        let members: Member[]
        try {
          members = everyone ? await presentIn(ctx.chatId, await allowedMembers()) : [requireMember(ctx)]
        } catch (e) {
          // As for mail: Telegram hiccuping over who is here fails this look
          // and nothing else a brief fetches beside it.
          if (!everyone) throw e
          return { error: `Could not check who is in this chat: ${describe(e)}` }
        }

        const start = localToUtc(from)
        // A date alone as `to` is the whole of that day, not its first minute.
        const end = rangeEnd(to)
        const accounts: object[] = []
        for (const member of members) {
          // A provider the asker names is their own account; a sweep reads what each member linked.
          const clients = everyone
            ? (await clientsFor(member.id)).filter((c) => !provider || c.provider === provider)
            : provider
              ? [clientFor(member.id, provider)]
              : await clientsFor(member.id)
          for (const c of clients) {
            // Whose it is, said only when several are read together, the way a mailbox is named.
            const whose = everyone ? { member: member.name, calendar: calendarName(member.name, c.provider) } : {}
            try {
              const { events, more } = await c.listEvents(start, end)
              accounts.push({
                ...whose,
                provider: c.provider,
                events: events.map(asShown),
                ...(more
                  ? {
                      truncated: true,
                      note: `This range holds more than the ${MAX_EVENTS} events listed. List again from the last one's start for the rest; the time after it is not free.`,
                    }
                  : {}),
              })
            } catch (e) {
              accounts.push({ ...whose, provider: c.provider, error: describe(e) })
            }
          }
        }
        if (accounts.length === 0) {
          return { error: everyone ? 'Nobody in this chat has linked a calendar yet. Send /connect to link one.' : 'No calendar linked. Send /connect to link one.' }
        }
        return { timezone: timezone(), accounts }
      },
    }),

    find_free_time: tool({
      description:
        'Find when people are free, to book something in: reads the calendars of the asker, or of everyone in this chat with one linked, and the family calendar, ' +
        'and gives the stretches free for long enough within the hours and days asked. All-day entries (a birthday, holidays) do not block time; they are listed by day so they can be weighed. ' +
        'Offer times from what it returns, never one of your own.',
      inputSchema: z.object({
        from: z.string().optional().describe('First day to look at, YYYY-MM-DD; defaults to today'),
        to: z.string().optional().describe('Last day, YYYY-MM-DD; defaults to six days after the first'),
        minutes: z.number().int().min(15).max(720).default(60).describe('How long it needs'),
        everyone: z.boolean().default(false).describe('Everyone in this chat with a linked calendar, for a shared chat; off for the asker alone'),
        earliest: z.string().default('08:00').describe('HH:mm, the earliest it may start on a day'),
        latest: z.string().default('20:00').describe('HH:mm, the latest it may end on a day'),
        days: z.enum(['any', 'weekdays', 'weekends']).default('any'),
        family_calendar: z.boolean().default(true).describe('Count what is on the family calendar as busy'),
      }),
      execute: async ({ from, to, minutes, everyone, earliest, latest, days, family_calendar }) => {
        const first = from ?? localDateKey(ctx.now)
        if (!DATE.test(first) || (to !== undefined && !DATE.test(to))) return { error: 'Give the days as YYYY-MM-DD.' }
        const last = to ?? daysAfter(first, 6)
        if (last < first) return { error: 'The last day comes before the first.' }
        if (daysBetween(first, last) > MAX_FREE_DAYS) return { error: `Look at ${MAX_FREE_DAYS + 1} days at most at a time.` }
        if (!TIME.test(earliest) || !TIME.test(latest) || earliest >= latest) {
          return { error: 'Give earliest and latest as HH:mm, earliest first, such as 08:00 and 20:00.' }
        }
        if (everyone && !ctx.shared) {
          return { error: 'Everyone\'s calendars are read only in the family group. Here, leave everyone off for your own.' }
        }
        if (everyone && (await strangersIn(ctx.chatId)).length > 0) {
          return { error: 'Not while someone unrecognised is in this chat. An admin can vouch for them with /allow.' }
        }
        let members: Member[]
        try {
          members = everyone ? await presentIn(ctx.chatId, await allowedMembers()) : [requireMember(ctx)]
        } catch (e) {
          if (!everyone) throw e
          return { error: `Could not check who is in this chat: ${describe(e)}` }
        }

        const rangeStart = localToUtc(`${first}T00:00`)
        const rangeStop = localToUtc(`${dayAfter(last)}T00:00`)
        const busy: Span[] = []
        const allDay = new Map<string, string[]>()
        const noteAllDay = (day: string, title: string) => allDay.set(day, [...(allDay.get(day) ?? []), title])
        const checked: string[] = []
        const unread: string[] = []
        // A listing cut short leaves the time after its last event unknown, not free.
        let knownUntil = rangeStop
        for (const member of members) {
          for (const c of await clientsFor(member.id)) {
            const name = calendarName(member.name, c.provider)
            try {
              const { events, more } = await c.listEvents(rangeStart, rangeStop)
              checked.push(name)
              for (const e of events) {
                if (e.allDay) noteAllDay(e.start.slice(0, 10), `${e.title} (${name})`)
                else if (e.start && e.end) busy.push({ start: new Date(e.start), end: new Date(e.end) })
              }
              const lastStart = events.at(-1)?.start
              if (more && lastStart) {
                const at = events.at(-1)!.allDay ? localToUtc(lastStart.slice(0, 10)) : new Date(lastStart)
                if (at < knownUntil) knownUntil = at
              }
            } catch (e) {
              unread.push(`${name}: ${describe(e)}`)
            }
          }
        }
        if (family_calendar) {
          checked.push('the family calendar')
          for (const e of await listFamilyEvents(rangeStart, rangeStop)) {
            if (e.cancelled) continue
            if (e.allDay) noteAllDay(localDateKey(e.startsAt), `${e.title} (family calendar)`)
            else busy.push({ start: e.startsAt, end: e.endsAt })
          }
        }
        if (checked.length === 0) {
          return { error: everyone ? 'Nobody in this chat has linked a calendar yet. Send /connect to link one.' : 'No calendar linked. Send /connect to link one.' }
        }

        // Each day's searchable hours, from now on, no further than the listings were read.
        const soonest = nextQuarter(ctx.now)
        const windows: Span[] = []
        for (let day = first; day <= last; day = dayAfter(day)) {
          const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
          if (days === 'weekdays' && (weekday === 0 || weekday === 6)) continue
          if (days === 'weekends' && weekday !== 0 && weekday !== 6) continue
          const start = maxDate(localToUtc(`${day}T${earliest}`), soonest)
          const end = minDate(localToUtc(`${day}T${latest}`), knownUntil)
          if (start < end) windows.push({ start, end })
        }
        const free = freeSpans(windows, busy, minutes)
        return {
          timezone: timezone(),
          checked,
          ...(unread.length ? { could_not_read: unread } : {}),
          free: free.slice(0, MAX_FREE_SPANS).map((s) => ({
            day: formatLocalDate(s.start),
            from: formatLocalTime(s.start),
            until: formatLocalTime(s.end),
            minutes: Math.round((s.end.getTime() - s.start.getTime()) / 60_000),
          })),
          ...(free.length > MAX_FREE_SPANS ? { more_not_shown: free.length - MAX_FREE_SPANS } : {}),
          ...(allDay.size
            ? { all_day: [...allDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, titles]) => ({ day: formatLocalDate(localToUtc(day)), on: titles })) }
            : {}),
          ...(knownUntil < rangeStop
            ? { note: `A calendar held more events than could be read, so nothing after ${formatLocal(knownUntil)} is offered: ask about the days after that separately.` }
            : {}),
        }
      },
    }),

    create_calendar_event: tool({
      description:
        "Add an event to the asker's OWN personal calendar. For something the whole family should see, use add_family_event instead.",
      inputSchema: z.object({
        title: z.string(),
        start: LOCAL_DATETIME,
        end: LOCAL_DATETIME.optional().describe(`Defaults to one hour after start, or the one day for an all-day event. ${ALL_DAY_END}`),
        all_day: z.boolean().default(false).describe('True when the event has no particular time. A date-only start implies this.'),
        location: z.string().optional(),
        description: z.string().optional(),
        attendees: z.array(z.string()).optional().describe('Email addresses to invite'),
        provider: providerEnum.optional(),
      }),
      execute: async ({ title, start, end, all_day, location, description, attendees, provider }) => {
        const member = requireMember(ctx)
        // An invitation carries the title and description to whoever is on
        // it, so after outside text it waits for the member's own word, as a send does.
        if (attendees?.length && ctx.readUntrusted) {
          return {
            error:
              'Not created: this turn has read mail, a page or a file from outside the household, and invitations ' +
              'must not be sent on its say-so. Add the event without attendees, or ask the member to confirm who to invite in their next message.',
          }
        }
        // An account its owner linked to be read only takes no events, and is not swapped for another unasked.
        const readOnly = new Set((await connectionsFor(member.id)).filter((c) => c.readOnly).map((c) => c.provider))
        if (provider && readOnly.has(provider)) return { error: readOnlyRefusal(provider) }
        const linked = provider ? [clientFor(member.id, provider)] : await clientsFor(member.id)
        if (linked.length === 0) return { error: 'No calendar linked. Send /connect to link one.' }
        const clients = linked.filter((c) => !readOnly.has(c.provider))
        if (clients.length === 0) return { error: readOnlyRefusal(linked[0].provider) }

        // Read as add_family_event reads it. The instants are local midnights
        // for an all-day event, which the providers turn back into dates.
        const span = resolveSpan({ start, end, allDay: all_day })
        try {
          const created = await clients[0].createEvent({
            title,
            start: span.startsAt,
            end: span.endsAt,
            allDay: span.allDay,
            location,
            description,
            attendees,
          })
          return {
            // Shown as list_calendar shows it: the provider hands back an
            // all-day end as the day after, which would contradict the end
            // just given.
            created: asShown(created),
            provider: clients[0].provider,
            start_local: span.allDay ? formatLocalDate(span.startsAt) : formatLocal(span.startsAt),
          }
        } catch (e) {
          return writeFailure(e, describe)
        }
      },
    }),
  }
}

/**
 * An event as the model is shown it, with local times beside the raw ones.
 * An all-day entry has dates, not times: read as UTC instants they would show
 * as 10am, or the day before west of Greenwich. Its end is given as the last
 * day, the way the tools that make events take it; the provider's own end is
 * the day after, and copied across would add a day.
 */
function asShown(e: CalendarEvent) {
  if (!e.allDay || !e.start) {
    const local = (at: string) => (at ? formatLocal(new Date(at)) : '')
    return { ...e, start_local: local(e.start), end_local: local(e.end) }
  }
  const first = e.start.slice(0, 10)
  const last = e.end ? lastDay(localToUtc(first), localToUtc(e.end.slice(0, 10))) : first
  return {
    ...e,
    start: first,
    end: last,
    start_local: formatLocalDate(localToUtc(first)),
    end_local: formatLocalDate(localToUtc(last)),
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
/** How many days past the first one look takes in, and how many free stretches it lists. */
const MAX_FREE_DAYS = 30
const MAX_FREE_SPANS = 12

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
const maxDate = (a: Date, b: Date) => (a > b ? a : b)
const minDate = (a: Date, b: Date) => (a < b ? a : b)

function describe(e: unknown): string {
  if (e instanceof NotConnectedError) {
    return `No ${e.provider} account linked. Send /connect to link one.`
  }
  if (e instanceof ReconnectNeededError) {
    return `The ${e.provider} link has expired or been revoked. Send /connect to link it again.`
  }
  return describeError(e)
}
