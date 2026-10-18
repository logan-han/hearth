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
 * rather than a delete. /watch adds them to a private chat, or switches a
 * paused one back on.
 */
export type WatcherKind = 'morning' | 'snapshot'

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
  /** More room than a watcher's usual output budget, for one that writes at length. */
  maxOutputTokens?: number
}

export const WATCHERS: Record<WatcherKind, Watcher> = {
  morning: {
    kind: 'morning',
    label: 'Morning brief',
    cron: '0 7 * * *',
    builtin: true,
    instruction: [
      "Today's calendars (the family calendar under events, and each person's own under calendars), what starts tomorrow, the mail that has arrived since the last brief, the household board, the reminders set for today, the proposals waiting on a yes and the weather are under DATA. Post one short brief for the day in named parts, each a **bold** line with its bullets under it; leave out a part with nothing in it.",
      '**Today**: what is on, from the family calendar and from each calendar under calendars, with its time and place as given, and a flag only where the data supports one: an early start, rain in the forecast.',
      '**Tomorrow**: what starts tomorrow, with its time as given, so the household can get ready tonight.',
      'Mail: first set aside what gets no bullet: newsletters and promotions, the mail with nothing in it to attend, book, pay or reply to; mail whose moment has passed by NOW, however recently it arrived: a collection, a booking or an event timed earlier than NOW, an order already delivered; and a request that is done, which is one a later email from the same sender answers: a thank-you for the response to that form, a receipt for that payment, a confirmation of that booking or reply. Look for that later email for every request before sorting, whichever of the two the list shows first; a done request gets no To do, only a Heads up line that it was done, if that. Then sort the rest into two parts.',
      '**To do**: mail asking the household for something still open, with no later email saying it was done: a payment, a signature, a reply, a form, a booking to make, an appointment or a deadline still ahead, whoever sent it and however many people it went to.',
      '**Heads up**: mail that only tells the household something worth knowing: an order or a connection confirmed, a delivery on its way, a change to an account or a service.',
      'Mail marked copied_in was written to the people under its to, with the household only copied in: whatever it asks, it asks of them, never of the household, so it is a Heads up at most.',
      'One bullet per email, in your own words: who sent it, whom it was to when it is marked copied_in, and what it says or asks, with every date, time, amount and place exactly as given. Never paste the subject line or put it in quotes. Open an email with read_email when its snippet is not enough. Propose any calendar-worthy date still ahead with propose_family_event.',
      'A mailbox with more_not_shown had more new mail than fits: end its mail with one line saying how many more arrived in it (with "at least" when more_not_shown_is_at_least is set), so nobody thinks they have seen it all.',
      '**Overdue**: anything overdue on the board, as given. **Due today**: anything on the board due today, as given.',
      '**Later today**: the reminders set to go off today, each with its time as given.',
      '**Waiting on a yes**: the proposals, as given; a yes here or on Home puts one on the family calendar.',
      'If DATA lists questions, end with "Not sure about:" and each question on its own line, worded as given, and say that anyone can answer here or on Home. Nothing under DATA answers them, so do not guess.',
    ].join(' '),
    tools: ['recall', 'read_email', 'propose_family_event', 'list_family_events'],
    // A bullet an email across every mailbox, and the sections after the mail,
    // with room for a thinking model's reasoning, which the budget also counts.
    maxOutputTokens: 2400,
  },
  snapshot: {
    kind: 'snapshot',
    label: 'Money snapshot',
    cron: '0 18 * * 0',
    builtin: true,
    instruction: [
      "The household's spending for the past week and for the month so far, and the month's budget where there is one, are under DATA. Post the weekly money snapshot. It is read on a phone, so short lines and bullets, never a table.",
      'Open with a **bold** title line naming the week by its dates, in the form "Money snapshot, 7 to 13 Jun".',
      'Then the week in one line: "This week: in **$A**, out **$B**, net **$C**.", out being its spent, in its net_income where it has one and its received where it does not.',
      'Then the month in one line: "This month so far: **$D** spent, **E%** of the budget used, 20 of 30 days in.", the spend from month_so_far and the percentage and the days from budget, as given; leave out a part DATA does not give.',
      'Then **Where it went**: a bullet for each of the week\'s categories, largest first, "Category: $X (N%)" with its amount and share as given.',
      'Then **Largest payments**: a bullet for each of the week\'s largest, "Payee: **$X** (Category)", or "Payee: **$X** (Category, what it was for)" when its note or a Known household fact says what it was for; otherwise say nothing about its purpose.',
      'Name a payee by the business name its payee string opens with, written the way a business name is written, in title case with initials in capitals, never in all capitals. Leave off what the bank adds after the name: a place however shortened (a town, a state, a country), card and reference numbers, dates and times. Add nothing: no shortened word spelt out, no description of the business.',
      'Then **Over budget**: a bullet for each category whose position says over, "Category: over by $X" as its position gives it; leave out categories under or on budget and categories with no budget set. If DATA lists rollover_used_up, end with one line, "Nothing left this month after rollover:" and those categories as given, all on that line.',
      'Figures exactly as given, no arithmetic of your own, no advice.',
    ].join(' '),
    tools: ['recall'],
  },
}

/** The watchers every household group gets, in the order Home lists them. */
export const BUILTIN_WATCHERS: Watcher[] = Object.values(WATCHERS).filter((w) => w.builtin)

export function isWatcherKind(value: string | null | undefined): value is WatcherKind {
  return value === 'morning' || value === 'snapshot'
}

export function isBuiltinKind(value: string | null | undefined): boolean {
  return isWatcherKind(value) && WATCHERS[value].builtin
}

/** Telegram gives groups negative ids; a private chat's id is the person's own. */
export const isGroupChat = (chatId: string) => chatId.startsWith('-')

/**
 * The instruction as stored and as prompted: in a group the brief reads
 * several people's mail and calendars into one room, so each item says whose
 * it was. Whose means the person: a brief once labelled its mail "(google)"
 * and "(microsoft)", which names nobody.
 */
export function watcherInstruction(kind: WatcherKind, chatId: string): string {
  const base = WATCHERS[kind].instruction
  return kind === 'morning' && isGroupChat(chatId)
    ? `${base} Say whose mailbox or calendar each item came from, as its mailbox or calendar field names it: a person, never a provider.`
    : base
}
