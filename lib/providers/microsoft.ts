import { MAX_EVENTS, type AccountClient, type CalendarEvent, type MailAttachment, type MailSummary } from './types'
import { accessTokenFor } from './token'
import { timezone } from '../env'
import { localDateKey } from '../cron'
import { htmlToPlainText } from '../html'
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
type GraphMessage = {
  id: string
  subject?: string
  bodyPreview?: string
  isRead?: boolean
  receivedDateTime?: string
  from?: GraphAddress
  toRecipients?: GraphAddress[]
  body?: { contentType?: string; content?: string }
  hasAttachments?: boolean
}

type GraphAttachment = {
  '@odata.type'?: string
  id: string
  name?: string
  contentType?: string
  size?: number
  isInline?: boolean
  /** Base64, present on a file attachment fetched on its own. */
  contentBytes?: string
}

const FILE_ATTACHMENT = '#microsoft.graph.fileAttachment'

/** A file someone attached, as opposed to an inline picture or a linked item. */
const isFile = (a: GraphAttachment) => !a.isInline && (a['@odata.type'] ?? FILE_ATTACHMENT) === FILE_ATTACHMENT

function toAttachment(a: GraphAttachment): MailAttachment {
  return { filename: a.name ?? 'attachment', mimeType: a.contentType ?? 'application/octet-stream', size: a.size ?? 0 }
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

/** The attachments of one message, without their bytes. */
async function fileAttachments(token: string, messageId: string): Promise<GraphAttachment[]> {
  const url = new URL(`${GRAPH}/messages/${messageId}/attachments`)
  url.searchParams.set('$select', 'id,name,contentType,size,isInline')
  const res = await api<{ value?: GraphAttachment[] }>(token, url.toString())
  return (res.value ?? []).filter(isFile)
}

export function microsoftClient(memberId: number): AccountClient {
  const token = () => accessTokenFor(memberId, 'microsoft')

  return {
    provider: 'microsoft',

    async listMail({ query, limit = 10, scope = 'inbox', since }) {
      const t = await token()
      // /messages spans every folder including Archive; the inbox is its own.
      const url = new URL(scope === 'all' ? `${GRAPH}/messages` : `${GRAPH}/mailFolders/inbox/messages`)
      url.searchParams.set('$top', String(Math.min(limit, 50)))
      url.searchParams.set('$select', 'id,subject,bodyPreview,isRead,receivedDateTime,from,toRecipients')
      if (query) {
        // $search cannot be combined with $orderby (or $filter) in Graph.
        url.searchParams.set('$search', `"${query.replace(/"/g, '')}"`)
      } else {
        // A sweep asks for what arrived since it last looked. Graph wants a
        // property it orders by to lead the filter, which this one does.
        if (since) url.searchParams.set('$filter', `receivedDateTime ge ${since.toISOString()}`)
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
      // The listing is a second call, so it is made only when the message says
      // there is something to list.
      const attachments = m.hasAttachments ? (await fileAttachments(t, id)).map(toAttachment) : []
      return { ...toSummary(m), body: plainText(m.body).slice(0, 6000), attachments }
    },

    async readAttachment(messageId, filename) {
      const t = await token()
      const wanted = filename.trim().toLowerCase()
      const found = (await fileAttachments(t, messageId)).find((a) => (a.name ?? '').toLowerCase() === wanted)
      if (!found) throw new Error(`No attachment called "${filename}" on that email.`)
      const full = await api<GraphAttachment>(t, `${GRAPH}/messages/${messageId}/attachments/${encodeURIComponent(found.id)}`)
      const bytes = new Uint8Array(Buffer.from(full.contentBytes ?? '', 'base64'))
      return { ...toAttachment({ ...found, ...full }), size: bytes.byteLength, bytes }
    },

    async sendMail(draft) {
      const t = await token()
      await unconfirmedOnTimeout(() => api(t, `${GRAPH}/sendMail`, {
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
      }))
      return { ok: true as const }
    },

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
