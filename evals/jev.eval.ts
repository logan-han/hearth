import { describe, it, expect, afterAll } from 'vitest'
import { record, printSummary } from './scorers'

/**
 * The typed judgements put to Jev on the cases the family has actually seen,
 * so a threshold in lib/jev.ts is judged on evidence rather than by feel.
 * Runs only with TYPESAFE_API_KEY set; each call costs a fraction of a cent.
 */
const { jevConfigured, wantsAssistant, claimsChange, checkClaims, decidePost, THRESHOLDS } = await import('@/lib/jev')
const { WATCHERS, watcherInstruction } = await import('@/lib/watchers')
const { plainData } = await import('@/lib/plain-data')

const LISBON = plainData({
  transactions: {
    account: '2Up', first_check: false, count: 1,
    transactions: [{ description: 'FARESAVER LISBON', amount: '$389.60', when: 'Tue 26 Aug 2026, 14:02', status: 'SETTLED', by: 'Rowan', message: null, flags: [] as string[] }],
  },
})
const moneyEvidence = `INSTRUCTION:\n${WATCHERS.money.instruction}\n\nDATA:\n${LISBON}`

afterAll(() => printSummary('jev'))

describe.skipIf(!jevConfigured())('the ambient gate on Jev', () => {
  it('stays out of banter and out of talk between people', async () => {
    const banter = await wantsAssistant({ chatId: 'eval', conversation: ['Sam: that movie was so bad'], message: 'Rowan: lol same' })
    const between = await wantsAssistant({ chatId: 'eval', conversation: [], message: 'Rowan: Sam can you grab milk on the way home?' })
    record({ case: 'gate: banter stays silent', hard: banter === false ? 'pass' : 'fail' })
    record({ case: 'gate: a request to another person stays silent', hard: between === false ? 'pass' : 'fail' })
    expect(banter).toBe(false)
    expect(between).toBe(false)
  })

  it('answers a request aimed at it', async () => {
    const r = await wantsAssistant({ chatId: 'eval', conversation: [], message: 'Rowan: can someone put swimming on the family calendar for Saturday 9am?' })
    record({ case: 'gate: calendar request replies', hard: r ? 'pass' : 'fail' })
    expect(r).toBe(true)
  })
})

describe.skipIf(!jevConfigured())('the reply check on Jev', () => {
  it('tells a change reported as made from an offer to make one', async () => {
    const claimed = await claimsChange({ reply: 'Done, I have replaced the dentist with Thursday 2pm.', chatId: 'eval' })
    const offered = await claimsChange({ reply: 'The dentist is on Thursday at 2pm. Want me to move it?', chatId: 'eval' })
    record({ case: 'claim: "done, replaced" is a claim', hard: claimed ? 'pass' : 'fail' })
    record({ case: 'claim: an offer is not', hard: offered === false ? 'pass' : 'fail' })
    expect(claimed).toBe(true)
    expect(offered).toBe(false)
  })
})

describe.skipIf(!jevConfigured())('the claim checks on Jev', () => {
  it('keeps the figure and the payee string, and cuts the trip read into it', async () => {
    const out = await checkClaims({
      label: '2Up transactions',
      claims: ['$389.60 was paid to FARESAVER LISBON', 'The payment was on Tue 26 Aug', 'A trip to Lisbon was booked', 'The payment was for flights'],
      evidence: moneyEvidence,
    })
    const [amount, date, trip, flights] = out
    const hard = amount.supported && date.supported && !trip.supported && !flights.supported
    record({ case: 'check: figures kept, trip and purpose cut', hard: hard ? 'pass' : 'fail', note: out.map((c) => `${c.supported ? 'keep' : 'cut'}@${c.p}`).join(' ') })
    expect(amount.supported).toBe(true)
    expect(date.supported).toBe(true)
    expect(trip.supported).toBe(false)
    expect(flights.supported).toBe(false)
  })
})

describe.skipIf(!jevConfigured())('the post decision on Jev', () => {
  const briefInstruction = watcherInstruction('morning', '-100')
  const briefData = plainData({
    events: { timezone: 'Australia/Melbourne', events: [{ id: 41, title: 'Last day of term', start_local: 'Thu 17 Sep 2026 00:00', end_local: 'Fri 18 Sep 2026 00:00', all_day: true, location: null }] },
    mail: {
      accounts: [{ member: 'Rowan', mailbox: "Rowan's Gmail", provider: 'google', first_check: false, messages: [{
        id: 'm3', from: 'noreply@riverbendcollege.example', subject: "Parents' association trivia night: tickets",
        snippet: "Dear families, the parents' association trivia night is on Friday 23 October 2026 from 7pm in the college hall. Tickets are $20 each. Book by Friday 16 October.",
        date: '2026-09-16T15:02:00+10:00',
      }] }],
    },
  })
  const briefDraft = [
    '**Morning brief**',
    '**Today**',
    '- Last day of term, all day.',
    '**To do**',
    "- Rowan's Gmail: the parents' association trivia night is Friday 23 October 2026 from 7pm in the college hall. Tickets $20 each; book by Friday 16 October.",
  ].join('\n')
  const briefEvidence = `INSTRUCTION:\n${briefInstruction}\n\nDATA:\n${briefData}\n\nTOOL RESULTS:\n(none)`

  it('posts a grounded draft', async () => {
    const d = await decidePost({ label: 'Morning brief', draft: briefDraft, evidence: briefEvidence })
    const hard = d.decision === 'post' && d.confidence >= 0.7
    record({ case: 'decision: grounded brief posts', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}` })
    expect(d.decision).toBe('post')
    expect(d.confidence).toBeGreaterThanOrEqual(0.7)
  })

  it('holds the same draft back when a figure is not in the evidence', async () => {
    const d = await decidePost({ label: 'Morning brief', draft: briefDraft.replace('$20', '$30'), evidence: briefEvidence })
    const held = d.decision === 'skip' || d.confidence < 0.7
    record({ case: 'decision: invented price holds', hard: held ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}${d.reason ? ` ${d.reason}` : ''}` })
    expect(held).toBe(true)
  })

  it('skips a draft that only says there is nothing new', async () => {
    const d = await decidePost({ label: '2Up transactions', draft: 'Nothing new on 2Up today.', evidence: moneyEvidence })
    record({ case: 'decision: nothing-new draft skips', hard: d.decision === 'skip' ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}` })
    expect(d.decision).toBe('skip')
    expect(d.confidence).toBeGreaterThanOrEqual(THRESHOLDS.postNothingNew)
  })
})
