import { tool } from 'ai'
import { z } from 'zod'
import { gatherBrief, gatherSnapshot, type Fetched } from '../brief'
import { clockLine } from '../cron'
import { familyCalendarTools } from './familycal'
import { calendarTools } from './calendar'
import { mailTools } from './mail'
import { jiraTools } from './jira'
import { weatherTools } from './weather'
import { proposalTools } from './proposals'
import { moneyTools } from './money'
import { requireMember, type ToolContext } from './context'

/**
 * How to read the brief, said once beside it: the parts it falls into, and
 * what is left out. Grounding rules, as the scheduled brief was written to,
 * so a client phrases what is there and nothing else.
 */
export const BRIEF_GUIDE = [
  'Give it in named parts, leaving out a part with nothing in it.',
  'Today: what is on, from the family calendar (events) and your own (calendars), with times and places as given. Tomorrow: what starts then. Coming up: the items under coming, in date order, to the date given as through.',
  'An event listed more than once, on one calendar or several, is one item.',
  'Mail: set aside newsletters and promotions, mail whose moment has passed by now (a collection or event timed earlier, an order already delivered), and any request a later email from the same sender answers (a thank-you for that form, a receipt for that payment). Sort the rest into To do (asks for something still open: a payment, a signature, a reply, a form, a booking, a deadline still ahead) and Heads up (only informs). Mail marked copied_in was written to someone else, so it is a Heads up at most, and says whom it was to.',
  'One line per email, in your own words, with every date, time, amount and place exactly as given. Open an email with read_email when the snippet is not enough.',
  'Propose any calendar-worthy date still ahead with propose_family_event, passing the message id as source ("<provider>:<id>"): a date already proposed comes back as that proposal rather than a second one.',
  'A mailbox with more_not_shown had more new mail than fits: say how many more. A calendar marked truncated had more events than fit: say the rest is not shown.',
  'Overdue and due today: from the board, as given. Later today: your reminders. Waiting on a yes: the proposals, settled with accept_event_proposal or reject_event_proposal. Questions: ask each as worded, and settle an answer with answer_question.',
  'Nothing here was posted anywhere: this is yours to read out.',
].join(' ')

export const SNAPSHOT_GUIDE = [
  'The week first: in, out and net for the week (net_income where it has one, received where it does not). Then the month so far: spent, the share of the budget used and the days in, as given.',
  "Then the week's categories, largest first, with amount and share as given; its largest payments by business name, with what each was for only when its note or a Known fact says.",
  'Then the budget: over_budget lists the categories whose budget for the month is above $0 and spent past, each "over by $X" as given. nothing_left_after_rollover lists the categories still budgeted whose allowance this month is $0 after rollover: name them together once, and never as overspent or as having no budget. no_budget_set lists spending with no budget at all.',
  'Figures exactly as given, no arithmetic of your own, and no advice.',
].join(' ')

/** One of the household's own tools, run directly as a read, the way a model call would run it. */
function runner(ctx: ToolContext) {
  const tools = {
    ...familyCalendarTools(ctx),
    ...calendarTools(ctx),
    ...mailTools(ctx),
    ...jiraTools(ctx),
    ...weatherTools(ctx),
    ...proposalTools(ctx),
    ...moneyTools(ctx),
  } as unknown as Record<string, { execute?: (input: unknown, options: unknown) => Promise<unknown> }>
  return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const t = tools[name]
    if (!t?.execute) throw new Error(`${name} cannot run here`)
    return ((await t.execute(args, { toolCallId: `brief-${name}`, messages: [] })) ?? {}) as Record<string, unknown>
  }
}

/** What a gathered read hands back: the data, what could not be read, and a word when there is nothing to tell. */
function handBack(f: Fetched, now: Date, guide: string, quiet: string) {
  return {
    now: clockLine(now),
    ...f.data,
    ...(f.problems.length ? { could_not_read: f.problems } : {}),
    ...(f.empty ? { nothing_new: quiet } : {}),
    how_to_read: guide,
  }
}

export function briefTools(ctx: ToolContext) {
  return {
    morning_brief: tool({
      description:
        'Your day at a glance, on demand: what is on today on the family calendar and your own, what starts tomorrow and what is coming over the fortnight, ' +
        'the mail that has arrived since your last morning brief, the board, your reminders, the events waiting on a yes, the weather and the open questions. ' +
        'Its mail markers are its own, so it never spends what new_mail shows this client, or the other way round. how_to_read says how to give it.',
      inputSchema: z.object({}),
      execute: async () => {
        requireMember(ctx)
        // Its own markers for what is new; the moves join this call's, to be
        // made once the result is handed back.
        const own: ToolContext = { ...ctx, cursorScope: 'brief', pendingCursors: [] }
        const brief = await gatherBrief(own, runner(own))
        ;(ctx.pendingCursors ??= []).push(...own.pendingCursors!)
        return handBack(brief, ctx.now, BRIEF_GUIDE, 'Nothing on any calendar today, nothing coming up, no new mail and nothing due.')
      },
    }),

    money_snapshot: tool({
      description:
        "The household's money at a glance, on demand, from PocketSmith: the past seven days in, out and net with their categories and largest payments, " +
        'the month so far against the budget, and where each budgeted category stands. how_to_read says how to give it.',
      inputSchema: z.object({}),
      execute: async () => handBack(await gatherSnapshot(ctx, runner(ctx)), ctx.now, SNAPSHOT_GUIDE, 'No money moved this week or this month.'),
    }),
  }
}
