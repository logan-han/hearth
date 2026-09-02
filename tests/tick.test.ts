import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Automation } from '@/lib/db/schema'

const dueAutomations = vi.fn<(now: Date) => Promise<Automation[]>>()
const claimAutomation = vi.fn<(id: number, expected: Date, next: Date | null) => Promise<boolean>>()
const runAgent = vi.fn()
const decideWatcherPost = vi.fn()
const reviewDraft = vi.fn()
const newTransactions = vi.fn()
const newMail = vi.fn()
const listEvents = vi.fn()
const boardSummary = vi.fn()
const weatherTool = vi.fn()
const send = vi.fn<(chatId: string, text: string) => Promise<void>>()
const verify = vi.fn<() => Promise<boolean>>()
const insertValues = vi.fn()

const { recordMessage, messagesSince, getSetting, setSetting } = vi.hoisted(() => ({
  recordMessage: vi.fn(async () => 1),
  messagesSince: vi.fn(async () => [] as unknown[]),
  getSetting: vi.fn<(key: string) => Promise<string | null>>(async () => null),
  setSetting: vi.fn<(key: string, value: string) => Promise<void>>(async () => {}),
}))
vi.mock('@/lib/db/queries', () => ({
  dueAutomations,
  claimAutomation,
  recordMessage,
  messagesSince,
  getSetting,
  setSetting,
  allowedMembers: vi.fn(async () => [
    { id: 9, telegramUserId: '900', name: 'Boss', isAdmin: true, allowed: true },
  ]),
}))
vi.mock('@/lib/agent', () => ({ runAgent, decideWatcherPost, reviewDraft }))
vi.mock('@/lib/tools', () => ({
  buildTools: () => ({
    new_transactions: { execute: newTransactions },
    new_mail: { execute: newMail },
    list_family_events: { execute: listEvents },
    jira_board_summary: { execute: boardSummary },
    weather: { execute: weatherTool },
  }),
}))
vi.mock('@/lib/telegram', () => ({ send }))
vi.mock('@upstash/qstash', () => ({ Receiver: class { verify = verify } }))
vi.mock('@/lib/db', () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({ values: insertValues }),
  }),
  schema: { members: { id: 'id' }, messages: {} },
}))

const { POST, GET } = await import('@/app/api/tick/route')

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: 1,
    chatId: '-100999',
    memberId: null,
    label: 'bin night',
    cronExpr: '0 19 * * 1',
    instruction: 'Remind everyone to put the bins out.',
    kind: null,
    nextRunAt: new Date('2026-09-07T09:00:00Z'),
    lastRunAt: null,
    enabled: true,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  } as Automation
}

function tick(headers: Record<string, string> = {}) {
  return POST(new Request('https://hearth.test/api/tick', { method: 'POST', headers, body: '' }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const k of ['QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'TICK_SECRET']) {
    delete process.env[k]
  }
  send.mockResolvedValue(undefined)
  dueAutomations.mockResolvedValue([])
  claimAutomation.mockResolvedValue(true)
  runAgent.mockResolvedValue({ text: 'Bins out tonight.', notices: [], model: 'primary:test' })
  decideWatcherPost.mockResolvedValue({ decision: 'post', confidence: 0.9, model: 'primary:test' })
  reviewDraft.mockImplementation(async ({ draft }: { draft: string }) => ({ claims: [], unsupported: [], message: draft }))
  newTransactions.mockResolvedValue({ account: '2Up', count: 0, transactions: [] })
  newMail.mockResolvedValue({ accounts: [] })
  listEvents.mockResolvedValue({ events: [] })
  boardSummary.mockResolvedValue({ error: 'Jira is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).' })
  weatherTool.mockResolvedValue({ error: 'Weather is not configured (OPENWEATHER_API_KEY missing).' })
  // The nightly memory pass reports done-for-today by default, so ordinary
  // tests never depend on what the wall clock says.
  messagesSince.mockResolvedValue([])
  setSetting.mockResolvedValue(undefined)
  getSetting.mockImplementation(async (key: string) => {
    if (key !== 'memory_sweep_day') return null
    const melbourneDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date())
    return melbourneDay
  })
})

describe('POST /api/tick authorisation', () => {
  it('rejects an unsigned request when nothing is configured', async () => {
    expect((await tick()).status).toBe(401)
    expect(dueAutomations).not.toHaveBeenCalled()
  })

  it('accepts a valid QStash signature', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockResolvedValue(true)
    expect((await tick({ 'upstash-signature': 'v1=abc' })).status).toBe(200)
    expect(dueAutomations).toHaveBeenCalled()
  })

  it('rejects an invalid QStash signature', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockResolvedValue(false)
    expect((await tick({ 'upstash-signature': 'v1=bad' })).status).toBe(401)
    expect(dueAutomations).not.toHaveBeenCalled()
  })

  it('rejects when signature verification throws', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockRejectedValue(new Error('malformed signature'))
    expect((await tick({ 'upstash-signature': 'garbage' })).status).toBe(401)
  })

  it('accepts the manual admin secret when QStash is not configured', async () => {
    process.env.TICK_SECRET = 'let-me-in'
    expect((await tick({ 'x-tick-secret': 'let-me-in' })).status).toBe(200)
    expect((await tick({ 'x-tick-secret': 'nope' })).status).toBe(401)
  })
})

describe('running due automations', () => {
  beforeEach(() => {
    process.env.TICK_SECRET = 'let-me-in'
  })
  const authed = () => tick({ 'x-tick-secret': 'let-me-in' })

  it('claims, runs, and posts the result', async () => {
    dueAutomations.mockResolvedValue([automation()])
    const res = await authed()
    await expect(res.json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
  })

  it('schedules the following run strictly in the future', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    const [, expected, next] = claimAutomation.mock.calls[0]
    expect(expected).toEqual(new Date('2026-09-07T09:00:00Z'))
    expect(next!.getTime()).toBeGreaterThan(Date.now())
  })

  it('skips an automation another tick already claimed', async () => {
    dueAutomations.mockResolvedValue([automation()])
    claimAutomation.mockResolvedValue(false)
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 1 })
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('reports a failing automation to an admin DM, never the chat, and keeps going', async () => {
    dueAutomations.mockResolvedValue([automation({ id: 1 }), automation({ id: 2 })])
    runAgent.mockRejectedValueOnce(new Error('model exploded'))
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('model exploded'))
    expect(send).not.toHaveBeenCalledWith('-100999', expect.stringContaining('model exploded'))
  })

  it('routes a marked problem attached to SKIP to the admins, not the chat', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({
      text: 'PROBLEM: the Up API is returning a 401 (auth failure).\n\nSKIP',
      notices: [],
      model: 'primary:test',
    })
    await authed()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('401'))
    expect(insertValues).not.toHaveBeenCalled()
    // The DM lands in that chat's history, so the admin's reply has context.
    expect(recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '900', role: 'assistant', content: expect.stringContaining('401') }),
    )
  })

  it('leaves the admins alone when a quiet run merely explains itself', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({
      text: "Going through the batch: two parcel updates and a newsletter. Nothing to act on.\n\nSKIP",
      notices: [],
      model: 'primary:test',
    })
    await authed()
    expect(send).not.toHaveBeenCalled()
    expect(recordMessage).not.toHaveBeenCalled()
  })

  it('still tells the admins when the model marks a problem in the middle of its prose', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({
      text: 'Checked the feed.\n**PROBLEM**: PocketSmith returned 502.\nSKIP',
      notices: [],
      model: 'primary:test',
    })
    await authed()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('502'))
    // Only the marked line travels; the narration stays in the logs.
    expect(send).not.toHaveBeenCalledWith('900', expect.stringContaining('Checked the feed'))
  })

  it('tells the agent that a quiet run needs no explanation, and how to flag a real one', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    const prompt = (runAgent.mock.calls[0][0] as { text: string }).text
    expect(prompt).toContain('a quiet run needs no explanation')
    expect(prompt).toContain('write PROBLEM:')
    expect(prompt).toContain('no handover line')
  })

  it('offers the agent a way to stay silent, alongside the instruction', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    const prompt = (runAgent.mock.calls[0][0] as { text: string }).text
    expect(prompt).toContain('Remind everyone to put the bins out.')
    expect(prompt).toContain('reply with exactly SKIP')
  })

  it('posts nothing when the agent replies SKIP, but still counts the run', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: 'SKIP', notices: [], model: 'primary:test' })
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(send).not.toHaveBeenCalled()
    expect(insertValues).not.toHaveBeenCalled()
  })

  it('tolerates the agent punctuating its silence', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: 'Skip.', notices: [], model: 'primary:test' })
    await authed()
    expect(send).not.toHaveBeenCalled()
  })

  it('still posts tool notices when the reply itself is SKIP', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: 'SKIP', notices: ['Added to the family calendar: **Sports day**'], model: 'primary:test' })
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', 'Added to the family calendar: **Sports day**')
  })

  it('does not eat a real reply that merely mentions skipping', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: 'Two new transactions. You can skip the receipt check.', notices: [], model: 'primary:test' })
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', 'Two new transactions. You can skip the receipt check.')
  })

  it('keeps ticking when even the failure notice cannot be sent', async () => {
    dueAutomations.mockResolvedValue([automation({ id: 1 }), automation({ id: 2 })])
    runAgent.mockRejectedValueOnce(new Error('model exploded'))
    send.mockRejectedValueOnce(new Error('telegram down'))
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
  })

  it('re-reads yesterday for memories once a day, silently', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T18:30:00Z')) // 4:30am in Melbourne
    try {
      getSetting.mockImplementation(async () => null)
      messagesSince.mockResolvedValue([
        { chatId: '-100999', authorName: 'Logan', role: 'user', content: 'Bin night is Monday by the way' },
      ] as never)
      await authed()
      expect(setSetting).toHaveBeenCalledWith('memory_sweep_day', expect.any(String))
      const call = runAgent.mock.calls.at(-1)![0] as { text: string; mode: string }
      expect(call.text).toContain('Nightly memory pass')
      expect(call.text).toContain('Bin night is Monday')
      expect(call.mode).toBe('sweep')
      expect(send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the household sleep: no pass before 3am', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T15:30:00Z')) // 1:30am in Melbourne
    try {
      getSetting.mockImplementation(async () => null)
      await authed()
      expect(runAgent).not.toHaveBeenCalled()
      expect(setSetting).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not repeat the pass every five minutes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T18:30:00Z'))
    try {
      getSetting.mockImplementation(async (key: string) => (key === 'memory_sweep_day' ? '2026-08-31' : null)) // already done for this local day
      messagesSince.mockResolvedValue([{ chatId: 'x', authorName: 'L', role: 'user', content: 'hi' }] as never)
      await authed()
      expect(runAgent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts a GET, since Vercel Cron sends one', async () => {
    dueAutomations.mockResolvedValue([])
    const res = await GET(new Request('https://hearth.test/api/tick', { headers: { 'x-tick-secret': 'let-me-in' } }))
    await expect(res.json()).resolves.toEqual({ ok: true, ran: 0, skipped: 0 })
  })

  it('stays quiet when the agent produces nothing', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: '', notices: [], model: 'primary:test' })
    await authed()
    expect(send).not.toHaveBeenCalled()
  })

  it('runs scheduled automations without conversation history', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ history: false }))
  })
})

describe('the post decision', () => {
  beforeEach(() => {
    process.env.TICK_SECRET = 'let-me-in'
    dueAutomations.mockResolvedValue([automation()])
  })
  const authed = () => tick({ 'x-tick-secret': 'let-me-in' })

  it('checks the draft against the instruction and the tool results', async () => {
    runAgent.mockResolvedValue({ text: 'Bins out tonight.', notices: [], model: 'primary:test', evidence: 'recall({}) -> {"memories":[]}' })
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'bin night',
        draft: 'Bins out tonight.',
        evidence: expect.stringContaining('Remind everyone to put the bins out.'),
      }),
    )
    expect((decideWatcherPost.mock.calls[0][0] as { evidence: string }).evidence).toContain('recall({})')
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
  })

  it('holds a draft back when the decision is skip', async () => {
    decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.8, model: 'primary:test', reason: 'nothing the household needs' })
    await authed()
    expect(send).not.toHaveBeenCalled()
    expect(insertValues).not.toHaveBeenCalled()
  })

  it('holds a draft back when the decision is not confident enough', async () => {
    decideWatcherPost.mockResolvedValue({ decision: 'post', confidence: 0.4, model: 'primary:test' })
    await authed()
    expect(send).not.toHaveBeenCalled()
  })

  it('posts the rewritten message when the decision offers one', async () => {
    decideWatcherPost.mockResolvedValue({ decision: 'post', confidence: 0.95, message: 'Bins out tonight, recycling week.', model: 'primary:test' })
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight, recycling week.')
  })

  it('posts the draft unchecked and warns an admin when the decision itself fails', async () => {
    decideWatcherPost.mockRejectedValue(new Error('No object generated'))
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('post decision failed'))
  })

  it('checks the claims before deciding, and decides on what survived', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight', 'recycling week'], unsupported: ['recycling week'], message: 'Bins out tonight.' })
    runAgent.mockResolvedValue({ text: 'Bins out tonight, recycling week.', notices: [], model: 'primary:test' })
    await authed()
    expect(reviewDraft).toHaveBeenCalledWith(expect.objectContaining({ draft: 'Bins out tonight, recycling week.' }))
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ draft: 'Bins out tonight.' }))
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
  })

  it('stays silent when no claim survives the check', async () => {
    reviewDraft.mockResolvedValue({ claims: ['a trip to Seattle'], unsupported: ['a trip to Seattle'], message: null })
    await authed()
    expect(decideWatcherPost).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('falls back to deciding on the raw draft when the check itself fails', async () => {
    reviewDraft.mockRejectedValue(new Error('No object generated'))
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ draft: 'Bins out tonight.' }))
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
  })

  it('never puts a tool notice through the decision', async () => {
    runAgent.mockResolvedValue({ text: 'SKIP', notices: ['Added to the family calendar: **Sports day**'], model: 'primary:test' })
    await authed()
    expect(decideWatcherPost).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('-100999', 'Added to the family calendar: **Sports day**')
  })

  it('gives a custom automation the watcher prompt with read-only tools', async () => {
    await authed()
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ mode: 'watcher', history: false }))
    expect((runAgent.mock.calls[0][0] as { tools?: unknown }).tools).toBeUndefined()
  })
})

describe('ready-made watchers', () => {
  beforeEach(() => {
    process.env.TICK_SECRET = 'let-me-in'
  })
  const authed = () => tick({ 'x-tick-secret': 'let-me-in' })
  const money = (over: Partial<Automation> = {}) => automation({ kind: 'money', label: '2Up transactions', ...over })

  it('skips a money check in code when nothing is new, with no model call', async () => {
    dueAutomations.mockResolvedValue([money()])
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(newTransactions).toHaveBeenCalledWith(expect.objectContaining({ account: '2up' }), expect.anything())
    expect(runAgent).not.toHaveBeenCalled()
    expect(decideWatcherPost).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('hands new transactions to the model as data, with only the context tools, then posts once approved', async () => {
    dueAutomations.mockResolvedValue([money()])
    newTransactions.mockResolvedValue({
      account: '2Up', count: 1,
      transactions: [{ description: 'CHEAPTICKETS SEATTLE', amount: '$412.30', when: 'Tue 26 Aug 2026, 14:02', status: 'SETTLED', by: 'Logan' }],
    })
    runAgent.mockResolvedValue({ text: '2Up: **$412.30** CHEAPTICKETS SEATTLE, Tue 26 Aug. Purpose not recorded.', notices: [], model: 'primary:test' })
    await authed()
    const call = runAgent.mock.calls[0][0] as { mode: string; tools: string[]; text: string; chatType: string }
    expect(call.mode).toBe('watcher')
    expect(call.tools).toEqual(['recall', 'list_family_events', 'list_email'])
    expect(call.chatType).toBe('group')
    expect(call.text).toContain('CHEAPTICKETS SEATTLE')
    expect(call.text).toContain('purpose not recorded')
    expect(call.text).not.toContain('likely is')
    const decision = decideWatcherPost.mock.calls[0][0] as { evidence: string }
    expect(decision.evidence).toContain('$412.30')
    expect(send).toHaveBeenCalledWith('-100999', '2Up: **$412.30** CHEAPTICKETS SEATTLE, Tue 26 Aug. Purpose not recorded.')
  })

  it('tells an admin when the money fetch errors, and leaves the chat alone', async () => {
    dueAutomations.mockResolvedValue([money()])
    newTransactions.mockResolvedValue({ error: 'Up Bank is not configured.' })
    await authed()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('Up Bank is not configured'))
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('sweeps every mailbox from a group and only the owner\'s from a DM', async () => {
    dueAutomations.mockResolvedValue([
      automation({ id: 1, kind: 'inbox', label: 'Family inbox sweep', chatId: '-100999' }),
      automation({ id: 2, kind: 'inbox', label: "Logan's inbox", chatId: '111' }),
    ])
    await authed()
    expect(newMail).toHaveBeenNthCalledWith(1, expect.objectContaining({ everyone: true }), expect.anything())
    expect(newMail).toHaveBeenNthCalledWith(2, expect.objectContaining({ everyone: false }), expect.anything())
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('phrases new mail with the mail tools and asks whose mailbox it came from in a group', async () => {
    dueAutomations.mockResolvedValue([automation({ kind: 'inbox', label: 'Family inbox sweep' })])
    newMail.mockResolvedValue({
      accounts: [{ member: 'Yuna', provider: 'microsoft', first_check: false, messages: [{ id: 'm1', from: 'school', subject: 'Sports day', snippet: 'Wed 10 Sep', date: '2026-09-01' }] }],
    })
    runAgent.mockResolvedValue({ text: 'Yuna: school says sports day is Wed 10 Sep.', notices: [], model: 'primary:test' })
    await authed()
    const call = runAgent.mock.calls[0][0] as { tools: string[]; text: string }
    expect(call.tools).toEqual(['read_email', 'propose_family_event', 'list_family_events', 'recall'])
    expect(call.text).toContain('whose mailbox')
    expect(call.text).toContain('Sports day')
    expect(send).toHaveBeenCalledWith('-100999', 'Yuna: school says sports day is Wed 10 Sep.')
  })

  it('reports a broken mailbox to an admin but still phrases the rest', async () => {
    dueAutomations.mockResolvedValue([automation({ kind: 'inbox', label: 'Family inbox sweep' })])
    newMail.mockResolvedValue({
      accounts: [
        { member: 'Yuna', provider: 'microsoft', error: 'token revoked' },
        { member: 'Logan', provider: 'google', first_check: false, messages: [{ id: 'm2', from: 'clinic', subject: 'Appointment', snippet: 'Fri', date: '2026-09-01' }] },
      ],
    })
    await authed()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('token revoked'))
    expect(runAgent).toHaveBeenCalled()
  })

  it('skips the morning brief when nothing is on and nothing is due, and treats missing integrations as settings', async () => {
    dueAutomations.mockResolvedValue([automation({ kind: 'morning', label: 'Morning brief' })])
    await authed()
    expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ include_cancelled: false }), expect.anything())
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('briefs the day when something is on, with weather included only when it worked', async () => {
    dueAutomations.mockResolvedValue([automation({ kind: 'morning', label: 'Morning brief' })])
    listEvents.mockResolvedValue({ events: [{ id: 1, title: 'Swimming', start_local: 'Wed 3 Sep 2026, 09:00' }] })
    weatherTool.mockResolvedValue({ place: 'Melbourne', now: { summary: 'Rain' } })
    runAgent.mockResolvedValue({ text: 'Swimming at 9am; take an umbrella, rain is forecast.', notices: [], model: 'primary:test' })
    await authed()
    const call = runAgent.mock.calls[0][0] as { text: string; tools: string[] }
    expect(call.text).toContain('Swimming')
    expect(call.text).toContain('Rain')
    expect(call.text).not.toContain('not configured')
    expect(call.tools).toEqual(['recall'])
    expect(send).toHaveBeenCalledWith('-100999', 'Swimming at 9am; take an umbrella, rain is forecast.')
  })

  it('briefs on an overdue board item even with an empty calendar', async () => {
    dueAutomations.mockResolvedValue([automation({ kind: 'morning', label: 'Morning brief' })])
    boardSummary.mockResolvedValue({ project: 'HTL', open: 3, overdue: [{ key: 'HTL-344', summary: 'Pay rates' }] })
    await authed()
    expect(runAgent).toHaveBeenCalled()
    expect((runAgent.mock.calls[0][0] as { text: string }).text).toContain('HTL-344')
  })
})

describe('the proactive post cap', () => {
  beforeEach(() => {
    process.env.TICK_SECRET = 'let-me-in'
    dueAutomations.mockResolvedValue([automation()])
  })
  const authed = () => tick({ 'x-tick-secret': 'let-me-in' })
  const recent = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (i + 1) * 60_000).toISOString())

  it('records each post it makes', async () => {
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
    const [key, value] = setSetting.mock.calls.find(([k]) => String(k).startsWith('proactive_posts:'))!
    expect(key).toBe('proactive_posts:-100999')
    expect(JSON.parse(String(value)).posts).toHaveLength(1)
  })

  it('holds a post back once the chat has heard enough this hour, and tells an admin once', async () => {
    getSetting.mockImplementation(async (key: string) => (key === 'proactive_posts:-100999' ? JSON.stringify({ posts: recent(6) }) : null))
    await authed()
    expect(send).not.toHaveBeenCalledWith('-100999', expect.anything())
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('held back'))
    expect(insertValues).not.toHaveBeenCalled()
    // Already warned this hour: quiet.
    send.mockClear()
    getSetting.mockImplementation(async (key: string) =>
      key === 'proactive_posts:-100999' ? JSON.stringify({ posts: recent(6), cappedAt: new Date().toISOString() }) : null,
    )
    await authed()
    expect(send).not.toHaveBeenCalled()
  })

  it('lets old posts age out of the window', async () => {
    const stale = Array.from({ length: 6 }, (_, i) => new Date(Date.now() - (61 + i) * 60_000).toISOString())
    getSetting.mockImplementation(async (key: string) => (key === 'proactive_posts:-100999' ? JSON.stringify({ posts: stale }) : null))
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
  })
})
