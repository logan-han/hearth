import type { Provider } from '../oauth/providers'

export type CalendarEvent = {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
  organizer?: string
}

/**
 * The most events one listing returns: a busy working month, with room to spare.
 * A longer range is cut there and says so, rather than ending at whatever one
 * page of the provider's happened to hold and reading as free time after it.
 */
export const MAX_EVENTS = 100

/** Everything the agent can do against one member's linked account: their own calendar. */
export interface AccountClient {
  provider: Provider
  /** Soonest first, at most MAX_EVENTS; `more` when the range holds others after them. */
  listEvents(from: Date, to: Date): Promise<{ events: CalendarEvent[]; more: boolean }>
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
