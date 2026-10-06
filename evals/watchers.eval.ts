import { describe, it, expect, vi, afterAll } from 'vitest'
import { withRecorded, called, liveChainConfigured } from './harness'
import { figuresGrounded, noLeak, TRIP_TALK, judgeGroundedness, record, printSummary, strict } from './scorers'

const calls = vi.hoisted(() => [] as { tool: string; input: unknown }[])
const { STUBS, BODIES, TRIAGE, DAYS } = vi.hoisted(() => {
  const BODIES: Record<string, object> = {
    m1: {
      id: 'm1', from: 'office@riverbendcollege.example', subject: 'Athletics carnival', date: '2026-09-01T08:10:00+10:00',
      body: 'Dear families, the athletics carnival is on Thursday 15 October 2026 from 9am to 12pm at the oval. Students wear house colours. No RSVP needed.',
    },
    m3: {
      id: 'm3', from: 'noreply@riverbendcollege.example', subject: "Parents' association trivia night: tickets", date: '2026-09-16T15:02:00+10:00',
      body: "Dear families, the parents' association trivia night is on Friday 23 October 2026 from 7pm in the college hall. Tickets are $20 each and include supper. Book by Friday 16 October through the portal.",
    },
  }
  // Dated against the clock the eval runs on: the collection was yesterday evening, the signature is wanted next week.
  const longDay = (d: Date) =>
    new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
  const yesterday = new Date(Date.now() - 86_400_000)
  const nextWeek = new Date(Date.now() + 7 * 86_400_000)
  const TRIAGE = [
    {
      id: 'm20', from: 'Sign Desk <no-reply@signdesk.example>', subject: 'Signature requested on "Lease renewal - 12 Elm Street"',
      snippet: `Sam Fixture has requested your signature on "Lease renewal - 12 Elm Street". Please review and sign by ${longDay(nextWeek)}.`,
      date: yesterday.toISOString(),
    },
    {
      id: 'm21', from: 'Northbank Broadband <noreply@northbankbroadband.example>', subject: 'Your internet connection is now active',
      snippet: 'Good news: the connection at 12 Elm Street is active and your plan has started. There is nothing you need to do.',
      date: yesterday.toISOString(),
    },
    {
      id: 'm22', from: 'Surplus Bites <orders@surplusbites.example>', subject: 'Your order is confirmed',
      snippet: `Your Mystery Box from Corner Bakery Hillside is ready for collection on ${longDay(yesterday)} between 6:00 pm and 6:30 pm at 18 Station Street, Hillside.`,
      date: yesterday.toISOString(),
    },
  ]
  for (const m of TRIAGE) BODIES[m.id] = { ...m, body: m.snippet }
  const DAYS = { stale: longDay(yesterday), due: longDay(nextWeek) }
  const STUBS = {
    recall: () => ({ memories: [{ id: 3, fact: 'Juno goes to Riverbend College' }] }),
    list_family_events: () => ({ timezone: 'Australia/Melbourne', events: [] }),
    list_email: () => ({ accounts: [{ mailbox: "Rowan's Gmail", provider: 'google', messages: [] }] }),
    read_email: ({ id }: { id?: string } = {}) => BODIES[id ?? 'm1'] ?? { error: `No message ${id}.` },
    propose_family_event: (input: unknown) => ({ proposal_id: 7, proposed: input }),
  }
  return { STUBS, BODIES, TRIAGE, DAYS }
})
vi.mock('@/lib/tools', async (orig) => {
  const actual = await orig<typeof import('@/lib/tools')>()
  return { ...actual, buildTools: (ctx: Parameters<typeof actual.buildTools>[0]) => withRecorded(actual.buildTools(ctx), STUBS, calls) }
})

const { runAgent, decideWatcherPost, reviewDraft, cutFromDraft } = await import('@/lib/agent')
const { WATCHERS, watcherInstruction } = await import('@/lib/watchers')
const { plainData } = await import('@/lib/plain-data')
const { toTelegramHtml } = await import('@/lib/telegram-format')

const LISBON = {
  transactions: {
    account: '2Up', first_check: false, count: 1,
    transactions: [{ description: 'FARESAVER LISBON', amount: '$389.60', when: 'Tue 26 Aug 2026, 14:02', status: 'SETTLED', by: 'Rowan', message: null, flags: [] as string[] }],
  },
}
const lisbonData = plainData(LISBON)
const FLAGGED = { transactions: { ...LISBON.transactions, typical_debit: '$48.35', history_days: 90, transactions: [{ ...LISBON.transactions.transactions[0], flags: ['new_payee', 'unusually_large'] }] } }
const flaggedData = plainData(FLAGGED)
const base = { chatId: '-100', chatType: 'group', member: null, memberName: 'the family', history: false as const, mode: 'watcher' as const }

// A week as the tick fetches it: totals, the largest payments, and the budget positions as the money tool now words them.
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
      { category: 'Shopping', actual: '$177.43', forecast: '$0.00', budget_period: '2026-09-01 to 2026-09-30', position: 'over by $177.43', note: 'nothing left this month after rollover' },
      { category: 'Transport', actual: '$14.31', forecast: '$0.00', budget_period: '2026-09-01 to 2026-09-30', position: 'over by $14.31', note: 'nothing left this month after rollover' },
      { category: 'Groceries', actual: '$1,102.40', forecast: '$1,400.00', budget_period: '2026-09-01 to 2026-09-30', position: 'under by $297.60' },
      { category: 'Pets', actual: '$96.00', forecast: '$0.00', budget_period: '2026-09-01 to 2026-09-30', position: 'no budget set' },
    ],
    rollover_used_up: ['Shopping', 'Transport'],
  },
}
const snapshotData = plainData(SNAPSHOT)

afterAll(() => printSummary('watchers'))

/*
 * The snapshot's figures once went out as two-column tables, aligned
 * monospace lines of about 32 characters, and a phone that holds about 28
 * wrapped every row, each label a line above its figure. A household-written
 * snapshot in bullets and bold figures read well on the same phone, so the
 * built-in is written that way now, with payees by their business name.
 */
describe.skipIf(!liveChainConfigured())('money snapshot', () => {
  it('writes the week in lines and bullets with bold figures, payees by business name, the rollover said once, over-budget only', async () => {
    calls.length = 0
    const r = await runAgent({ ...base, tools: WATCHERS.snapshot.tools, text: `Scheduled check "Money snapshot".\n\n${WATCHERS.snapshot.instruction}\n\nDATA (fetched just now):\n${snapshotData}` })
    if (process.env.EVAL_PRINT) console.log(`\n----- snapshot draft -----\n${r.text}\n----- as Telegram HTML -----\n${toTelegramHtml(r.text)}\n-----`)
    const text = r.text
    const figures = figuresGrounded(text, snapshotData)
    const noTable = !/^\s*\|/m.test(text)
    const hasTitle = /^\*\*[^*\n]+\*\*\s*$/m.test(text)
    const boldTotals = /\*\*\$1,842\.10\*\*/.test(text) && /\*\*\$6,210\.55\*\*/.test(text) && /\*\*115%\*\*/.test(text)
    // The business name in title case, the bank's store number and town left off, both payments kept, the note woven in.
    const payees = (text.match(/Freshmart/g) ?? []).length === 2 && !/FRESHMART|2041|hillside/i.test(text.replace(/Freshmart/g, ''))
    const note = /Bathroom tap/i.test(text)
    const rolloverLines = (text.match(/rollover/gi) ?? []).length
    const overOnly = /Shopping/.test(text) && /Kids/.test(text) && !/Pets/.test(text) && !/under by/i.test(text)
    const hard = figures.ok && noLeak(text) && noTable && hasTitle && boldTotals && payees && note && rolloverLines === 1 && !/purpose not recorded/i.test(text) && overOnly
    const g = await judgeGroundedness({ answer: text, context: snapshotData })
    record({ case: 'snapshot: bullets, bold totals, business names, rollover once, over-budget only', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: text.slice(0, 80) })
    expect(figures.missing).toEqual([])
    expect(noTable).toBe(true)
    expect(hasTitle).toBe(true)
    expect(boldTotals).toBe(true)
    expect(payees).toBe(true)
    expect(note).toBe(true)
    expect(rolloverLines).toBe(1)
    expect(text).toMatch(/Nothing left this month after rollover:.*Shopping/i)
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
  // time. A cut then puts the rest on the full line, where a long post can be
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
      '- Shopping: over by $177.43',
      '- Transport: over by $14.31',
      '',
      'Nothing left this month after rollover: Shopping, Transport',
    ].join('\n')
    const evidence = `INSTRUCTION:\n${WATCHERS.snapshot.instruction}\n\nDATA:\n${snapshotData}\n\nTOOL RESULTS:\n(none)`
    const review = await reviewDraft({ label: 'Money snapshot', draft, evidence })
    const verified = review.claims.length > 0 && review.unsupported.length === 0
    const d = await decideWatcherPost({ label: 'Money snapshot', draft: review.message ?? '', evidence, verified })
    const payeeClaims = review.claims.filter((c) => /freshmart|harbour art/i.test(c))
    const pinned = payeeClaims.every((c) => /\$\d/.test(c))
    const hard = pinned && review.unsupported.length === 0 && review.message === draft && d.decision === 'post'
    record({
      case: 'snapshot: payee statements name the payment, grounded post passes',
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

describe.skipIf(!liveChainConfigured())('money watcher', () => {
  it('phrases a payee string as a payee string, with no trip and no purpose', async () => {
    calls.length = 0
    const r = await runAgent({ ...base, tools: WATCHERS.money.tools, text: `Scheduled check "2Up transactions".\n\n${WATCHERS.money.instruction}\n\nDATA (fetched just now):\n${lisbonData}` })
    const figures = figuresGrounded(r.text, lisbonData)
    const NO_FLAG_TALK = /new payee|unusual|larger than|duplicate/i
    const hard = figures.ok && noLeak(r.text) && !TRIP_TALK.test(r.text) && !NO_FLAG_TALK.test(r.text) && /389\.60/.test(r.text) && /purpose not recorded|does not say|not stated/i.test(r.text)
    const g = await judgeGroundedness({ answer: r.text, context: lisbonData })
    record({ case: 'money: FARESAVER LISBON line, no flags', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: r.text.slice(0, 80) })
    expect(figures.missing).toEqual([])
    expect(r.text).not.toMatch(TRIP_TALK)
    expect(r.text).not.toMatch(NO_FLAG_TALK)
    expect(noLeak(r.text)).toBe(true)
    expect(r.text).toMatch(/purpose not recorded|does not say|not stated/i)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })

  it('puts the flags the feed raised into words, and nothing more', async () => {
    calls.length = 0
    const r = await runAgent({ ...base, tools: WATCHERS.money.tools, text: `Scheduled check "2Up transactions".\n\n${WATCHERS.money.instruction}\n\nDATA (fetched just now):\n${flaggedData}` })
    const figures = figuresGrounded(r.text, flaggedData)
    const saysNew = /new payee|first time|not seen before|haven't seen/i.test(r.text)
    const saysLarge = /unusual|larger|bigger|well above|much more than/i.test(r.text)
    const hard = figures.ok && noLeak(r.text) && !TRIP_TALK.test(r.text) && saysNew && saysLarge
    const g = await judgeGroundedness({ answer: r.text, context: flaggedData })
    record({ case: 'money: flags voiced, no more', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: r.text.slice(0, 80) })
    expect(figures.missing).toEqual([])
    expect(r.text).not.toMatch(TRIP_TALK)
    expect(saysNew).toBe(true)
    expect(saysLarge).toBe(true)
    expect(noLeak(r.text)).toBe(true)
  })

  it('has the claim check cut a fabricated trip, and the decision hold whatever is left', async () => {
    const evidence = `INSTRUCTION:\n${WATCHERS.money.instruction}\n\nDATA:\n${lisbonData}`
    const review = await reviewDraft({
      label: '2Up transactions',
      draft: 'Looks like someone booked flights to Lisbon, planning a trip? $389.60 via Faresaver.',
      evidence,
    })
    const tripCut = review.message === null || !TRIP_TALK.test(review.message)
    let posted = ''
    let note = `review: ${review.unsupported.length}/${review.claims.length} cut`
    if (review.message !== null) {
      const d = await decideWatcherPost({ label: '2Up transactions', draft: review.message, evidence })
      posted = d.decision === 'post' ? review.message : ''
      note += ` | ${d.decision}@${d.confidence}`
    }
    const hard = tripCut && (posted === '' || (!TRIP_TALK.test(posted) && figuresGrounded(posted, lisbonData).ok))
    record({ case: 'review: fabricated Lisbon trip', hard: hard ? 'pass' : 'fail', model: 'chain', note })
    expect(tripCut).toBe(true)
    if (posted) {
      expect(posted).not.toMatch(TRIP_TALK)
      expect(figuresGrounded(posted, lisbonData).missing).toEqual([])
    }
  })

  it('lets a grounded draft through the claim check untouched', async () => {
    const draft = '2Up: **$389.60** FARESAVER LISBON, Tue 26 Aug. Purpose not recorded.'
    const review = await reviewDraft({ label: '2Up transactions', draft, evidence: `INSTRUCTION:\n${WATCHERS.money.instruction}\n\nDATA:\n${lisbonData}` })
    const hard = review.message === draft
    record({ case: 'review: grounded draft untouched', hard: hard ? 'pass' : 'fail', model: 'chain', note: `${review.claims.length} claims, ${review.unsupported.length} cut` })
    expect(review.unsupported).toEqual([])
    expect(review.message).toBe(draft)
  })

  it('lets a plain, grounded draft through', async () => {
    const draft = '2Up: **$389.60** FARESAVER LISBON, Tue 26 Aug. Purpose not recorded.'
    const d = await decideWatcherPost({ label: '2Up transactions', draft, evidence: `INSTRUCTION:\n${WATCHERS.money.instruction}\n\nDATA:\n${lisbonData}` })
    const hard = d.decision === 'post'
    record({ case: 'decision: grounded draft posts', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}` })
    expect(d.decision).toBe('post')
  })
})

const PROMO = { id: 'm2', from: 'deals@bigretailer.example', subject: '48 hours only: 30% off everything', snippet: 'Shop the sale', date: '2026-09-16T07:00:00+10:00' }
const briefInstruction = watcherInstruction('morning', base.chatId)
const mailbox = (messages: object[]) => ({ accounts: [{ member: 'Rowan', mailbox: "Rowan's Gmail", provider: 'google', first_check: false, messages }] })

describe.skipIf(!liveChainConfigured())('morning brief, the mail half', () => {
  it('proposes the date it read, and does not invent one', async () => {
    calls.length = 0
    const data = plainData({
      events: { events: [] },
      mail: mailbox([
        { id: 'm1', from: 'office@riverbendcollege.example', subject: 'Athletics carnival', snippet: 'Dear families, the athletics carnival is on Thursday 15 October...', date: '2026-09-01T08:10:00+10:00' },
        { ...PROMO, date: '2026-09-01T07:00:00+10:00' },
      ]),
    })
    const r = await runAgent({ ...base, tools: WATCHERS.morning.tools, text: `Scheduled check "Morning brief".\n\n${WATCHERS.morning.instruction}\n\nDATA (fetched just now):\n${data}` })
    const proposals = called(calls, 'propose_family_event')
    const proposedRight = proposals.some((p) => {
      const input = p.input as { title?: string; start?: string }
      return /athletics|carnival/i.test(input.title ?? '') && (input.start ?? '').startsWith('2026-10-15')
    })
    const hard = proposedRight && noLeak(r.text) && !/30%|sale/i.test(r.text)
    const g = await judgeGroundedness({ answer: r.text, context: `${data}\n${plainData(BODIES.m1)}` })
    record({ case: 'inbox: school notice proposed, promo ignored', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: r.text.slice(0, 80) })
    expect(proposedRight).toBe(true)
    expect(r.text).not.toMatch(/30%|sale/i)
    expect(noLeak(r.text)).toBe(true)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })
})

/*
 * A brief was once held back at 0.80 because the decision took a bulk sender's
 * ticket email for a promotion and vetoed the whole post. The decision judges
 * grounding, not selection, and the writer's instruction says what a
 * newsletter is; these three cases hold both ends of that.
 */
const TICKETS = {
  id: 'm3', from: 'noreply@riverbendcollege.example', subject: "Parents' association trivia night: tickets",
  snippet: "Dear families, the parents' association trivia night is on Friday 23 October 2026 from 7pm in the college hall. Tickets are $20 each. Book by Friday 16 October.",
  date: '2026-09-16T15:02:00+10:00',
}
const briefData = plainData({
  events: { timezone: 'Australia/Melbourne', events: [{ id: 41, title: 'Last day of term', start_local: 'Thu 17 Sep 2026 00:00', end_local: 'Fri 18 Sep 2026 00:00', all_day: true, location: null }] },
  mail: mailbox([TICKETS, PROMO]),
})
const briefDraft = [
  '**Morning brief**',
  '**Today**',
  '- Last day of term, all day.',
  '**To do**',
  "- Rowan's Gmail: the parents' association trivia night is Friday 23 October 2026 from 7pm in the college hall. Tickets $20 each; book by Friday 16 October.",
].join('\n')
const briefEvidence = `INSTRUCTION:\n${briefInstruction}\n\nDATA:\n${briefData}\n\nTOOL RESULTS:\n(none)`

describe.skipIf(!liveChainConfigured())('morning brief, the post check', () => {
  it('keeps a ticket email from a bulk sender and drops the promotion', async () => {
    calls.length = 0
    const r = await runAgent({ ...base, tools: WATCHERS.morning.tools, text: `Scheduled check "Morning brief".\n\n${briefInstruction}\n\nDATA (fetched just now):\n${briefData}` })
    const kept = /trivia|tickets?/i.test(r.text)
    const dropped = !/30%|off everything|bigretailer/i.test(r.text)
    const hard = kept && dropped && noLeak(r.text)
    const g = await judgeGroundedness({ answer: r.text, context: `${briefData}\n${plainData(BODIES.m3)}` })
    record({ case: 'brief: ticket email kept, promo dropped', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: r.text.slice(0, 80) })
    expect(kept).toBe(true)
    expect(dropped).toBe(true)
    expect(noLeak(r.text)).toBe(true)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })

  it('does not hold a grounded brief back over an item it could read as a promotion', async () => {
    const d = await decideWatcherPost({ label: 'Morning brief', draft: briefDraft, evidence: briefEvidence })
    const hard = d.decision === 'post'
    record({ case: 'decision: ticket item is no reason to skip', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}${d.reason ? ` ${d.reason}` : ''}` })
    expect(d.decision).toBe('post')
  })

  it('still holds the same brief back when a figure is not in the evidence', async () => {
    const d = await decideWatcherPost({ label: 'Morning brief', draft: briefDraft.replace('$20', '$30'), evidence: briefEvidence })
    const held = d.decision === 'skip'
    record({ case: 'decision: invented price still skips', hard: held ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}${d.reason ? ` ${d.reason}` : ''}` })
    expect(held).toBe(true)
  })

  // A brief was held back at 1.00 because the writer kept a collection whose
  // time had passed and the decision enforced the instruction's rule against
  // it. The item was the writer's slip and everything it said was in the
  // evidence: that is a post, stale bullet and all, never a lost brief.
  it('does not hold a grounded brief back over a collection whose time has passed', async () => {
    const data = plainData({ events: { timezone: 'Australia/Melbourne', events: [] }, mail: mailbox(TRIAGE) })
    const draft = [
      '**To do**',
      `- In Rowan's Gmail, Sign Desk asks for a signature on the lease renewal for 12 Elm Street by ${DAYS.due}.`,
      '**Heads up**',
      "- In Rowan's Gmail, Northbank Broadband says the connection at 12 Elm Street is active and the plan has started.",
      `- In Rowan's Gmail, Surplus Bites says the Mystery Box from Corner Bakery Hillside is ready for collection on ${DAYS.stale} between 6:00 pm and 6:30 pm at 18 Station Street, Hillside.`,
    ].join('\n')
    const d = await decideWatcherPost({ label: 'Morning brief', draft, evidence: `INSTRUCTION:\n${briefInstruction}\n\nDATA:\n${data}\n\nTOOL RESULTS:\n(none)` })
    const hard = d.decision === 'post'
    record({ case: 'decision: a stale collection is no reason to skip', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}${d.reason ? ` ${d.reason}` : ''}` })
    expect(d.decision).toBe('post')
  })
})

/*
 * A brief was held back whole, at 0.95, over one To do: a school's online
 * form, which the mailbox also held the school's thanks for, sent three hours
 * after the form and before the brief. The claim check passed the statement
 * (the form email says it); the judge, with the thanks beside it, called it
 * not in the evidence. Two things changed: the writer is told that a request
 * a later email says is done gets no bullet, and when the judge faults one
 * statement of a checked draft the tick cuts that and judges the rest again.
 * These hold both.
 */
const FORM = {
  id: 'm40', from: 'Riverbend College <forms@riverbendcollege.example>', subject: 'Slip from Riverbend College for Year 1 Swimming Program',
  snippet: `Year 1 Swimming Program\n\nDear Rowan,\n\nRiverbend College has sent you a new online form for Juno.\n\nWe need your response by ${DAYS.due}. Please click this link to respond.`,
  date: new Date(Date.now() - 86_400_000 - 4 * 3600_000).toISOString(),
}
const FORM_DONE = {
  id: 'm41', from: 'Riverbend College <forms@riverbendcollege.example>', subject: "Thank you for your response 'Year 1 Swimming Program'",
  snippet: 'Year 1 Swimming Program\n\nDear Rowan,\n\nThank you for your reply for Juno.\n\nYou can click this link at any time to view the form you submitted.',
  date: new Date(Date.now() - 86_400_000 - 3600_000).toISOString(),
}
const answeredData = plainData({ events: { timezone: 'Australia/Melbourne', events: [] }, mail: mailbox([FORM_DONE, TRIAGE[1], FORM]) })
const answeredEvidence = `INSTRUCTION:\n${briefInstruction}\n\nDATA:\n${answeredData}\n\nTOOL RESULTS:\n(none)`
const staleDraft = [
  '**To do**',
  `- In Rowan's Gmail, Riverbend College asks for a response to the Year 1 Swimming Program online form for Juno by ${DAYS.due}.`,
  '**Heads up**',
  "- In Rowan's Gmail, Northbank Broadband says the connection at 12 Elm Street is active and the plan has started.",
].join('\n')

describe.skipIf(!liveChainConfigured())('morning brief, a request answered since', () => {
  it('gives no To do to a form a later email thanks the household for submitting', async () => {
    calls.length = 0
    const r = await runAgent({ ...base, tools: WATCHERS.morning.tools, text: `Scheduled check "Morning brief".\n\n${briefInstruction}\n\nDATA (fetched just now):\n${answeredData}` })
    const text = r.text
    if (process.env.EVAL_PRINT) console.log(`\n----- answered-form brief -----\n${text}\n-----`)
    const toDo = text.search(/\*\*\s*to[ -]?do\b/i)
    const headsUp = text.search(/\*\*\s*heads[ -]?up\b/i)
    const toDoPart = toDo < 0 ? '' : text.slice(toDo, headsUp > toDo ? headsUp : undefined)
    const formNotAsked = !/swimming|form/i.test(toDoPart)
    const broadbandKept = /broadband|connection|internet/i.test(text)
    const hard = formNotAsked && broadbandKept && noLeak(text)
    const g = await judgeGroundedness({ answer: text, context: answeredData })
    record({ case: 'brief: answered form gets no To do', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: text.slice(0, 80) })
    expect(formNotAsked).toBe(true)
    expect(broadbandKept).toBe(true)
    expect(noLeak(text)).toBe(true)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })

  it('posts the rest of a checked brief when the judge faults the stale To do, rather than holding it all', async () => {
    const label = 'Morning brief'
    const review = await reviewDraft({ label, draft: staleDraft, evidence: answeredEvidence })
    const draft = review.message ?? staleDraft
    const verified = review.claims.length > 0 && review.unsupported.length === 0
    const first = await decideWatcherPost({ label, draft, evidence: answeredEvidence, verified })
    let note = `check: ${review.unsupported.length}/${review.claims.length} cut | first ${first.decision}@${first.confidence}${first.notInEvidence ? ` naming: ${first.notInEvidence}` : ''}`
    let posted: string | null = first.decision === 'post' ? draft : null
    let rest: string | null = null
    if (first.decision === 'skip' && first.notInEvidence) {
      // What the tick does with that answer.
      rest = await cutFromDraft({ label, draft, unsupported: [first.notInEvidence] })
      const second = rest ? await decideWatcherPost({ label, draft: rest, evidence: answeredEvidence, verified: false }) : null
      note += ` | cut: ${rest ? 'rest kept' : 'nothing left'}${second ? ` | second ${second.decision}@${second.confidence}${second.reason ? ` ${second.reason}` : ''}` : ''}`
      posted = second?.decision === 'post' && rest ? rest : null
    }
    const hard = posted !== null && /broadband|connection/i.test(posted) && (rest === null || !/swimming/i.test(rest))
    record({ case: 'decision: stale To do cut, the rest posts', hard: hard ? 'pass' : 'fail', model: first.model, note })
    expect(posted).not.toBeNull()
    expect(posted).toMatch(/broadband|connection/i)
    if (rest !== null) expect(rest).not.toMatch(/swimming/i)
  })
})

/*
 * A brief once wrote every email as `Sender ("Subject"): summary`, with the
 * escapes JSON had put round a quoted subject still in it, and gave an order
 * collected the evening before the same weight as a signature still wanted.
 * The instruction now sorts mail into what is still asked of the household
 * and what is only worth knowing, drops what has already happened, and never
 * quotes a subject line; DATA arrives as plain lines with nothing to escape.
 */
describe.skipIf(!liveChainConfigured())('morning brief, the mail triage', () => {
  it('sorts a signature wanted from a notice, drops a collection already past, and quotes no subject line', async () => {
    calls.length = 0
    const data = plainData({ events: { timezone: 'Australia/Melbourne', events: [] }, mail: mailbox([...TRIAGE, PROMO]) })
    const r = await runAgent({ ...base, tools: WATCHERS.morning.tools, text: `Scheduled check "Morning brief".\n\n${briefInstruction}\n\nDATA (fetched just now):\n${data}` })
    const text = r.text
    const toDo = text.search(/\*\*\s*to[ -]?do\b/i)
    const headsUp = text.search(/\*\*\s*heads[ -]?up\b/i)
    const sorted =
      toDo >= 0 && headsUp > toDo &&
      /lease|signature|sign\b/i.test(text.slice(toDo, headsUp)) &&
      /internet|connection|broadband/i.test(text.slice(headsUp)) &&
      !/lease|signature/i.test(text.slice(headsUp))
    const pastDropped = !/mystery box|corner bakery|surplus bites|collection/i.test(text)
    const promoDropped = !/30%|off everything/i.test(text)
    const noQuotedSubject = !text.includes('\\"') && !/\("[^"\n]*"\)/.test(text)
    const hard = sorted && pastDropped && promoDropped && noQuotedSubject && noLeak(text)
    const g = await judgeGroundedness({ answer: text, context: data })
    record({ case: 'brief: to do apart from heads up, past order dropped, no quoted subject', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: text.slice(0, 80) })
    expect(sorted).toBe(true)
    expect(pastDropped).toBe(true)
    expect(promoDropped).toBe(true)
    expect(noQuotedSubject).toBe(true)
    expect(noLeak(text)).toBe(true)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })
})
