import { tool } from 'ai'
import { z } from 'zod'
import { clientFor, clientsFor } from '../providers'
import { NotConnectedError, ReconnectNeededError } from '../providers/token'
import { localToUtc, formatLocal, formatLocalDate, dayAfter } from '../cron'
import { timezone } from '../env'
import type { ToolContext } from './context'
import { requireMember } from './context'
import { describeError } from '../errors'

const providerEnum = z.enum(['google', 'microsoft'])

const LOCAL_DATETIME = z
  .string()
  .describe(`Local ${timezone()} time as YYYY-MM-DDTHH:mm (or YYYY-MM-DD for all-day)`)

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * An event's span, the way add_family_event reads one: a date alone means
 * all day, and an all-day end is exclusive and at least a day on, both taken
 * as the household's dates. The instants are local midnights, which the
 * providers turn back into dates in the same zone.
 */
function resolveSpan(start: string, end: string | undefined, allDay: boolean): { startAt: Date; endAt: Date; allDay: boolean } {
  const s = start.trim()
  if (allDay || DATE_ONLY.test(s)) {
    const first = s.slice(0, 10)
    const until = end?.trim().slice(0, 10)
    return { startAt: localToUtc(first), endAt: localToUtc(until && until > first ? until : dayAfter(first)), allDay: true }
  }
  const startAt = localToUtc(s)
  return { startAt, endAt: end ? localToUtc(end) : new Date(startAt.getTime() + 60 * 60 * 1000), allDay: false }
}

export function calendarTools(ctx: ToolContext) {
  return {
    list_calendar: tool({
      description:
        "List events from the asker's own linked calendar(s) in a date range. Use this for 'what's on today/tomorrow/this week'.",
      inputSchema: z.object({
        from: LOCAL_DATETIME,
        to: LOCAL_DATETIME,
        provider: providerEnum.optional(),
      }),
      execute: async ({ from, to, provider }) => {
        const member = requireMember(ctx)
        const clients = provider ? [clientFor(member.id, provider)] : await clientsFor(member.id)
        if (clients.length === 0) return { error: 'No calendar linked. Send /connect to link one.' }

        const start = localToUtc(from)
        const end = localToUtc(to)
        const accounts = await Promise.all(
          clients.map(async (c) => {
            try {
              const events = await c.listEvents(start, end)
              return {
                provider: c.provider,
                events: events.map((e) => ({
                  ...e,
                  start_local: e.start ? formatLocal(new Date(e.start)) : '',
                })),
              }
            } catch (e) {
              return { provider: c.provider, error: describe(e) }
            }
          }),
        )
        return { timezone: timezone(), accounts }
      },
    }),

    create_calendar_event: tool({
      description:
        "Add an event to the asker's OWN personal calendar. For something the whole family should see, use add_family_event instead.",
      inputSchema: z.object({
        title: z.string(),
        start: LOCAL_DATETIME,
        end: LOCAL_DATETIME.optional().describe('Defaults to one hour after start, or the one day for an all-day event'),
        all_day: z.boolean().default(false).describe('True when the event has no particular time. A date-only start implies this.'),
        location: z.string().optional(),
        description: z.string().optional(),
        attendees: z.array(z.string()).optional().describe('Email addresses to invite'),
        provider: providerEnum.optional(),
      }),
      execute: async ({ title, start, end, all_day, location, description, attendees, provider }) => {
        const member = requireMember(ctx)
        const clients = provider ? [clientFor(member.id, provider)] : await clientsFor(member.id)
        if (clients.length === 0) return { error: 'No calendar linked. Send /connect to link one.' }

        const span = resolveSpan(start, end, all_day)
        try {
          const created = await clients[0].createEvent({
            title,
            start: span.startAt,
            end: span.endAt,
            allDay: span.allDay,
            location,
            description,
            attendees,
          })
          return {
            created,
            provider: clients[0].provider,
            start_local: span.allDay ? formatLocalDate(span.startAt) : formatLocal(span.startAt),
          }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),
  }
}

function describe(e: unknown): string {
  if (e instanceof NotConnectedError) {
    return `No ${e.provider} account linked. Send /connect to link one.`
  }
  if (e instanceof ReconnectNeededError) {
    return `The ${e.provider} link has expired or been revoked. Send /connect to link it again.`
  }
  return describeError(e)
}
