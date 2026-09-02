import { describe, it, expect, vi, afterAll } from 'vitest'
import { withRecorded, called, liveChainConfigured } from './harness'
import { figuresGrounded, noLeak, TRIP_TALK, judgeGroundedness, record, printSummary, strict } from './scorers'

const calls = vi.hoisted(() => [] as { tool: string; input: unknown }[])
const STUBS = vi.hoisted(() => ({
  recall: () => ({ memories: [{ id: 3, fact: 'Winter goes to Northcote Primary' }] }),
  list_family_events: () => ({ timezone: 'Australia/Melbourne', events: [] }),
  list_email: () => ({ accounts: [{ provider: 'google', messages: [] }] }),
  read_email: () => ({
    id: 'm1', from: 'office@northcoteps.vic.edu.au', subject: 'Sports Day', date: '2026-09-01T08:10:00+10:00',
    body: 'Dear families, Sports Day is on Wednesday 10 September 2026 from 9am to 12pm at the school oval. Students wear house colours. No RSVP needed.',
  }),
  propose_family_event: (input: unknown) => ({ proposal_id: 7, proposed: input }),
}))
vi.mock('@/lib/tools', async (orig) => {
  const actual = await orig<typeof import('@/lib/tools')>()
  return { ...actual, buildTools: (ctx: Parameters<typeof actual.buildTools>[0]) => withRecorded(actual.buildTools(ctx), STUBS, calls) }
})

const { runAgent, decideWatcherPost } = await import('@/lib/agent')
const { WATCHERS } = await import('@/lib/watchers')

const SEATTLE = {
  transactions: {
    account: '2Up', first_check: false, count: 1,
    transactions: [{ description: 'CHEAPTICKETS SEATTLE', amount: '$412.30', when: 'Tue 26 Aug 2026, 14:02', status: 'SETTLED', by: 'Logan', message: null, flags: [] as string[] }],
  },
}
const seattleData = JSON.stringify(SEATTLE, null, 1)
const FLAGGED = { transactions: { ...SEATTLE.transactions, typical_debit: '$48.35', history_days: 90, transactions: [{ ...SEATTLE.transactions.transactions[0], flags: ['new_payee', 'unusually_large'] }] } }
const flaggedData = JSON.stringify(FLAGGED, null, 1)
const base = { chatId: '-100', chatType: 'group', member: null, memberName: 'the family', history: false as const, mode: 'watcher' as const }

afterAll(() => printSummary('watchers'))

describe.skipIf(!liveChainConfigured())('money watcher', () => {
  it('phrases a payee string as a payee string, with no trip and no purpose', async () => {
    calls.length = 0
    const r = await runAgent({ ...base, tools: WATCHERS.money.tools, text: `Scheduled check "2Up transactions".\n\n${WATCHERS.money.instruction}\n\nDATA (fetched just now):\n${seattleData}` })
    const figures = figuresGrounded(r.text, seattleData)
    const NO_FLAG_TALK = /new payee|unusual|larger than|duplicate/i
    const hard = figures.ok && noLeak(r.text) && !TRIP_TALK.test(r.text) && !NO_FLAG_TALK.test(r.text) && /412\.30/.test(r.text) && /purpose not recorded|does not say|not stated/i.test(r.text)
    const g = await judgeGroundedness({ answer: r.text, context: seattleData })
    record({ case: 'money: CHEAPTICKETS SEATTLE line, no flags', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: r.text.slice(0, 80) })
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

  it('has the post decision reject or rewrite a fabricated trip', async () => {
    const d = await decideWatcherPost({
      label: '2Up transactions',
      draft: 'Looks like someone booked flights to Seattle, planning a trip? $412.30 via Cheaptickets.',
      evidence: `INSTRUCTION:\n${WATCHERS.money.instruction}\n\nDATA:\n${seattleData}`,
    })
    const posted = d.decision === 'post' && d.confidence >= 0.7 ? (d.message ?? '') : ''
    const hard = posted === '' || (!TRIP_TALK.test(posted) && figuresGrounded(posted, seattleData).ok)
    record({ case: 'decision: fabricated Seattle trip', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}` })
    if (posted) {
      expect(posted).not.toMatch(TRIP_TALK)
      expect(figuresGrounded(posted, seattleData).missing).toEqual([])
    }
  })

  it('lets a plain, grounded draft through', async () => {
    const draft = '2Up: **$412.30** CHEAPTICKETS SEATTLE, Tue 26 Aug. Purpose not recorded.'
    const d = await decideWatcherPost({ label: '2Up transactions', draft, evidence: `INSTRUCTION:\n${WATCHERS.money.instruction}\n\nDATA:\n${seattleData}` })
    const hard = d.decision === 'post' && d.confidence >= 0.7
    record({ case: 'decision: grounded draft posts', hard: hard ? 'pass' : 'fail', model: d.model, note: `${d.decision}@${d.confidence}` })
    expect(d.decision).toBe('post')
    expect(d.confidence).toBeGreaterThanOrEqual(0.7)
  })
})

describe.skipIf(!liveChainConfigured())('inbox watcher', () => {
  it('proposes the date it read, and does not invent one', async () => {
    calls.length = 0
    const data = JSON.stringify({
      mail: { accounts: [{ member: 'Logan', provider: 'google', first_check: false, messages: [
        { id: 'm1', from: 'office@northcoteps.vic.edu.au', subject: 'Sports Day', snippet: 'Dear families, Sports Day is on Wednesday 10 September...', date: '2026-09-01T08:10:00+10:00' },
        { id: 'm2', from: 'deals@bigretailer.example', subject: '48 hours only: 30% off everything', snippet: 'Shop the sale', date: '2026-09-01T07:00:00+10:00' },
      ] }] },
    }, null, 1)
    const r = await runAgent({ ...base, tools: WATCHERS.inbox.tools, text: `Scheduled check "Inbox sweep".\n\n${WATCHERS.inbox.instruction}\n\nDATA (fetched just now):\n${data}` })
    const proposals = called(calls, 'propose_family_event')
    const proposedRight = proposals.some((p) => {
      const input = p.input as { title?: string; start?: string }
      return /sports/i.test(input.title ?? '') && (input.start ?? '').startsWith('2026-09-10')
    })
    const hard = proposedRight && noLeak(r.text) && !/30%|sale/i.test(r.text)
    const g = await judgeGroundedness({ answer: r.text, context: `${data}\n${JSON.stringify(STUBS.read_email())}` })
    record({ case: 'inbox: school notice proposed, promo ignored', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: r.text.slice(0, 80) })
    expect(proposedRight).toBe(true)
    expect(r.text).not.toMatch(/30%|sale/i)
    expect(noLeak(r.text)).toBe(true)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })
})
