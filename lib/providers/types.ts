import type { Provider } from '../oauth/providers'

export type MailSummary = {
  id: string
  from: string
  to: string
  subject: string
  snippet: string
  date: string
  unread: boolean
}

/** A file attached to an email, named the way the model refers to it. */
export type MailAttachment = {
  filename: string
  mimeType: string
  size: number
}

export type MailBody = MailSummary & { body: string; attachments: MailAttachment[] }

/** The attachment itself, once fetched. */
export type MailFile = MailAttachment & { bytes: Uint8Array }

export type CalendarEvent = {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
  organizer?: string
}

export type DraftMail = {
  to: string[]
  cc?: string[]
  subject: string
  body: string
}

/** Everything the agent can do against one member's linked account. */
export interface AccountClient {
  provider: Provider
  /** scope 'all' spans the whole mailbox (archive included); default is the inbox. */
  /**
   * Newest first. With `since`, only mail received at or after it, so a sweep
   * reads exactly what arrived since it last looked rather than the newest
   * few of a fortnight. At most 50.
   */
  listMail(opts: { query?: string; limit?: number; scope?: 'inbox' | 'all'; since?: Date }): Promise<MailSummary[]>
  readMail(id: string): Promise<MailBody>
  /**
   * One attachment of a message, by the filename readMail listed. Names are
   * what a model can copy; a provider's attachment id runs to hundreds of
   * characters on Gmail and is not stable between reads.
   */
  readAttachment(messageId: string, filename: string): Promise<MailFile>
  sendMail(draft: DraftMail): Promise<{ ok: true }>
  listEvents(from: Date, to: Date): Promise<CalendarEvent[]>
  createEvent(input: {
    title: string
    start: Date
    end: Date
    allDay?: boolean
    location?: string
    description?: string
    attendees?: string[]
  }): Promise<CalendarEvent>
}
