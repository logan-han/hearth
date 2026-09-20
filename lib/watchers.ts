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
      "Today's family calendar, the mail that has arrived since the last brief, the household board and the weather are under DATA. Post one short brief for the day in named parts, each a **bold** line with its bullets under it; leave out a part with nothing in it.",
      '**Today**: what is on, with its time and place as given, and a flag only where the data supports one: an early start, rain in the forecast.',
      'Mail: first set aside what gets no bullet: newsletters and promotions, the mail with nothing in it to attend, book, pay or reply to; and mail whose moment has passed by NOW, however recently it arrived: a collection, a booking or an event timed earlier than NOW, an order already delivered. Then sort the rest into two parts.',
      '**To do**: mail asking the household for something still open: a payment, a signature, a reply, a form, a booking to make, an appointment or a deadline still ahead, whoever sent it and however many people it went to.',
      '**Heads up**: mail that only tells the household something worth knowing: an order or a connection confirmed, a delivery on its way, a change to an account or a service.',
      'One bullet per email, in your own words: who sent it and what it says or asks, with every date, time, amount and place exactly as given. Never paste the subject line or put it in quotes. Open an email with read_email when its snippet is not enough. Propose any calendar-worthy date still ahead with propose_family_event.',
      '**Overdue**: anything overdue on the board, as given.',
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
      'Open with a **bold** title line naming the week by its dates, in the form "Money snapshot, 7 to 13 Jun". Then a two-column pipe table with an empty header row (| | |) and four short rows: "This week" and its spend, "This month so far" and its spend, "Budget used" and its percentage, "Month elapsed" and the days as given, such as 20 of 30 days.',
      'Then **Largest payments**: the week\'s largest as bullets, each payee, amount and category as given. Add what one was for only when a note on it or a Known household fact names it, and say which; otherwise say nothing about its purpose.',
      'Then **Over budget**: a two-column pipe table with the header row | Category | Over by |, a row for each category whose position says over, giving the amount from its position; leave out categories under or on budget and categories with no budget set. If DATA lists rollover_used_up, end with one line, "Nothing left this month after rollover:" and those categories as given.',
      'Figures exactly as given, no arithmetic of your own, no advice.',
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
