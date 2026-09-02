import type { ToolName } from './tools'

/**
 * Ready-made watchers: the proactive half of the bot. The tick route fetches
 * the data for each kind in code first, so a run with nothing new never
 * reaches a model, and the model's job shrinks to phrasing what was found.
 * That is also why every instruction here is about wording, never about
 * which tool to call: the data arrives under DATA in the prompt.
 */
export type WatcherKind = 'money' | 'inbox' | 'morning'

export type Watcher = {
  kind: WatcherKind
  label: string
  cron: string
  /** What must be set up before this watcher can be switched on. */
  needs?: string
  /** How to phrase what was fetched. Grounding rules, not tool routing. */
  instruction: string
  /** The few tools the model may call for context while phrasing. */
  tools: ToolName[]
}

export const WATCHERS: Record<WatcherKind, Watcher> = {
  money: {
    kind: 'money',
    label: '2Up transactions',
    cron: '0 9-22 * * *',
    instruction: [
      'New 2Up transactions are listed under DATA. Post one line per transaction: payee as shown, amount, date.',
      'Add a purpose only if a Known household fact, a family calendar event or an email you fetch names that payee, and say which in brackets.',
      'If nothing names it, write "purpose not recorded".',
      'Each transaction carries flags worked out from the feed: new_payee, unusually_large, possible_duplicate, money_in. Mention a flag in plain words only when it is there; an empty list means nothing stood out.',
      'A payee string is a trading name and a registered city, never a place the household went or a trip they booked.',
    ].join(' '),
    tools: ['recall', 'list_family_events', 'list_email'],
  },
  inbox: {
    kind: 'inbox',
    label: 'Inbox sweep',
    cron: '45 7 * * *',
    needs: 'a linked email account (send /connect first)',
    instruction: [
      'New email is listed under DATA. Mention only what the household would act on: appointments, school notices, bills, deliveries, bookings. Leave out newsletters and promotions.',
      'For each item say what it is and what it asks for, using only what the email says; open one with read_email when the snippet is not enough.',
      'Propose any calendar-worthy date with propose_family_event.',
    ].join(' '),
    tools: ['read_email', 'propose_family_event', 'list_family_events', 'recall'],
  },
  morning: {
    kind: 'morning',
    label: 'Morning brief',
    cron: '0 7 * * 1-5',
    instruction: [
      "Today's family calendar, the board and the weather are under DATA. Post one short brief for the day.",
      'Flag only what the data supports: an early start, a form or payment due, an umbrella if rain is forecast.',
    ].join(' '),
    tools: ['recall'],
  },
}

export function isWatcherKind(value: string | null | undefined): value is WatcherKind {
  return value === 'money' || value === 'inbox' || value === 'morning'
}
