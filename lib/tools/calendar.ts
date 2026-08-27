import { tool } from 'ai'
import { z } from 'zod'
import { clientFor, clientsFor } from '../providers'
import { NotConnectedError } from '../providers/token'
import { localToUtc, formatLocal } from '../cron'
import { timezone } from '../env'
import type { ToolContext } from './context'
import { requireMember } from './context'

const providerEnum = z.enum(['google', 'microsoft'])

const LOCAL_DATETIME = z
  .string()
  .describe(`Local ${timezone()} time as YYYY-MM-DDTHH:mm (or YYYY-MM-DD for all-day)`)

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
        end: LOCAL_DATETIME.optional().describe('Defaults to one hour after start'),
        all_day: z.boolean().default(false),
        location: z.string().optional(),
        description: z.string().optional(),
        attendees: z.array(z.string()).optional().describe('Email addresses to invite'),
        provider: providerEnum.optional(),
      }),
      execute: async ({ title, start, end, all_day, location, description, attendees, provider }) => {
        const member = requireMember(ctx)
        const clients = provider ? [clientFor(member.id, provider)] : await clientsFor(member.id)
        if (clients.length === 0) return { error: 'No calendar linked. Send /connect to link one.' }

        const startAt = localToUtc(start)
        const endAt = end ? localToUtc(end) : new Date(startAt.getTime() + 60 * 60 * 1000)
        try {
          const created = await clients[0].createEvent({
            title,
            start: startAt,
            end: endAt,
            allDay: all_day,
            location,
            description,
            attendees,
          })
          return { created, provider: clients[0].provider, start_local: formatLocal(startAt) }
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
  return e instanceof Error ? e.message : String(e)
}
