import { tool } from 'ai'
import { z } from 'zod'
import {
  addFamilyEvent, listFamilyEvents, cancelFamilyEvent, updateFamilyEvent, getFamilyEvent, calendarToken,
} from '../db/queries'
import { localToUtc, formatLocal, formatLocalDate } from '../cron'
import { timezone, appUrl } from '../env'
import type { ToolContext } from './context'

const LOCAL_DATETIME = z
  .string()
  .describe(`Local ${timezone()} time as YYYY-MM-DDTHH:mm (or YYYY-MM-DD for all-day)`)

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/**
 * Read a start and optional end the way the model gives them. A date with no
 * time IS an all-day event: the model omitted the time because it does not
 * know one, and midnight would be an invention. All-day ends are exclusive,
 * so a one-day event runs to the next local midnight.
 */
function resolveTimes(input: { start: string; end?: string; allDay: boolean }): {
  startsAt: Date
  endsAt: Date
  allDay: boolean
} {
  const start = input.start.trim()
  const allDay = input.allDay || DATE_ONLY.test(start)
  if (allDay) {
    const startsAt = localToUtc(start.slice(0, 10))
    const endBase = input.end ? localToUtc(input.end.trim().slice(0, 10)) : startsAt
    const endsAt = endBase.getTime() > startsAt.getTime() ? endBase : new Date(startsAt.getTime() + DAY_MS)
    return { startsAt, endsAt, allDay }
  }
  const startsAt = localToUtc(start)
  const endsAt = input.end ? localToUtc(input.end) : new Date(startsAt.getTime() + 60 * 60 * 1000)
  return { startsAt, endsAt, allDay }
}

/** When an event is, worded for a chat: a date alone for all-day, else date and time. */
export function whenLabel(startsAt: Date, allDay: boolean): string {
  return allDay ? formatLocalDate(startsAt) : formatLocal(startsAt)
}

/**
 * The same title at the same instant is the same event; adding it twice would
 * duplicate it on every subscribed calendar.
 */
async function findClash(title: string, startsAt: Date, endsAt: Date, ignoreId?: number) {
  return (await listFamilyEvents(startsAt, endsAt)).find(
    (e) =>
      !e.cancelled &&
      e.id !== ignoreId &&
      e.startsAt.getTime() === startsAt.getTime() &&
      e.title.trim().toLowerCase() === title.trim().toLowerCase(),
  )
}

const FEED_NOTE = 'Subscribed calendars may take a few hours to show this; it has been announced in the chat.'

export function familyCalendarTools(ctx: ToolContext) {
  return {
    add_family_event: tool({
      description:
        'Add an event to the SHARED family calendar that everyone subscribes to. Use this for anything the whole household needs to see: sports, school events, appointments affecting others, trips. ' +
        'When no specific time is known, pass the date alone (YYYY-MM-DD): it becomes an all-day event, never a midnight one. ' +
        'To change an event that is already there, use update_family_event instead of adding a second one.',
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
        const { startsAt, endsAt, allDay } = resolveTimes({ start, end, allDay: all_day })

        const clash = await findClash(title, startsAt, endsAt)
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
        ctx.notices.push(`Added to the family calendar: **${title}** — ${whenLabel(startsAt, allDay)}`)
        return {
          id: event.id,
          title: event.title,
          start_local: formatLocal(startsAt),
          all_day: allDay,
          note: FEED_NOTE,
        }
      },
    }),

    update_family_event: tool({
      description:
        'Change an event already on the shared family calendar: its title, date, time, location or description. ' +
        'This is how to "replace", "rename", "move" or "reschedule" something: one call, and every subscribed calendar updates that entry instead of showing a cancellation beside a new event. ' +
        'Take the id from list_family_events. Only the fields given change; a new start keeps the old duration unless an end is given too.',
      inputSchema: z.object({
        id: z.number().int(),
        title: z.string().optional(),
        start: LOCAL_DATETIME.optional(),
        end: LOCAL_DATETIME.optional(),
        all_day: z.boolean().optional(),
        location: z.string().nullable().optional().describe('Pass null to clear it'),
        description: z.string().nullable().optional().describe('Pass null to clear it'),
      }),
      execute: async ({ id, title, start, end, all_day, location, description }) => {
        const existing = await getFamilyEvent(id)
        if (!existing || existing.cancelled) return { error: `No live family event ${id}. Use list_family_events to find the right id.` }

        const patch: Parameters<typeof updateFamilyEvent>[1] = {}
        if (title !== undefined && title.trim()) patch.title = title.trim()
        if (location !== undefined) patch.location = location
        if (description !== undefined) patch.description = description

        if (start !== undefined || end !== undefined || all_day !== undefined) {
          const allDay = all_day ?? (start !== undefined ? DATE_ONLY.test(start.trim()) : existing.allDay)
          if (start !== undefined) {
            const times = resolveTimes({ start, end, allDay })
            // A moved event keeps its length unless told otherwise.
            const endsAt = end !== undefined || allDay
              ? times.endsAt
              : new Date(times.startsAt.getTime() + (existing.endsAt.getTime() - existing.startsAt.getTime()))
            Object.assign(patch, { startsAt: times.startsAt, endsAt, allDay })
          } else {
            const endsAt = end !== undefined
              ? (allDay ? localToUtc(end.trim().slice(0, 10)) : localToUtc(end))
              : existing.endsAt
            Object.assign(patch, { endsAt: endsAt.getTime() > existing.startsAt.getTime() ? endsAt : new Date(existing.startsAt.getTime() + (allDay ? DAY_MS : 3_600_000)), allDay })
          }
        }
        if (Object.keys(patch).length === 0) return { error: 'Nothing to change: give a new title, time, location or description.' }

        const nextTitle = patch.title ?? existing.title
        const nextStart = patch.startsAt ?? existing.startsAt
        const nextEnd = patch.endsAt ?? existing.endsAt
        const clash = await findClash(nextTitle, nextStart, nextEnd, id)
        if (clash) {
          return {
            error: `Another event with that title is already at that time (id ${clash.id}); cancel one of them instead of making two.`,
          }
        }

        const row = await updateFamilyEvent(id, patch)
        if (!row) return { error: `No live family event ${id}.` }
        const changed = Object.keys(patch).map((k) => (k === 'startsAt' ? 'start' : k === 'endsAt' ? 'end' : k === 'allDay' ? 'all-day' : k))
        ctx.notices.push(
          `Updated on the family calendar: **${row.title}** — ${whenLabel(row.startsAt, row.allDay)}` +
            (existing.title !== row.title ? ` (was "${existing.title}")` : ''),
        )
        return {
          id: row.id,
          title: row.title,
          start_local: formatLocal(row.startsAt),
          all_day: row.allDay,
          changed,
          note: 'Subscribed calendars pick the change up on their next refresh, which can take hours; it has been announced in the chat.',
        }
      },
    }),

    import_calendar_file: tool({
      description:
        'Add the events from a calendar file (.ics) attached to THIS message to the shared family calendar, all in one call. ' +
        'Use it when someone sends a .ics and asks for it to go on the calendar; do not re-add the events one by one with add_family_event. ' +
        'Events already on the calendar are left alone, and repeating events are reported rather than added.',
      inputSchema: z.object({
        only: z
          .array(z.string())
          .optional()
          .describe('Titles (or parts of titles) to include, when the person wants some of the events rather than all of them'),
      }),
      execute: async ({ only }) => {
        const files = ctx.calendarFiles ?? []
        if (files.length === 0) {
          return {
            error:
              'No calendar file is attached to this message. A file can only be read in the message it arrives with, so ask for the .ics to be sent again with the request written as its caption.',
          }
        }
        const wanted = (only ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean)
        const matches = (title: string) => wanted.length === 0 || wanted.some((w) => title.toLowerCase().includes(w))

        const added: { id: number; title: string; when: string }[] = []
        const alreadyThere: string[] = []
        const repeating: string[] = []
        let leftOut = 0
        for (const file of files) {
          leftOut += file.parsed.skipped
          for (const e of file.parsed.events) {
            if (!matches(e.title)) continue
            if (e.repeats) {
              repeating.push(e.title)
              continue
            }
            if (await findClash(e.title, e.startsAt, e.endsAt)) {
              alreadyThere.push(e.title)
              continue
            }
            const row = await addFamilyEvent({
              title: e.title,
              description: e.description,
              location: e.location,
              startsAt: e.startsAt,
              endsAt: e.endsAt,
              allDay: e.allDay,
              createdBy: ctx.member?.id ?? null,
            })
            added.push({ id: row.id, title: e.title, when: whenLabel(e.startsAt, e.allDay) })
          }
        }
        if (added.length) {
          const names = files.map((f) => f.filename).join(', ')
          ctx.notices.push(
            `Added to the family calendar from ${names}:\n${added.map((a) => `· **${a.title}** — ${a.when}`).join('\n')}`,
          )
        }
        return {
          added,
          already_on_calendar: alreadyThere,
          repeating_not_added: repeating,
          unreadable_or_cancelled: leftOut,
          note:
            added.length > 0
              ? FEED_NOTE
              : 'Nothing was added. Say so, and say why: already on the calendar, repeating, or nothing matched.',
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
