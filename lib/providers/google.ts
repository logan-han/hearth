import type { AccountClient, CalendarEvent, DraftMail, MailAttachment, MailSummary } from './types'
import { accessTokenFor } from './token'
import { timezone } from '../env'
import { localDateKey } from '../cron'
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
type GmailPart = {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailPart[]
}
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

/**
 * An address header quotes a display name with punctuation in it: "Name, Inc."
 * <a@b>. The quotes are the header's, not the sender's, and they were copied
 * into a brief along with the escapes JSON put round them. Graph hands the
 * same name back bare, so the Gmail side does too.
 */
function bareNames(addresses: string): string {
  return addresses.replace(/"((?:[^"\\]|\\.)*)"\s*(?=<)/g, (_, name: string) => `${name.replace(/\\(.)/g, '$1')} `).trim()
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

type FilePart = GmailPart & { filename: string; body: { attachmentId: string } }

/**
 * The parts that are files: named, and stored apart from the message body.
 * A picture the sender's mail client laid into the text (a logo, a signature)
 * is marked inline, and is not something anyone means by "the attachment".
 */
function fileParts(part?: GmailPart): FilePart[] {
  if (!part) return []
  const disposition = part.headers?.find((h) => h.name.toLowerCase() === 'content-disposition')?.value ?? ''
  const inlineImage = /^inline/i.test(disposition) && (part.mimeType ?? '').startsWith('image/')
  const own = part.filename && part.body?.attachmentId && !inlineImage ? [part as FilePart] : []
  return [...own, ...(part.parts ?? []).flatMap(fileParts)]
}

function toAttachment(part: FilePart): MailAttachment {
  return { filename: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', size: part.body.size ?? 0 }
}

function toSummary(msg: GmailMessage): MailSummary {
  return {
    id: msg.id,
    from: bareNames(header(msg, 'From')),
    to: bareNames(header(msg, 'To')),
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

    async listMail({ query, limit = 10, scope = 'inbox', since }) {
      const t = await token()
      const cap = Math.min(limit, 50)
      const url = new URL(`${GMAIL}/messages`)
      url.searchParams.set('maxResults', String(cap))
      // A sweep asks for what arrived since it last looked (after: takes epoch
      // seconds); anything else looks back a fortnight.
      const window = since
        ? [`after:${Math.floor(since.getTime() / 1000)}`, query].filter(Boolean).join(' ')
        : query || 'newer_than:14d'
      // Archived mail has no folder in Gmail, only a missing INBOX label, so
      // "everything" is the absence of in:inbox (sent mail excluded on top).
      const q = scope === 'all' ? `${window} -in:sent -in:chats` : `in:inbox ${window}`
      url.searchParams.set('q', q)
      const list = await api<{ messages?: { id: string }[] }>(t, url.toString())
      const ids = (list.messages ?? []).slice(0, cap).map((m) => m.id)
      // Ten at a time: each read costs quota, and fifty at once would trip
      // Gmail's per-second limit for one user.
      const full: GmailMessage[] = []
      for (let i = 0; i < ids.length; i += 10) {
        full.push(
          ...(await Promise.all(
            ids.slice(i, i + 10).map((id) =>
              api<GmailMessage>(
                t,
                `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
              ),
            ),
          )),
        )
      }
      return full.map(toSummary)
    },

    async readMail(id) {
      const t = await token()
      const msg = await api<GmailMessage>(t, `${GMAIL}/messages/${id}?format=full`)
      return { ...toSummary(msg), body: extractBody(msg.payload).slice(0, 6000), attachments: fileParts(msg.payload).map(toAttachment) }
    },

    async readAttachment(messageId, filename) {
      const t = await token()
      // The message again, for the part behind the name: its attachment id
      // is what the attachments endpoint wants, and it is minted per read.
      const msg = await api<GmailMessage>(t, `${GMAIL}/messages/${messageId}?format=full`)
      const wanted = filename.trim().toLowerCase()
      const part = fileParts(msg.payload).find((p) => p.filename.toLowerCase() === wanted)
      if (!part) throw new Error(`No attachment called "${filename}" on that email.`)
      const file = await api<{ data?: string; size?: number }>(
        t,
        `${GMAIL}/messages/${messageId}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
      )
      const bytes = new Uint8Array(Buffer.from(file.data ?? '', 'base64url'))
      return { ...toAttachment(part), size: bytes.byteLength, bytes }
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
        // An all-day event is a pair of the household's dates, end exclusive.
        // The UTC date of a Melbourne midnight is the day before.
        start: input.allDay
          ? { date: localDateKey(input.start) }
          : { dateTime: input.start.toISOString(), timeZone: timezone() },
        end: input.allDay
          ? { date: localDateKey(input.end) }
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
