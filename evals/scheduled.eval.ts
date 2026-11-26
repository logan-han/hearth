import { describe, it, expect, vi, afterAll } from 'vitest'
import { withRecorded, called, liveChainConfigured, plainData } from './harness'
import { figuresGrounded, noLeak, TRIP_TALK, judgeGroundedness, record, printSummary, strict } from './scorers'
import { localDateKey, dayAfter, localToUtc, formatLocal, formatLocalDate, clockLine } from '@/lib/cron'
import type { ToolName } from '@/lib/tools'

const calls = vi.hoisted(() => [] as { tool: string; input: unknown }[])
const { STUBS } = vi.hoisted(() => {
  const STUBS = {
    recall: () => ({ memories: [{ id: 3, fact: 'Juno goes to Riverbend College' }] }),
    list_family_events: () => ({ timezone: 'Australia/Melbourne', events: [] }),
    propose_family_event: (input: unknown) => ({ proposal_id: 7, proposed: input }),
  }
  return { STUBS }
})
vi.mock('@/lib/tools', async (orig) => {
  const actual = await orig<typeof import('@/lib/tools')>()
  return { ...actual, buildTools: (ctx: Parameters<typeof actual.buildTools>[0]) => withRecorded(actual.buildTools(ctx), STUBS, calls) }
})

const { runAgent, decideWatcherPost, reviewDraft, cutFromDraft, scheduledInstruction } = await import('@/lib/agent')

/*
 * A scheduled run is a member's own instruction, run by the tick with
 * read-only tools, and what it writes is kept as a report for them after the
 * claim check and the decision. These cases are the failures the family has
 * actually seen in such reports. The writer is handed the data in its text,
 * standing in for the tool results it would otherwise fetch, and its tools
 * are narrowed to the ones the eval answers from a recording.
 */

/** Who set these jobs up: the member each report is kept for. */
const MEMBER = 'Rowan'

/**
 * The text a scheduled run is handed, as the tick words it for a member's own
 * automation, with the data the eval stands in for the tools' results after it.
 */
function scheduled(label: string, instruction: string, data: string): string {
  return `${scheduledInstruction({ label, instruction, repeat: 'always' }, MEMBER)}\n\nDATA (fetched just now):\n${data}`
}

/**
 * One scheduled run, as the tick makes it: the member's own allowance and
 * settings, nothing raised for a long report, since the tick raises nothing
 * either.
 */
const run = (label: string, instruction: string, data: string, tools: ToolName[]) =>
  runAgent({ member: null, memberName: MEMBER, tools, text: scheduled(label, instruction, data) })

/** What the checks judge a draft against, as the tick hands it over, with the data the writer had in place of tool results. */
const evidenceFor = (instruction: string, data: string, clock?: string) =>
  `${clock ? `${clock}\n\n` : ''}INSTRUCTION:\n${instruction}\n\nDATA:\n${data}\n\nTOOL RESULTS:\n(none)`

/** The report by its **bold** parts, each heading in lower case with the lines under it. */
function parts(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let current = ''
  for (const line of text.split('\n')) {
    const m = /^\s*\*\*([^*]+?)\*\*:?\s*(.*)$/.exec(line)
    if (m) {
      current = m[1].trim().toLowerCase()
      out[current] = `${out[current] ?? ''}${m[2]}\n`
    } else if (current) {
      out[current] += `${line}\n`
    }
  }
  return out
}
const part = (all: Record<string, string>, name: RegExp) => Object.entries(all).find(([heading]) => name.test(heading))?.[1] ?? ''

afterAll(() => printSummary('scheduled reports'))

/* -------------------------------------------------------------- the money */

/**
 * The weekly money summary, as a member would schedule it ("every Sunday at
 * 6pm, the week's money"), worded as the household's own snapshot once was.
 * The budget is in PocketSmith's three states, which must never be confused:
 * over by $X (an allowance above $0, spent past), nothing left after rollover
 * (still budgeted, allowed $0 this month) and no budget set.
 */
const SNAPSHOT_INSTRUCTION = [
  "The household's spending for the past week and for the month so far, and the month's budget where there is one, are under DATA. Write the weekly money snapshot. It is read on a phone, so short lines and bullets, never a table.",
  'Open with a **bold** title line naming the week by its dates, in the form "Money snapshot, 7 to 13 Jun".',
  'Then the week in one line: "This week: in **$A**, out **$B**, net **$C**.", out being its spent, in its net_income where it has one and its received where it does not.',
  'Then the month in one line: "This month so far: **$D** spent, **E%** of the budget used, 20 of 30 days in.", the spend from month_so_far and the percentage and the days from budget, as given; leave out a part DATA does not give.',
  'Then **Where it went**: a bullet for each of the week\'s categories, largest first, "Category: $X (N%)" with its amount and share as given.',
  'Then **Largest payments**: a bullet for each of the week\'s largest, "Payee: **$X** (Category)", or "Payee: **$X** (Category, what it was for)" when its note or a Known household fact says what it was for; otherwise say nothing about its purpose.',
  'Name a payee by the business name its payee string opens with, written the way a business name is written, in title case with initials in capitals, never in all capitals. Leave off what the bank adds after the name: a place however shortened (a town, a state, a country), card and reference numbers, dates and times. Add nothing: no shortened word spelt out, no description of the business.',
  'Then **Over budget**: a bullet for each category under over_budget, "Category: over by $X" as its position gives it, and no other: never a category under or on budget, one under nothing_left_after_rollover or one under no_budget_set.',
  'If DATA lists nothing_left_after_rollover, end with one line, "Nothing left after rollover:" and those categories as given, all on that line; they are still budgeted, so never call them over budget or unbudgeted. Leave out the categories under no_budget_set.',
  'Figures exactly as given, no arithmetic of your own, no advice.',
].join(' ')
const SNAPSHOT_TOOLS: ToolName[] = ['recall']

// A week as money_snapshot gathers it: totals, the largest payments, and the budget positions as the money tool words them.
// One payee string appears twice under two categories, one with a note: a check that names the payee without its amount reads the second as contradicting the first.
const SNAPSHOT = {
  week: '2026-09-14 to 2026-09-20',
  this_week: {
    source: 'pocketsmith', from: '2026-09-14', to: '2026-09-20', transactions: 12, spent: '$1,842.10', received: '$3,200.00', net: '$1,357.90',
    by_category: [
      { category: 'Groceries', amount: '$612.40', share_of_spend: '33%' },
      { category: 'Kids', amount: '$385.00', share_of_spend: '21%' },
      { category: 'Home', amount: '$149.00', share_of_spend: '8%' },
    ],
    largest: [
      { payee: 'Harbour Art School', amount: '$385.00', category: 'Kids', date: '2026-09-17', note: null },
      { payee: 'FRESHMART 2041 HILLSIDE', amount: '$212.30', category: 'Groceries', date: '2026-09-19', note: null },
      { payee: 'FRESHMART 2041 HILLSIDE', amount: '$149.00', category: 'Home', date: '2026-09-19', note: 'Bathroom tap' },
    ],
    largest_credits: [{ payee: 'SALARY ACME PTY LTD', amount: '$3,200.00', category: 'Income', date: '2026-09-15', note: null }],
  },
  month_so_far: {
    source: 'pocketsmith', from: '2026-09-01', to: '2026-09-30', transactions: 40, spent: '$6,210.55', received: '$9,600.00', net: '$3,389.45',
    by_category: [{ category: 'Kids', amount: '$2,119.47', share_of_spend: '34%' }, { category: 'Groceries', amount: '$1,102.40', share_of_spend: '18%' }],
    largest: [{ payee: 'Harbour Art School', amount: '$1,200.00', category: 'Kids', date: '2026-09-03', note: 'Term 4 fees' }],
    largest_credits: [{ payee: 'SALARY ACME PTY LTD', amount: '$3,200.00', category: 'Income', date: '2026-09-01', note: null }],
  },
  budget: {
    from: '2026-09-01', to: '2026-09-30', period_progress: '20 of 30 days (67% of the month)',
    income: { actual: '$9,600.00', forecast: '$9,600.00' },
    expenses: { actual: '-$6,210.55', forecast: '-$5,400.00', used: '115%' },
    budget_by_category: [
      { category: 'Kids', actual: '$2,119.47', forecast: '$1,500.00', budget_period: '2026-09-01 to 2026-09-30', position: 'over by $619.47' },
      { category: 'Shopping', actual: '$177.43', forecast: '$0.00', budget_period: '2026-09-01 to 2026-09-30', position: 'nothing left after rollover' },
      { category: 'Transport', actual: '$14.31', forecast: '$0.00', budget_period: '2026-09-01 to 2026-09-30', position: 'nothing left after rollover' },
      { category: 'Groceries', actual: '$1,102.40', forecast: '$1,400.00', budget_period: '2026-09-01 to 2026-09-30', position: 'under by $297.60' },
      { category: 'Pets', actual: '$96.00', forecast: '$0.00', budget_period: '2026-09-01 to 2026-09-30', position: 'no budget set' },
    ],
    over_budget: [{ category: 'Kids', position: 'over by $619.47' }],
    nothing_left_after_rollover: ['Shopping', 'Transport'],
    no_budget_set: ['Pets'],
  },
}
const snapshotData = plainData(SNAPSHOT)

/*
 * The snapshot's figures once went out as two-column tables, aligned
 * monospace lines of about 32 characters, and a phone that holds about 28
 * wrapped every row, each label a line above its figure. Written in bullets
 * and bold figures it read well on the same phone, so that is how it is
 * asked for, with payees by their business name. And a category overspent
 * earlier in the year, allowed nothing this month, was once called "no budget
 * set", and another listed as over budget for spending against a $0
 * allowance: each of the three states is said as given, and only the first
 * is an overspend.
 */
describe.skipIf(!liveChainConfigured())('money snapshot', () => {
  it('writes the week in lines and bullets with bold figures, payees by business name, over budget only what is, the rollover said once', async () => {
    calls.length = 0
    const r = await run('Money snapshot', SNAPSHOT_INSTRUCTION, snapshotData, SNAPSHOT_TOOLS)
    if (process.env.EVAL_PRINT) console.log(`\n----- snapshot draft -----\n${r.text}\n-----`)
    const text = r.text
    const figures = figuresGrounded(text, snapshotData)
    const noTable = !/^\s*\|/m.test(text)
    const hasTitle = /^\*\*[^*\n]+\*\*\s*$/m.test(text)
    const boldTotals = /\*\*\$1,842\.10\*\*/.test(text) && /\*\*\$6,210\.55\*\*/.test(text) && /\*\*115%\*\*/.test(text)
    // The business name in title case, the bank's store number and town left off, both payments kept, the note woven in.
    const payees = (text.match(/Freshmart/g) ?? []).length === 2 && !/FRESHMART|2041|hillside/i.test(text.replace(/Freshmart/g, ''))
    const note = /Bathroom tap/i.test(text)
    // Over budget is Kids alone: the two rollover categories spent against a $0 allowance are not overspends.
    // The rollover line ends the report, so it can fall under the last heading; it is judged on its own below.
    const over = part(parts(text), /^over budget/).split('\n').filter((l) => !/rollover/i.test(l)).join('\n')
    const overOnly = /Kids/.test(over) && !/Shopping|Transport|Pets|Groceries/.test(over)
    const rolloverLines = text.split('\n').filter((l) => /rollover/i.test(l))
    const rolloverOnce = rolloverLines.length === 1 && /Nothing left after rollover:.*Shopping/i.test(rolloverLines[0]) && /Transport/.test(rolloverLines[0])
    // Never called unbudgeted or overspent, whatever line they are on.
    const rolloverNamedRight = text.split('\n').filter((l) => /Shopping|Transport/.test(l)).every((l) => !/over by|over budget|no budget/i.test(l))
    const hard =
      figures.ok && noLeak(text) && noTable && hasTitle && boldTotals && payees && note && overOnly && rolloverOnce && rolloverNamedRight &&
      !/purpose not recorded/i.test(text) && !/Pets/.test(text) && !/under by/i.test(text)
    const g = await judgeGroundedness({ answer: text, context: snapshotData })
    record({ case: 'snapshot: bullets, bold totals, over budget only what is, rollover once', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: text.slice(0, 80) })
    expect(figures.missing).toEqual([])
    expect(noTable).toBe(true)
    expect(hasTitle).toBe(true)
    expect(boldTotals).toBe(true)
    expect(payees).toBe(true)
    expect(note).toBe(true)
    expect(overOnly).toBe(true)
    expect(rolloverOnce).toBe(true)
    expect(rolloverNamedRight).toBe(true)
    expect(text).not.toMatch(/purpose not recorded/i)
    expect(text).not.toMatch(/Pets/)
    expect(text).not.toMatch(/under by/i)
    expect(noLeak(text)).toBe(true)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })

  // A snapshot listing one payee twice, under two categories, lost its second
  // line: the check wrote "<payee> was for <category>", with no amount to say
  // which payment, and on the real week the checker cut that as often as it
  // kept it, where "<payee> $<amount> is filed under <category>" was kept every
  // time. A cut then puts the rest on the full line, where a long report can be
  // held back on a coin flip. So every statement about a payee names the payment.
  it('passes a grounded snapshot whole through the claim check and the decision, the repeated payee and all', async () => {
    const draft = [
      '**Money snapshot, 14 to 20 Sep**',
      'This week: in **$3,200.00**, out **$1,842.10**, net **$1,357.90**.',
      'This month so far: **$6,210.55** spent, **115%** of the budget used, 20 of 30 days in.',
      '',
      '**Where it went**',
      '- Groceries: $612.40 (33%)',
      '- Kids: $385.00 (21%)',
      '- Home: $149.00 (8%)',
      '',
      '**Largest payments**',
      '- Harbour Art School: **$385.00** (Kids)',
      '- Freshmart: **$212.30** (Groceries)',
      '- Freshmart: **$149.00** (Home, Bathroom tap)',
      '',
      '**Over budget**',
      '- Kids: over by $619.47',
      '',
      'Nothing left after rollover: Shopping, Transport',
    ].join('\n')
    const evidence = evidenceFor(SNAPSHOT_INSTRUCTION, snapshotData)
    const review = await reviewDraft({ label: 'Money snapshot', draft, evidence })
    const verified = review.claims.length > 0 && review.unsupported.length === 0
    const d = await decideWatcherPost({ label: 'Money snapshot', draft: review.message ?? '', evidence, verified })
    const payeeClaims = review.claims.filter((c) => /freshmart|harbour art/i.test(c))
    const pinned = payeeClaims.every((c) => /\$\d/.test(c))
    const hard = pinned && review.unsupported.length === 0 && review.message === draft && d.decision === 'post'
    record({
      case: 'snapshot: payee statements name the payment, grounded report kept',
      hard: hard ? 'pass' : 'fail',
      model: d.model,
      note: `${payeeClaims.join(' // ') || 'no payee statements'} | cut: ${review.unsupported.join(' | ') || 'none'} | ${d.decision}@${d.confidence}`,
    })
    expect(payeeClaims.filter((c) => !/\$\d/.test(c))).toEqual([])
    expect(review.unsupported).toEqual([])
    expect(review.message).toBe(draft)
    expect(d.decision).toBe('post')
  })
})

/* ------------------------------------------------------ the transactions */

// A day's transactions as list_transactions gives them, for a member's own automation that reports them.
const LISBON = {
  transactions: {
    from: '2026-08-26', to: '2026-08-26', matched: 1, total_in: '$0.00', total_out: '$389.60', net: '-$389.60',
    transactions: [{ date: '2026-08-26', payee: 'FARESAVER LISBON', amount: '-$389.60', category: 'Uncategorised', account: '2Up Spending' }],
  },
}
const lisbonData = plainData(LISBON)
const DAILY = 'Report the day\'s transactions under DATA, one line each: payee as shown, amount, date. Add a purpose only if its note or a Known household fact names one; otherwise write "purpose not recorded".'
const lisbonEvidence = evidenceFor(DAILY, lisbonData)
const lisbonDraft = '2Up Spending: **$389.60** FARESAVER LISBON, 26 Aug. Purpose not recorded.'

describe.skipIf(!liveChainConfigured())('transaction reports, the checks', () => {
  it('has the claim check cut a fabricated trip, and the decision hold whatever is left', async () => {
    const evidence = lisbonEvidence
    const review = await reviewDraft({
      label: 'Daily transactions',
      draft: 'Looks like someone booked flights to Lisbon, planning a trip? $389.60 via Faresaver.',
      evidence,
    })
    const tripCut = review.message === null || !TRIP_TALK.test(review.message)
    let kept = ''
    let note = `review: ${review.unsupported.length}/${review.claims.length} cut`
    if (review.message !== null) {
      const d = await decideWatcherPost({ label: 'Daily transactions', draft: review.message, evidence })
      kept = d.decision === 'post' ? review.message : ''
      note += ` | ${d.decision}@${d.confidence}`
    }
    const hard = tripCut && (kept === '' || (!TRIP_TALK.test(kept) && figuresGrounded(kept, lisbonData).ok))
    record({ case: 'review: fabricated Lisbon trip', hard: hard ? 'pass' : 'fail', model: 'chain', note })
    expect(tripCut).toBe(true)
    if (kept) {
      expect(kept).not.toMatch(TRIP_TALK)
      expect(figuresGrounded(kept, lisbonData).missing).toEqual([])
    }
  })

  it('lets a grounded draft through the claim check untouched', async () => {
    const draft = lisbonDraft
    const review = await reviewDraft({ label: 'Daily transactions', draft, evidence: lisbonEvidence })
    const hard = review.message === draft
    record({ case: 'review: grounded draft untouched', hard: hard ? 'pass' : 'fail', model: 'chain', note: `${review.claims.length} claims, ${review.unsupported.length} cut` })
    expect(review.unsupported).toEqual([])
    expect(review.message).toBe(draft)
  })

  it('keeps a plain, grounded draft', async () => {
    const draft = lisbonDraft
    const d = await decideWatcherPost({ label: 'Daily transactions', draft, evidence: lisbonEvidence })
    const hard = d.decision === 'post'
    record({ case: 'decision: grounded draft kept', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}` })
    expect(d.decision).toBe('post')
  })
})

/* ------------------------------------------------------ the morning brief */

/**
 * A morning summary of the day, as a member would schedule it ("every
 * morning at 7, my day"), worded as the household's own brief once was. It
 * reads its author's own calendar, so nothing in it needs saying whose it is.
 */
const BRIEF_INSTRUCTION = [
  "Today's calendars (the family calendar under events, and your own under calendars), what starts tomorrow, what is coming up over the fortnight (under coming), the household board, the reminders set for today, the proposals waiting on a yes and the weather are under DATA. Write one short brief for the day in named parts, each a **bold** line with its bullets under it; leave out a part with nothing in it.",
  '**Today**: what is on, from the family calendar and from each calendar under calendars, with its time and place as given, and a flag only where the data supports one: an early start, rain in the forecast.',
  '**Tomorrow**: what starts tomorrow, with its time as given, so the household can get ready tonight.',
  '**Coming up**: the items under coming, up to the date given as through, one bullet each in date order: its day first, then its time and place as given, and for a board item its due date. Reminders are listed with their day and time. Say nothing about a date after through.',
  'An event listed more than once, on one calendar or on several, is one bullet.',
  'Every item is yours or the family\'s, so none needs a label: never name the calendar, the app or the provider it came from.',
  'A calendar marked truncated had more events in its range than fit: end its part with one line saying the rest is not shown.',
  '**Overdue**: anything overdue on the board, as given. **Due today**: anything on the board due today, as given.',
  '**Later today**: the reminders set to go off today, each with its time as given.',
  '**Waiting on a yes**: the proposals, as given; a yes from an MCP client or on Home puts one on the family calendar.',
  'If DATA lists questions, end with "Not sure about:" and each question on its own line, worded as given, and say that anyone can answer from their MCP client or on Home. Nothing under DATA answers them, so do not guess.',
].join(' ')
const BRIEF_TOOLS: ToolName[] = ['recall', 'propose_family_event', 'list_family_events']

// The tick heads every piece of evidence with the household's clock, so the checks can tell today from tomorrow.
const clock = clockLine(new Date())

/* --------------------------------------------------------- the day ahead */

/*
 * A brief that read as a digest of what arrived missed the day: the family calendar is
 * nearly always empty, and the member's own calendar was not read. It now
 * carries the member's own calendar for today, what starts tomorrow, the
 * board's due-today items, the reminders set for later in the day and the
 * proposals waiting on a yes, each in a part of its own. And the claim check
 * once cut the day's one event, "scheduled for Today", for want of a date in
 * the evidence; the evidence now opens with the clock. These hold the writer
 * and the checks to both.
 */
const today = localDateKey(new Date())
const next = dayAfter(today)
const weekAhead = localDateKey(new Date(Date.now() + 7 * 86_400_000))
const at = (day: string, time: string) => formatLocal(localToUtc(`${day}T${time}`))
const iso = (day: string, time: string) => localToUtc(`${day}T${time}`).toISOString()
// As list_calendar names the member's own calendar.
const OWN = "Rowan's Google Calendar"
const DAY = {
  events: {
    timezone: 'Australia/Melbourne',
    events: [{ id: 50, title: 'After School Care', start_local: at(today, '15:00'), end_local: at(today, '18:00'), all_day: false, location: 'Riverbend College, Hillside' }],
  },
  calendars: {
    timezone: 'Australia/Melbourne',
    accounts: [
      {
        calendar: OWN, provider: 'google',
        events: [{ id: 'e1', title: 'Dentist', start: iso(today, '09:00'), end: iso(today, '10:00'), allDay: false, location: 'Hillside Dental', start_local: at(today, '09:00'), end_local: at(today, '10:00') }],
      },
    ],
  },
  tomorrow: {
    date: formatLocalDate(localToUtc(next)),
    calendars: [
      {
        calendar: OWN, provider: 'google',
        events: [{ id: 'e2', title: 'Flight to Sydney', start: iso(next, '06:10'), end: iso(next, '07:40'), allDay: false, start_local: at(next, '06:10'), end_local: at(next, '07:40') }],
      },
    ],
  },
  board: { project: 'HTL', open: 2, by_status: [{ status: 'To Do', count: 2 }], overdue: [], due_today: [{ key: 'HTL-351', summary: 'Pay the excursion', due: today }] },
  reminders: [{ label: 'bins out', at: '7:00 pm' }],
  proposals: [{ id: 3, title: 'Athletics carnival', start_local: formatLocalDate(localToUtc(weekAhead)), all_day: true, location: 'the oval' }],
  weather: {
    place: 'Melbourne, Victoria, AU', units: 'metric',
    now: { description: 'light rain', temp: 12, rain_last_hour_mm: 1.2 },
    days: [{ day: today, min: 9, max: 17, condition: 'Rain', rain_mm: 8 }],
  },
}
const dayData = plainData(DAY)
const dayEvidence = evidenceFor(BRIEF_INSTRUCTION, dayData, clock)

describe.skipIf(!liveChainConfigured())('morning brief, the day half', () => {
  it('puts the day under Today, the flight under Tomorrow, and the board, reminders and proposals in parts of their own', async () => {
    calls.length = 0
    const r = await run('Morning brief', BRIEF_INSTRUCTION, dayData, BRIEF_TOOLS)
    const text = r.text
    if (process.env.EVAL_PRINT) console.log(`\n----- day brief -----\n${text}\n-----`)
    const all = parts(text)
    const todayPart = part(all, /^today\b/)
    const tomorrowPart = part(all, /^tomorrow\b/)
    const todayRight = /dentist/i.test(todayPart) && /after school care/i.test(todayPart) && !/flight/i.test(todayPart)
    const tomorrowRight = /flight/i.test(tomorrowPart) && /6:10/.test(tomorrowPart)
    const dueRight = /HTL-351|excursion/i.test(part(all, /due today/))
    const reminderRight = /bins/i.test(part(all, /later today/)) && /7:00 pm/i.test(part(all, /later today/))
    const waitingRight = /athletics carnival/i.test(part(all, /waiting on a yes/))
    // Every item is the member's own or the family's: no line labelled with a calendar, an app or a provider.
    const unlabelled = !/\((?:[^()\n]*\b(?:gmail|outlook|google|microsoft|family calendar)\b[^()\n]*)\)/i.test(text) && !/google calendar|outlook calendar/i.test(text)
    const hard = todayRight && tomorrowRight && dueRight && reminderRight && waitingRight && unlabelled && noLeak(text)
    const g = await judgeGroundedness({ answer: text, context: dayData })
    record({ case: 'brief: the day, tomorrow, due today, reminders, waiting', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: text.slice(0, 80) })
    expect(todayRight).toBe(true)
    expect(tomorrowRight).toBe(true)
    expect(dueRight).toBe(true)
    expect(reminderRight).toBe(true)
    expect(waitingRight).toBe(true)
    expect(unlabelled).toBe(true)
    expect(noLeak(text)).toBe(true)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })

  it('keeps a Today line through the claim check and the decision, now the evidence says what day it is', async () => {
    const label = 'Morning brief'
    const draft = [
      '**Today**',
      '- Dentist, 9:00 am to 10:00 am, at Hillside Dental.',
      '- After School Care, 3:00 pm to 6:00 pm, Riverbend College, Hillside.',
      '**Tomorrow**',
      '- Flight to Sydney, 6:10 am.',
    ].join('\n')
    const review = await reviewDraft({ label, draft, evidence: dayEvidence })
    const kept = review.message !== null && /dentist/i.test(review.message) && /after school care/i.test(review.message)
    const verified = review.claims.length > 0 && review.unsupported.length === 0
    const d = await decideWatcherPost({ label, draft: review.message ?? draft, evidence: dayEvidence, verified })
    const hard = kept && review.unsupported.length === 0 && d.decision === 'post'
    record({
      case: 'check: a Today line survives with the clock in the evidence',
      hard: hard ? 'pass' : 'fail',
      model: d.model,
      note: `check: ${review.unsupported.length}/${review.claims.length} cut${review.unsupported.length ? ` (${review.unsupported.join(' | ')})` : ''} | ${d.decision}@${d.confidence}${d.reason ? ` ${d.reason}` : ''}`,
    })
    expect(review.unsupported).toEqual([])
    expect(kept).toBe(true)
    expect(d.decision).toBe('post')
  })

  // A term break on two family feeds and on a member's own calendar once took
  // three bullets under Today, each saying which calendar it was on.
  it('lists an event that is on more than one calendar once', async () => {
    calls.length = 0
    const on = formatLocalDate(localToUtc(today))
    const data = plainData({
      events: {
        timezone: 'Australia/Melbourne',
        events: [
          { id: 70, title: 'Mid-Term Break', start_local: on, end_local: on, all_day: true, location: null },
          { id: 71, title: 'Mid-Term Break, no school (Riverbend)', start_local: on, end_local: on, all_day: true, location: null },
        ],
      },
      calendars: {
        timezone: 'Australia/Melbourne',
        accounts: [{
          calendar: OWN, provider: 'google',
          events: [
            { id: 'e7', title: 'Mid term break', start: today, end: today, allDay: true, start_local: on, end_local: on },
            { id: 'e8', title: 'Dentist', start: iso(today, '09:00'), end: iso(today, '10:00'), allDay: false, start_local: at(today, '09:00'), end_local: at(today, '10:00') },
          ],
        }],
      },
        })
    const r = await run('Morning brief', BRIEF_INSTRUCTION, data, BRIEF_TOOLS)
    const text = r.text
    if (process.env.EVAL_PRINT) console.log(`\n----- doubled-event brief -----\n${text}\n-----`)
    const todayPart = part(parts(text), /^today\b/)
    const once = (todayPart.match(/break/gi) ?? []).length === 1
    const dentistKept = /dentist/i.test(todayPart)
    const hard = once && dentistKept && noLeak(text)
    const g = await judgeGroundedness({ answer: text, context: data })
    record({ case: 'brief: an event on several calendars is one bullet', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: todayPart.slice(0, 80) })
    expect(once).toBe(true)
    expect(dentistKept).toBe(true)
    expect(noLeak(text)).toBe(true)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })
})
