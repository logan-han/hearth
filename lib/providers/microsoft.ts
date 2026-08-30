import type { AccountClient, CalendarEvent, MailSummary } from './types'
import { accessTokenFor } from './token'
import { timezone } from '../env'
import { htmlToPlainText } from '../html'

const GRAPH = 'https://graph.microsoft.com/v1.0/me'

async function api<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Graph API ${res.status} on ${new URL(url).pathname}: ${body.slice(0, 300)}`)
  }
  if (res.status === 202 || res.status === 204) return undefined as T
  return (await res.json()) as T
}

type GraphAddress = { emailAddress?: { address?: string; name?: string } }
type GraphMessage = {
  id: string
  subject?: string
  bodyPreview?: string
  isRead?: boolean
  receivedDateTime?: string
  from?: GraphAddress
  toRecipients?: GraphAddress[]
  body?: { contentType?: string; content?: string }
}

function addr(a?: GraphAddress): string {
  if (!a?.emailAddress) return ''
  const { name, address } = a.emailAddress
  return name && address && name !== address ? `${name} <${address}>` : (address ?? name ?? '')
}

function toSummary(m: GraphMessage): MailSummary {
  return {
    id: m.id,
    from: addr(m.from),
    to: (m.toRecipients ?? []).map(addr).filter(Boolean).join(', '),
    subject: m.subject || '(no subject)',
    snippet: m.bodyPreview ?? '',
    date: m.receivedDateTime ?? '',
    unread: m.isRead === false,
  }
}

function plainText(body?: { contentType?: string; content?: string }): string {
  const content = body?.content ?? ''
  return (body?.contentType ?? '').toLowerCase() === 'html' ? htmlToPlainText(content) : content
}

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

    async listMail({ query, limit = 10, scope = 'inbox' }) {
      const t = await token()
      // /messages spans every folder including Archive; the inbox is its own.
      const url = new URL(scope === 'all' ? `${GRAPH}/messages` : `${GRAPH}/mailFolders/inbox/messages`)
      url.searchParams.set('$top', String(Math.min(limit, 25)))
      url.searchParams.set('$select', 'id,subject,bodyPreview,isRead,receivedDateTime,from,toRecipients')
      if (query) {
        // $search cannot be combined with $orderby in Graph.
        url.searchParams.set('$search', `"${query.replace(/"/g, '')}"`)
      } else {
        url.searchParams.set('$orderby', 'receivedDateTime desc')
      }
      const res = await api<{ value?: GraphMessage[] }>(t, url.toString(), {
        headers: { ConsistencyLevel: 'eventual' },
      })
      return (res.value ?? []).map(toSummary)
    },

    async readMail(id) {
      const t = await token()
      const m = await api<GraphMessage>(t, `${GRAPH}/messages/${id}`)
      return { ...toSummary(m), body: plainText(m.body).slice(0, 6000) }
    },

    async sendMail(draft) {
      const t = await token()
      await api(t, `${GRAPH}/sendMail`, {
        method: 'POST',
        body: JSON.stringify({
          message: {
            subject: draft.subject,
            body: { contentType: 'Text', content: draft.body },
            toRecipients: draft.to.map((address) => ({ emailAddress: { address } })),
            ccRecipients: (draft.cc ?? []).map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: true,
        }),
      })
      return { ok: true as const }
    },

    async listEvents(from, to) {
      const t = await token()
      const url = new URL(`${GRAPH}/calendarView`)
      url.searchParams.set('startDateTime', from.toISOString())
      url.searchParams.set('endDateTime', to.toISOString())
      url.searchParams.set('$orderby', 'start/dateTime')
      url.searchParams.set('$top', '50')
      const res = await api<{ value?: GraphEvent[] }>(t, url.toString(), {
        headers: { Prefer: 'outlook.timezone="UTC"' },
      })
      return (res.value ?? []).map(toEvent)
    },

    async createEvent(input) {
      const t = await token()
      const created = await api<GraphEvent>(t, `${GRAPH}/events`, {
        method: 'POST',
        body: JSON.stringify({
          subject: input.title,
          body: input.description ? { contentType: 'Text', content: input.description } : undefined,
          location: input.location ? { displayName: input.location } : undefined,
          isAllDay: input.allDay ?? false,
          start: { dateTime: input.start.toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
          end: { dateTime: input.end.toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
          attendees: input.attendees?.map((address) => ({
            emailAddress: { address },
            type: 'required',
          })),
        }),
      })
      return toEvent(created)
    },
  }
}
