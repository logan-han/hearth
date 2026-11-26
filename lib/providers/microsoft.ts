import { MAX_EVENTS, type AccountClient, type CalendarEvent } from './types'
import { accessTokenFor } from './token'
import { timezone } from '../env'
import { localDateKey } from '../cron'
import { deadline, unconfirmedOnTimeout } from '../deadline'

const GRAPH = 'https://graph.microsoft.com/v1.0/me'

async function api<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    signal: deadline(),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Graph API ${res.status} on ${new URL(url).pathname}: ${body.slice(0, 300)}`)
  }
  if (res.status === 202 || res.status === 204) return undefined as T
  return (await res.json()) as T
}

type GraphAddress = { emailAddress?: { address?: string; name?: string } }

type GraphEvent = {
  id: string
  subject?: string
  isAllDay?: boolean
  location?: { displayName?: string }
  organizer?: GraphAddress
  start?: { dateTime?: string; timeZone?: string }
  end?: { dateTime?: string; timeZone?: string }
}

/** Graph returns naive local strings; the Prefer header pins them to our tz. */
function graphTime(t?: { dateTime?: string; timeZone?: string }): string {
  if (!t?.dateTime) return ''
  return /[Zz]|[+-]\d{2}:\d{2}$/.test(t.dateTime) ? t.dateTime : `${t.dateTime}Z`
}

function toEvent(e: GraphEvent): CalendarEvent {
  return {
    id: e.id,
    title: e.subject ?? '(untitled)',
    start: graphTime(e.start),
    end: graphTime(e.end),
    allDay: e.isAllDay ?? false,
    location: e.location?.displayName,
    organizer: e.organizer?.emailAddress?.address,
  }
}

export function microsoftClient(memberId: number): AccountClient {
  const token = () => accessTokenFor(memberId, 'microsoft')

  return {
    provider: 'microsoft',

    async listEvents(from, to) {
      const t = await token()
      const url = new URL(`${GRAPH}/calendarView`)
      url.searchParams.set('startDateTime', from.toISOString())
      url.searchParams.set('endDateTime', to.toISOString())
      url.searchParams.set('$orderby', 'start/dateTime')
      url.searchParams.set('$top', '50')
      const events: CalendarEvent[] = []
      // Graph pages by link, followed to one past the most that is listed, so
      // a range with more can say so.
      for (let next = url.toString(); ; ) {
        const res = await api<{ value?: GraphEvent[]; '@odata.nextLink'?: string }>(t, next, {
          headers: { Prefer: 'outlook.timezone="UTC"' },
        })
        events.push(...(res.value ?? []).map(toEvent))
        if (!res['@odata.nextLink'] || events.length > MAX_EVENTS) break
        next = res['@odata.nextLink']
      }
      return { events: events.slice(0, MAX_EVENTS), more: events.length > MAX_EVENTS }
    },

    async createEvent(input) {
      const t = await token()
      const created = await unconfirmedOnTimeout(() => api<GraphEvent>(t, `${GRAPH}/events`, {
        method: 'POST',
        body: JSON.stringify({
          subject: input.title,
          body: input.description ? { contentType: 'Text', content: input.description } : undefined,
          location: input.location ? { displayName: input.location } : undefined,
          isAllDay: input.allDay ?? false,
          // Graph takes an all-day event only as midnight to midnight in the
          // zone it is given, so it gets the household's dates and zone.
          ...(input.allDay
            ? {
                start: { dateTime: `${localDateKey(input.start)}T00:00:00`, timeZone: timezone() },
                end: { dateTime: `${localDateKey(input.end)}T00:00:00`, timeZone: timezone() },
              }
            : {
                start: { dateTime: input.start.toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
                end: { dateTime: input.end.toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
              }),
          attendees: input.attendees?.map((address) => ({
            emailAddress: { address },
            type: 'required',
          })),
        }),
      }))
      return toEvent(created)
    },
  }
}
