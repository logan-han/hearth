import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { withRecorded, liveChainConfigured } from './harness'
import { figuresGrounded, noLeak, TRIP_TALK, CLOCK_TIME, judgeGroundedness, judgeUsefulness, record, printSummary, strict } from './scorers'

const calls = vi.hoisted(() => [] as { tool: string; input: unknown }[])
const STUBS = vi.hoisted(() => ({
  list_transactions: () => ({
    account: '2Up',
    transactions: [
      { description: 'CHEAPTICKETS SEATTLE', amount: '$412.30', when: 'Tue 26 Aug 2026, 14:02', status: 'SETTLED', by: 'Logan' },
      { description: 'WOOLWORTHS 3061 NORTHCOTE', amount: '$86.15', when: 'Mon 25 Aug 2026, 18:40', status: 'SETTLED', by: 'Yuna' },
    ],
  }),
  list_bank_accounts: () => ({ up: [{ name: '2Up', type: 'TRANSACTIONAL', ownership: 'JOINT', balance: '$1,204.55', shared: true }] }),
  spending_summary: () => ({ error: 'PocketSmith is not configured.' }),
  list_calendar: () => ({ events: [] }),
  list_family_events: () => ({ timezone: 'Australia/Melbourne', events: [] }),
  list_email: () => ({
    accounts: [{ provider: 'google', messages: [
      { id: 'm1', from: 'office@northcoteps.vic.edu.au', subject: 'Sports Day', snippet: 'Dear families, Sports Day is on Wednesday 10 September...', date: '2026-09-01T08:10:00+10:00' },
    ] }],
  }),
  read_email: () => ({
    id: 'm1', from: 'office@northcoteps.vic.edu.au', subject: 'Sports Day', date: '2026-09-01T08:10:00+10:00',
    body: 'Dear families, Sports Day is on Wednesday 10 September 2026 from 9am to 12pm at the school oval. Students wear house colours.',
  }),
  web_search: () => ({ answer: null, results: [] }),
}))
vi.mock('@/lib/tools', async (orig) => {
  const actual = await orig<typeof import('@/lib/tools')>()
  return { ...actual, buildTools: (ctx: Parameters<typeof actual.buildTools>[0]) => withRecorded(actual.buildTools(ctx), STUBS, calls) }
})

const { freshDb, closeDb } = await import('@/tests/helpers/db')
const q = await import('@/lib/db/queries')
const { runAgent } = await import('@/lib/agent')

let client: PGlite
beforeEach(async () => {
  calls.length = 0
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))
afterAll(() => printSummary('chat'))

const context = () => Object.entries(STUBS).map(([k, fn]) => `${k} -> ${JSON.stringify(fn())}`).join('\n')

describe.skipIf(!liveChainConfigured())('chat grounding', () => {
  it('explains a charge from the feed without inventing a trip', async () => {
    const logan = await q.upsertMember('111', 'Logan', { allowed: true })
    const text = 'what was that $412 charge on 2up?'
    const r = await runAgent({ chatId: '111', chatType: 'private', member: logan, memberName: 'Logan', text })
    const figures = figuresGrounded(r.text, context())
    const hard = figures.ok && noLeak(r.text) && !TRIP_TALK.test(r.text) && /cheaptickets/i.test(r.text)
    const [g, u] = await Promise.all([judgeGroundedness({ answer: r.text, context: context() }), judgeUsefulness({ task: text, answer: r.text })])
    record({ case: 'chat: $412 charge, no trip', hard: hard ? 'pass' : 'fail', groundedness: g.score, usefulness: u.score, model: r.model, note: r.text.slice(0, 80) })
    expect(figures.missing).toEqual([])
    expect(r.text).not.toMatch(TRIP_TALK)
    expect(r.text).toMatch(/cheaptickets/i)
    expect(noLeak(r.text)).toBe(true)
    if (strict()) {
      expect(g.score).toBeGreaterThanOrEqual(0.9)
      expect(u.score).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('reaches the mail tools from an email cue and reads the date off the notice', async () => {
    const logan = await q.upsertMember('111', 'Logan', { allowed: true })
    await q.saveConnection({ memberId: logan.id, provider: 'google', email: 'logan@example.com', refreshToken: 'r', scopes: null })
    const text = 'did the school email say when sports day is?'
    const r = await runAgent({ chatId: '111', chatType: 'private', member: logan, memberName: 'Logan', text })
    const usedMail = calls.some((c) => c.tool === 'list_email' || c.tool === 'read_email')
    const hard = usedMail && /10 sep|september 10|10\/09|wednesday 10/i.test(r.text) && noLeak(r.text) && !CLOCK_TIME.test(r.text.replace(/9\s?am|12\s?pm|9:00|12:00/gi, ''))
    const g = await judgeGroundedness({ answer: r.text, context: context() })
    record({ case: 'chat: email cue routes to mail', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: r.text.slice(0, 80) })
    expect(usedMail).toBe(true)
    expect(r.text).toMatch(/10 sep|september 10|10\/09|wednesday 10/i)
    expect(noLeak(r.text)).toBe(true)
  })

  it('unlocks the mail tools itself when the wording gave no cue', async () => {
    const logan = await q.upsertMember('111', 'Logan', { allowed: true })
    await q.saveConnection({ memberId: logan.id, provider: 'google', email: 'logan@example.com', refreshToken: 'r', scopes: null })
    const text = 'what did the school say about sports day?'
    const r = await runAgent({ chatId: '111', chatType: 'private', member: logan, memberName: 'Logan', text })
    const unlocked = calls.some((c) => c.tool === 'more_tools' && (c.input as { group?: string }).group === 'mail')
    const usedMail = calls.some((c) => c.tool === 'list_email' || c.tool === 'read_email')
    const hard = unlocked && usedMail && /10 sep|september 10|wednesday 10/i.test(r.text) && noLeak(r.text)
    const g = await judgeGroundedness({ answer: r.text, context: context() })
    record({ case: 'chat: more_tools escape hatch', hard: hard ? 'pass' : 'fail', groundedness: g.score, model: r.model, note: `${calls.map((c) => c.tool).join('>')} | ${r.text.slice(0, 60)}` })
    expect(unlocked).toBe(true)
    expect(usedMail).toBe(true)
    expect(noLeak(r.text)).toBe(true)
  })

  it('says an appointment is not on record rather than making one up', async () => {
    const logan = await q.upsertMember('111', 'Logan', { allowed: true })
    await q.saveConnection({ memberId: logan.id, provider: 'google', email: 'logan@example.com', refreshToken: 'r', scopes: null })
    const text = "when is Ada's dentist appointment?"
    const r = await runAgent({ chatId: '111', chatType: 'private', member: logan, memberName: 'Logan', text })
    const hard = !CLOCK_TIME.test(r.text) && noLeak(r.text) && /not|no |nothing|can't|cannot|don't/i.test(r.text)
    const [g, u] = await Promise.all([judgeGroundedness({ answer: r.text, context: context() }), judgeUsefulness({ task: text, answer: r.text })])
    record({ case: 'chat: unknown appointment stays unknown', hard: hard ? 'pass' : 'fail', groundedness: g.score, usefulness: u.score, model: r.model, note: r.text.slice(0, 80) })
    expect(r.text).not.toMatch(CLOCK_TIME)
    expect(noLeak(r.text)).toBe(true)
    if (strict()) expect(g.score).toBeGreaterThanOrEqual(0.9)
  })
})
