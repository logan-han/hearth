import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Automation } from '@/lib/db/schema'

const dueAutomations = vi.fn<(now: Date) => Promise<Automation[]>>()
const claimAutomation = vi.fn<(id: number, expected: Date, next: Date | null) => Promise<boolean>>()
const runAgent = vi.fn()
const send = vi.fn<(chatId: string, text: string) => Promise<void>>()
const verify = vi.fn<() => Promise<boolean>>()
const insertValues = vi.fn()

const { recordMessage, messagesSince, getSetting, setSetting } = vi.hoisted(() => ({
  recordMessage: vi.fn(async () => 1),
  messagesSince: vi.fn(async () => [] as unknown[]),
  getSetting: vi.fn(async () => null as string | null),
  setSetting: vi.fn(async () => {}),
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
vi.mock('@/lib/agent', () => ({ runAgent }))
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
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const k of ['QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'TICK_SECRET']) {
    delete process.env[k]
  }
  send.mockResolvedValue(undefined)
  dueAutomations.mockResolvedValue([])
  claimAutomation.mockResolvedValue(true)
  runAgent.mockResolvedValue({ text: 'Bins out tonight.', notices: [], model: 'primary:test' })
  // The nightly memory pass reports done-for-today by default, so ordinary
  // tests never depend on what the wall clock says.
  messagesSince.mockResolvedValue([])
  setSetting.mockResolvedValue(undefined)
  getSetting.mockImplementation(async () => {
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

  it('routes a diagnosis attached to SKIP to the admins, not the chat', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({
      text: 'The Up API is returning a 401 (auth failure).\n\nSKIP',
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
      getSetting.mockResolvedValue(null)
      messagesSince.mockResolvedValue([
        { chatId: '-100999', authorName: 'Logan', role: 'user', content: 'Bin night is Monday by the way' },
      ] as never)
      await authed()
      expect(setSetting).toHaveBeenCalledWith('memory_sweep_day', expect.any(String))
      const prompt = (runAgent.mock.calls.at(-1)![0] as { text: string }).text
      expect(prompt).toContain('Nightly memory pass')
      expect(prompt).toContain('Bin night is Monday')
      expect(send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets the household sleep: no pass before 3am', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T15:30:00Z')) // 1:30am in Melbourne
    try {
      getSetting.mockResolvedValue(null)
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
      getSetting.mockResolvedValue('2026-08-31') // already done for this local day
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
