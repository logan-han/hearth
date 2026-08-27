import { tool } from 'ai'
import { z } from 'zod'
import { addFamilyEvent, listFamilyEvents, cancelFamilyEvent, calendarToken } from '../db/queries'
import { localToUtc, formatLocal } from '../cron'
import { timezone, appUrl } from '../env'
import type { ToolContext } from './context'

const LOCAL_DATETIME = z
  .string()
  .describe(`Local ${timezone()} time as YYYY-MM-DDTHH:mm (or YYYY-MM-DD for all-day)`)

export function familyCalendarTools(ctx: ToolContext) {
  return {
    add_family_event: tool({
      description:
        'Add an event to the SHARED family calendar that everyone subscribes to. Use this for anything the whole household needs to see: sports, school events, appointments affecting others, trips. ' +
        'When no specific time is known, pass the date alone (YYYY-MM-DD): it becomes an all-day event, never a midnight one.',
      inputSchema: z.object({
        title: z.string(),
        start: LOCAL_DATETIME,
        end: LOCAL_DATETIME.optional().describe('Defaults to one hour after start'),
        all_day: z
          .boolean()
          .default(false)
          .describe('True when the event has no particular time. A date-only start implies this.'),
        location: z.string().optional(),
        description: z.string().optional(),
      }),
      execute: async ({ title, start, end, all_day, location, description }) => {
        // A date with no time IS an all-day event: the model omitted the time
        // because it does not know one, and midnight would be an invention.
        const allDay = all_day || /^\d{4}-\d{2}-\d{2}$/.test(start.trim())

        let startsAt: Date
        let endsAt: Date
        if (allDay) {
          startsAt = localToUtc(start.trim().slice(0, 10))
          const endBase = end ? localToUtc(end.trim().slice(0, 10)) : startsAt
          // Exclusive end: a one-day event runs to the next local midnight.
          endsAt = endBase.getTime() > startsAt.getTime() ? endBase : new Date(startsAt.getTime() + 86_400_000)
        } else {
          startsAt = localToUtc(start)
          endsAt = end ? localToUtc(end) : new Date(startsAt.getTime() + 60 * 60 * 1000)
        }

        // The same title at the same instant is the same event; adding it twice
        // would duplicate it on every subscribed calendar.
        const clash = (await listFamilyEvents(startsAt, endsAt)).find(
          (e) =>
            !e.cancelled &&
            e.startsAt.getTime() === startsAt.getTime() &&
            e.title.trim().toLowerCase() === title.trim().toLowerCase(),
        )
        if (clash) {
          return {
            id: clash.id,
            title: clash.title,
            already_on_calendar: true,
            note: 'An identical event is already on the family calendar; nothing was added.',
          }
        }

        const event = await addFamilyEvent({
          title,
          description,
          location,
          startsAt,
          endsAt,
          allDay,
          createdBy: ctx.member?.id ?? null,
        })
        // Subscribed clients can take hours to re-poll an ICS feed, so the bot
        // announces the event in chat too.
        ctx.notices.push(
          `Added to the family calendar: **${title}** — ${allDay ? formatLocal(startsAt).split(',').slice(0, 3).join(',') : formatLocal(startsAt)}`,
        )
        return {
          id: event.id,
          title: event.title,
          start_local: formatLocal(startsAt),
          all_day: allDay,
          note: 'Subscribed calendars may take a few hours to show this; it has been announced in the chat.',
        }
      },
    }),

    list_family_events: tool({
      description:
        'List events on the shared family calendar within a date range. ' +
        'Set include_cancelled when someone reports seeing an event that should be gone: subscribed calendar apps can keep showing a cancelled event until they next refresh the feed, which can take hours.',
      inputSchema: z.object({
        from: LOCAL_DATETIME,
        to: LOCAL_DATETIME,
        include_cancelled: z.boolean().default(false),
      }),
      execute: async ({ from, to, include_cancelled }) => {
        const events = await listFamilyEvents(localToUtc(from), localToUtc(to))
        return {
          timezone: timezone(),
          events: events
            .filter((e) => include_cancelled || !e.cancelled)
            .map((e) => ({
              id: e.id,
              title: e.title,
              start_local: formatLocal(e.startsAt),
              end_local: formatLocal(e.endsAt),
              all_day: e.allDay,
              location: e.location,
              ...(e.cancelled ? { cancelled: true } : {}),
            })),
        }
      },
    }),

    cancel_family_event: tool({
      description: 'Cancel an event on the shared family calendar by its id (from list_family_events).',
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => {
        const row = await cancelFamilyEvent(id)
        if (!row) return { error: `No family event ${id}.` }
        ctx.notices.push(`Cancelled on the family calendar: **${row.title}**`)
        return { cancelled: true, title: row.title }
      },
    }),

    family_calendar_link: tool({
      description: 'Get the subscription URL for the shared family calendar (an ICS feed).',
      inputSchema: z.object({}),
      execute: async () => ({
        url: `${appUrl()}/api/calendar/${await calendarToken()}/family.ics`,
        how_to:
          'Add it as a "subscribe by URL" calendar in Google Calendar, Outlook, or Apple Calendar. It refreshes automatically.',
      }),
    }),
  }
}
