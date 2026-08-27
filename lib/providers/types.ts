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

export type MailBody = MailSummary & { body: string }

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
  listMail(opts: { query?: string; limit?: number; scope?: 'inbox' | 'all' }): Promise<MailSummary[]>
  readMail(id: string): Promise<MailBody>
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
