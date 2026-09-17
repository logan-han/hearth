import type { ToolName } from './tools'

/**
 * Ready-made watchers: the proactive half of the bot. The tick route fetches
 * the data for each kind in code first, so a run with nothing new never
 * reaches a model, and the model's job shrinks to phrasing what was found.
 * That is also why every instruction here is about wording, never about
 * which tool to call: the data arrives under DATA in the prompt.
 *
 * The built-in ones are part of the product rather than something a member
 * has to ask for: the tick installs them in every household group chat and
 * keeps them in step with the definitions here, and Home offers a pause
 * rather than a delete. The rest are switched on with /watch.
 */
export type WatcherKind = 'money' | 'morning' | 'snapshot'

export type Watcher = {
  kind: WatcherKind
  label: string
  cron: string
  /** Installed in every household group chat without anyone asking. */
  builtin: boolean
  /** How to phrase what was fetched. Grounding rules, not tool routing. */
  instruction: string
  /** The few tools the model may call for context while phrasing. */
  tools: ToolName[]
}

export const WATCHERS: Record<WatcherKind, Watcher> = {
  morning: {
    kind: 'morning',
    label: 'Morning brief',
    cron: '0 7 * * *',
    builtin: true,
    instruction: [
      "Today's family calendar, the mail that has arrived since the last brief, the household board and the weather are under DATA. Post one short brief for the day.",
      'First what is on today, with its time and place as given. Then what in the mail the household would act on: anything with a date, a deadline, a payment or a delivery in it (appointments, notices, bills, bookings, tickets), whoever sent it and however many people it went to; leave out newsletters and promotions, the mail with nothing in it to attend, book, pay or reply to.',
      'For each item say what it is and what it asks for, using only what the email says; open one with read_email when the snippet is not enough. Propose any calendar-worthy date with propose_family_event.',
      'Then anything overdue on the board. Flag only what the data supports: an early start, something overdue, rain in the forecast.',
      'If DATA lists questions, end with "Not sure about:" and each question on its own line, worded as given, and say that anyone can answer here or on Home. Nothing under DATA answers them, so do not guess.',
    ].join(' '),
    tools: ['recall', 'read_email', 'propose_family_event', 'list_family_events'],
  },
  snapshot: {
    kind: 'snapshot',
    label: 'Money snapshot',
    cron: '0 18 * * 0',
    builtin: true,
    instruction: [
      "The household's spending for the past week and for the month so far, and the month's budget where there is one, are under DATA. Post the weekly money snapshot.",
      'Open with a **bold** title line naming the week. Then a table of the figures: spent this week, spent this month so far, and the budget used with how far through the month it is. Then the week\'s largest payments as bullets, each with payee, amount and category as given. Then any category over budget, with its position as given.',
      'Figures exactly as given, no arithmetic of your own, no advice. Say what a payment was for only when a Known household fact or a note on the transaction names it, and say which.',
    ].join(' '),
    tools: ['recall'],
  },
  money: {
    kind: 'money',
    label: '2Up transactions',
    cron: '0 9-22 * * *',
    builtin: false,
    instruction: [
      'New 2Up transactions are listed under DATA. Post one line per transaction: payee as shown, amount, date.',
      'Add a purpose only if a Known household fact, a family calendar event or an email you fetch names that payee, and say which in brackets.',
      'If nothing names it, write "purpose not recorded".',
      'Each transaction carries flags worked out from the feed: new_payee, unusually_large, possible_duplicate, money_in. Mention a flag in plain words only when it is there; an empty list means nothing stood out.',
      'A payee string is a trading name and a registered city, never a place the household went or a trip they booked.',
    ].join(' '),
    tools: ['recall', 'list_family_events', 'list_email'],
  },
}

/** The watchers every household group gets, in the order Home lists them. */
export const BUILTIN_WATCHERS: Watcher[] = Object.values(WATCHERS).filter((w) => w.builtin)

export function isWatcherKind(value: string | null | undefined): value is WatcherKind {
  return value === 'money' || value === 'morning' || value === 'snapshot'
}

export function isBuiltinKind(value: string | null | undefined): boolean {
  return isWatcherKind(value) && WATCHERS[value].builtin
}

/** Telegram gives groups negative ids; a private chat's id is the person's own. */
export const isGroupChat = (chatId: string) => chatId.startsWith('-')

/**
 * The instruction as stored and as prompted: in a group the brief reads
 * several people's mail into one room, so each item says whose it was. Whose
 * means the person: a brief once labelled its mail "(google)" and
 * "(microsoft)", which names nobody.
 */
export function watcherInstruction(kind: WatcherKind, chatId: string): string {
  const base = WATCHERS[kind].instruction
  return kind === 'morning' && isGroupChat(chatId)
    ? `${base} Say whose mailbox each item came from, as its mailbox field names it: a person, never a provider.`
    : base
}
