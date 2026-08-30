import type { AccountClient, CalendarEvent, DraftMail, MailSummary } from './types'
import { accessTokenFor } from './token'
import { timezone } from '../env'
import { htmlToPlainText } from '../html'

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const GCAL = 'https://www.googleapis.com/calendar/v3/calendars/primary'

async function api<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Google API ${res.status} on ${new URL(url).pathname}: ${body.slice(0, 300)}`)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

type GmailHeader = { name: string; value: string }
type GmailPart = { mimeType?: string; body?: { data?: string; size?: number }; parts?: GmailPart[] }
type GmailMessage = {
  id: string
  snippet?: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailPart & { headers?: GmailHeader[] }
}

function header(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

/** Depth-first search for the best text part; prefers text/plain over text/html. */
function extractBody(part?: GmailPart): string {
  if (!part) return ''
  if (part.body?.data && (part.mimeType === 'text/plain' || !part.mimeType)) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8')
  }
  for (const p of part.parts ?? []) {
    const found = extractBody(p)
    if (found) return found
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    return htmlToPlainText(Buffer.from(part.body.data, 'base64url').toString('utf8'))
  }
  return ''
}

function toSummary(msg: GmailMessage): MailSummary {
  return {
    id: msg.id,
    from: header(msg, 'From'),
    to: header(msg, 'To'),
    subject: header(msg, 'Subject') || '(no subject)',
    snippet: msg.snippet ?? '',
    date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : header(msg, 'Date'),
    unread: msg.labelIds?.includes('UNREAD') ?? false,
  }
}

/** RFC 2047 encoded-word, so non-ASCII subjects survive. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function buildRaw(draft: DraftMail): string {
  const lines = [
    `To: ${draft.to.join(', ')}`,
    ...(draft.cc?.length ? [`Cc: ${draft.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(draft.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(draft.body, 'utf8').toString('base64'),
  ]
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

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

export function googleClient(memberId: number): AccountClient {
  const token = () => accessTokenFor(memberId, 'google')

  return {
    provider: 'google',

    async listMail({ query, limit = 10, scope = 'inbox' }) {
      const t = await token()
      const url = new URL(`${GMAIL}/messages`)
      url.searchParams.set('maxResults', String(Math.min(limit, 25)))
      // Archived mail has no folder in Gmail, only a missing INBOX label, so
      // "everything" is the absence of in:inbox (sent mail excluded on top).
      const q = scope === 'all'
        ? (query || 'newer_than:14d') + ' -in:sent -in:chats'
        : `in:inbox ${query || 'newer_than:14d'}`
      url.searchParams.set('q', q)
      const list = await api<{ messages?: { id: string }[] }>(t, url.toString())
      const ids = (list.messages ?? []).slice(0, limit).map((m) => m.id)
      const full = await Promise.all(
        ids.map((id) =>
          api<GmailMessage>(
            t,
            `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          ),
        ),
      )
      return full.map(toSummary)
    },

    async readMail(id) {
      const t = await token()
      const msg = await api<GmailMessage>(t, `${GMAIL}/messages/${id}?format=full`)
      return { ...toSummary(msg), body: extractBody(msg.payload).slice(0, 6000) }
    },

    async sendMail(draft) {
      const t = await token()
      await api(t, `${GMAIL}/messages/send`, {
        method: 'POST',
        body: JSON.stringify({ raw: buildRaw(draft) }),
      })
      return { ok: true as const }
    },

    async listEvents(from, to) {
      const t = await token()
      const url = new URL(`${GCAL}/events`)
      url.searchParams.set('timeMin', from.toISOString())
      url.searchParams.set('timeMax', to.toISOString())
      url.searchParams.set('singleEvents', 'true')
      url.searchParams.set('orderBy', 'startTime')
      url.searchParams.set('maxResults', '50')
      const res = await api<{ items?: GEvent[] }>(t, url.toString())
      return (res.items ?? []).map(toEvent)
    },

    async createEvent(input) {
      const t = await token()
      const body = {
        summary: input.title,
        location: input.location,
        description: input.description,
        start: input.allDay
          ? { date: input.start.toISOString().slice(0, 10) }
          : { dateTime: input.start.toISOString(), timeZone: timezone() },
        end: input.allDay
          ? { date: input.end.toISOString().slice(0, 10) }
          : { dateTime: input.end.toISOString(), timeZone: timezone() },
        attendees: input.attendees?.map((email) => ({ email })),
      }
      const created = await api<GEvent>(t, `${GCAL}/events`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      return toEvent(created)
    },
  }
}
