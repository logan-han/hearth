import { MAX_EVENTS, type AccountClient, type CalendarEvent } from './types'
import { accessTokenFor } from './token'
import { timezone } from '../env'
import { localDateKey, tzOffsetMs } from '../cron'
import { unconfirmedOnTimeout } from '../deadline'
import { callGoogleTool, CALENDAR_MCP } from './google-mcp'

type GEvent = {
  id: string
  summary?: string
  location?: string
  organizer?: { email?: string }
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

function toEvent(e: GEvent): CalendarEvent {
  const allDay = Boolean(e.start?.date)
  return {
    id: e.id,
    title: e.summary ?? '(untitled)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    allDay,
    location: e.location,
    organizer: e.organizer?.email,
  }
}

/** An instant as the household's wall clock reads it, with no offset: how the calendar server takes a time beside its zone. */
const wallClock = (at: Date) => new Date(at.getTime() + tzOffsetMs(at, timezone())).toISOString().slice(0, 19)

/** A member's Google Calendar, through Google's Calendar MCP server. */
export function googleClient(memberId: number): AccountClient {
  const token = () => accessTokenFor(memberId, 'google')

  return {
    provider: 'google',

    async listEvents(from, to) {
      const t = await token()
      const events: CalendarEvent[] = []
      let pageToken: string | undefined
      for (;;) {
        const res = (await callGoogleTool(CALENDAR_MCP, t, 'list_events', {
          calendarId: 'primary',
          startTime: from.toISOString(),
          endTime: to.toISOString(),
          orderBy: 'startTime',
          // One past the most that is listed, so a range with more can say so.
          pageSize: MAX_EVENTS + 1,
          ...(pageToken ? { pageToken } : {}),
        })) as { events?: GEvent[]; nextPageToken?: string } | undefined
        events.push(...(res?.events ?? []).map(toEvent))
        // A page can come back short, even empty, with more behind it: the
        // token says whether the range is done, not the count.
        if (!res?.nextPageToken || events.length > MAX_EVENTS) break
        pageToken = res.nextPageToken
      }
      return { events: events.slice(0, MAX_EVENTS), more: events.length > MAX_EVENTS }
    },

    async createEvent(input) {
      const t = await token()
      // An all-day event runs midnight to midnight on the household's dates,
      // end exclusive; the UTC date of a Melbourne midnight is the day before.
      const at = (d: Date) => (input.allDay ? `${localDateKey(d)}T00:00:00` : wallClock(d))
      const created = await unconfirmedOnTimeout(() =>
        callGoogleTool(CALENDAR_MCP, t, 'create_event', {
          summary: input.title,
          startTime: at(input.start),
          endTime: at(input.end),
          timeZone: timezone(),
          ...(input.allDay ? { allDay: true } : {}),
          ...(input.location ? { location: input.location } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.attendees?.length ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
          // Guests are put on the event without an email about it, as a person
          // adding it in the calendar would choose to.
          notificationLevel: 'NONE',
        }),
      )
      return toEvent(created as GEvent)
    },
  }
}
