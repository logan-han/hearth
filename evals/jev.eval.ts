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

  // "Can someone put swimming on the family calendar?" sits at 0.41: Jev reads
  // "someone" as the people in the chat, and the line agrees. A request put
  // plainly, and a question only the bot could answer, are the bot's.
  it('answers a request put to it and a question it alone can answer', async () => {
    const request = await wantsAssistant({ chatId: 'eval', conversation: [], message: 'Rowan: put swimming on the family calendar for Saturday 9am' })
    const question = await wantsAssistant({ chatId: 'eval', conversation: [], message: 'Rowan: is it going to rain tomorrow?' })
    record({ case: 'gate: calendar request replies', hard: request ? 'pass' : 'fail' })
    record({ case: 'gate: weather question replies', hard: question ? 'pass' : 'fail' })
    expect(request).toBe(true)
    expect(question).toBe(true)
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
    const hard = d.decision === 'post'
    record({ case: 'decision: grounded brief posts', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}` })
    expect(d.decision).toBe('post')
  })

  it('holds the same draft back when a figure is not in the evidence, checked or not', async () => {
    const invented = briefDraft.replace('$20', '$30')
    const d = await decidePost({ label: 'Morning brief', draft: invented, evidence: briefEvidence })
    const held = d.decision === 'skip'
    record({ case: 'decision: invented price holds', hard: held ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}${d.reason ? ` ${d.reason}` : ''}` })
    expect(held).toBe(true)

    // The higher line a checked draft is held to must still keep this out:
    // what the claim check misses is exactly what it is there for.
    const checked = await decidePost({ label: 'Morning brief', draft: invented, evidence: briefEvidence, verified: true })
    const stillHeld = checked.decision === 'skip'
    record({ case: 'decision: invented price holds even once checked', hard: stillHeld ? 'pass' : 'fail', model: checked.model, note: `${checked.decision}@${checked.confidence}` })
    expect(stillHeld).toBe(true)
  })

  /**
   * The brief of 22 Sep, in stand-in names: six bullets, nothing in any of
   * them outside the data, and every statement passed by the claim check
   * moments earlier at 0.99 and above. Asked of the whole draft at once this
   * question answered 0.53 against the 0.5 line and the brief never reached
   * the family. The line for a checked draft is what has to carry it.
   */
  it('does not hold a long brief back where every bullet is traceable to the mail it came from', async () => {
    const data = plainData({
      events: {
        timezone: 'Australia/Melbourne',
        events: [{ id: 13, title: 'Prep-6 $48 experience fee, vacation care', start_local: 'Tue 22 Sep 2026 00:00', end_local: 'Wed 23 Sep 2026 00:00', all_day: true, location: null }],
      },
      mail: {
        accounts: [
          { member: 'Rowan', mailbox: "Rowan's Gmail", provider: 'google', first_check: false, messages: [
            { id: 'm1', from: 'Larkfield Cloud <alerts@larkfieldcloud.example>', subject: "You've used 90% of your monthly compute allowance", snippet: 'Your compute is approaching its limit.', date: '2026-09-21T16:18:55+10:00' },
            { id: 'm2', from: 'Tidewater Goods <shipping@tidewatergoods.example>', subject: 'Shipped: laundry sheets', snippet: 'Your order has shipped and is on its way.', date: '2026-09-21T14:16:23+10:00' },
          ] },
          { member: 'Ada', mailbox: "Ada's Outlook", provider: 'microsoft', first_check: false, messages: [
            { id: 'm3', from: 'Marrow Health <noreply@marrowhealth.example>', subject: 'Your Achieve Conversation is overdue', snippet: 'Dear Ada Quill, Marrow Health requires all employees to have an Achieve Conversation with their manager annually.', date: '2026-09-21T18:34:17+10:00' },
            { id: 'm4', from: 'Meridian Air <news@meridianair.example>', subject: 'Mileage integration plan', snippet: 'On the full integration date of Dec 17, 2026, Coastal Air mileage will be automatically transferred to Meridian accounts.', date: '2026-09-21T00:17:12+10:00' },
            { id: 'm5', from: 'Eastvale Swim <accounts@eastvaleswim.example>', subject: 'Transaction receipt', snippet: 'Dear Ada, thank you for your payment that has been processed for your current charges, as of 21/09/2026.', date: '2026-09-20T22:47:54+10:00' },
          ] },
        ],
      },
    })
    const draft = [
      '**Today**',
      '- Prep-6 $48 experience fee, vacation care (all day)',
      '**To do**',
      "- In Ada's mailbox, Marrow Health sent an email stating that Ada Quill's Achieve Conversation is overdue.",
      '**Heads up**',
      "- In Rowan's Gmail, Larkfield Cloud sent a notice that Rowan has used 90% of the monthly compute allowance.",
      "- In Rowan's Gmail, Tidewater Goods sent a shipment notice that the laundry sheets have shipped.",
      "- In Ada's mailbox, Meridian Air sent a guide to the mileage integration plan, noting that on the full integration date of Dec 17, 2026, Coastal Air mileage will be automatically transferred to Meridian accounts.",
      "- In Ada's mailbox, Eastvale Swim sent a transaction receipt confirming a payment processed for current charges as of 21/09/2026.",
    ].join('\n')
    const d = await decidePost({
      label: 'Morning brief',
      draft,
      evidence: `INSTRUCTION:\n${briefInstruction}\n\nDATA:\n${data}\n\nTOOL RESULTS:\n(none)`,
      verified: true,
    })
    const hard = d.decision === 'post'
    // A post carries 1 - p(invented), so the note gives the number the line in
    // lib/jev.ts has to sit above; a skip carries the probability it skipped on.
    const note = hard ? `post, p(invented)=${Math.round((1 - d.confidence) * 100) / 100}` : `skip@${d.confidence}${d.reason ? ` ${d.reason}` : ''}`
    record({ case: 'decision: a checked six-bullet brief posts', hard: hard ? 'pass' : 'fail', model: d.model, note })
    expect(d.decision).toBe('post')
  })

  it('does not hold a grounded brief back over a collection whose time has passed', async () => {
    const longDay = (d: Date) =>
      new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d)
    const stale = longDay(new Date(Date.now() - 86_400_000))
    const data = plainData({
      events: { timezone: 'Australia/Melbourne', events: [] },
      mail: { accounts: [{ member: 'Rowan', mailbox: "Rowan's Gmail", provider: 'google', first_check: false, messages: [
        { id: 'm21', from: 'Northbank Broadband <noreply@northbankbroadband.example>', subject: 'Your internet connection is now active', snippet: 'Good news: the connection at 12 Elm Street is active and your plan has started. There is nothing you need to do.', date: '2026-09-20T18:00:00+10:00' },
        { id: 'm22', from: 'Surplus Bites <orders@surplusbites.example>', subject: 'Your order is confirmed', snippet: `Your Mystery Box from Corner Bakery Hillside is ready for collection on ${stale} between 6:00 pm and 6:30 pm at 18 Station Street, Hillside.`, date: '2026-09-20T14:00:00+10:00' },
      ] }] },
    })
    const draft = [
      '**Heads up**',
      "- In Rowan's Gmail, Northbank Broadband says the connection at 12 Elm Street is active and the plan has started.",
      `- In Rowan's Gmail, Surplus Bites says the Mystery Box from Corner Bakery Hillside is ready for collection on ${stale} between 6:00 pm and 6:30 pm at 18 Station Street, Hillside.`,
    ].join('\n')
    const d = await decidePost({ label: 'Morning brief', draft, evidence: `INSTRUCTION:\n${briefInstruction}\n\nDATA:\n${data}\n\nTOOL RESULTS:\n(none)` })
    const hard = d.decision === 'post'
    record({ case: 'decision: a stale collection is no reason to skip', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}${d.reason ? ` ${d.reason}` : ''}` })
    expect(d.decision).toBe('post')
  })

  it('skips a draft that only says there is nothing new', async () => {
    const d = await decidePost({ label: '2Up transactions', draft: 'Nothing new on 2Up today.', evidence: moneyEvidence })
    record({ case: 'decision: nothing-new draft skips', hard: d.decision === 'skip' ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}` })
    expect(d.decision).toBe('skip')
    expect(d.confidence).toBeGreaterThanOrEqual(THRESHOLDS.postNothingNew)
  })
})
