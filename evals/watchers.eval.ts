import { describe, it, expect, vi, afterAll } from 'vitest'
import { withRecorded, called, liveChainConfigured } from './harness'
import { figuresGrounded, noLeak, TRIP_TALK, judgeGroundedness, record, printSummary, strict } from './scorers'

const calls = vi.hoisted(() => [] as { tool: string; input: unknown }[])
const { STUBS, BODIES, TRIAGE } = vi.hoisted(() => {
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
  const STUBS = {
    recall: () => ({ memories: [{ id: 3, fact: 'Juno goes to Riverbend College' }] }),
    list_family_events: () => ({ timezone: 'Australia/Melbourne', events: [] }),
    list_email: () => ({ accounts: [{ mailbox: "Rowan's Gmail", provider: 'google', messages: [] }] }),
    read_email: ({ id }: { id?: string } = {}) => BODIES[id ?? 'm1'] ?? { error: `No message ${id}.` },
    propose_family_event: (input: unknown) => ({ proposal_id: 7, proposed: input }),
  }
  return { STUBS, BODIES, TRIAGE }
})
vi.mock('@/lib/tools', async (orig) => {
  const actual = await orig<typeof import('@/lib/tools')>()
  return { ...actual, buildTools: (ctx: Parameters<typeof actual.buildTools>[0]) => withRecorded(actual.buildTools(ctx), STUBS, calls) }
})

const { runAgent, decideWatcherPost, reviewDraft } = await import('@/lib/agent')
const { WATCHERS, watcherInstruction } = await import('@/lib/watchers')
const { plainData } = await import('@/lib/plain-data')

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

afterAll(() => printSummary('watchers'))

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
      posted = d.decision === 'post' && d.confidence >= 0.7 ? review.message : ''
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
    const hard = d.decision === 'post' && d.confidence >= 0.7
    record({ case: 'decision: grounded draft posts', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}` })
    expect(d.decision).toBe('post')
    expect(d.confidence).toBeGreaterThanOrEqual(0.7)
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
    const hard = d.decision === 'post' && d.confidence >= 0.7
    record({ case: 'decision: ticket item is no reason to skip', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}${d.reason ? ` ${d.reason}` : ''}` })
    expect(d.decision).toBe('post')
    expect(d.confidence).toBeGreaterThanOrEqual(0.7)
  })

  it('still holds the same brief back when a figure is not in the evidence', async () => {
    const d = await decideWatcherPost({ label: 'Morning brief', draft: briefDraft.replace('$20', '$30'), evidence: briefEvidence })
    const held = d.decision === 'skip' || d.confidence < 0.7
    record({ case: 'decision: invented price still skips', hard: held ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}${d.reason ? ` ${d.reason}` : ''}` })
    expect(held).toBe(true)
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
