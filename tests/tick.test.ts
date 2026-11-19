import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Automation, Member } from '@/lib/db/schema'

const dueAutomations = vi.fn<(now: Date) => Promise<Automation[]>>()
const claimAutomation = vi.fn<(id: number, expected: Date, next: Date | null) => Promise<boolean>>()
const runAgent = vi.fn()
const looksBefore = vi.fn((_err?: unknown) => [] as unknown[])
const decideWatcherPost = vi.fn()
const reviewDraft = vi.fn()
const cutFromDraft = vi.fn()
const verify = vi.fn<() => Promise<boolean>>()
const receivers: { currentSigningKey: string; nextSigningKey: string }[] = []

const q = vi.hoisted(() => ({
  setAutomationEnabled: vi.fn(async (_id: number, _enabled: boolean) => ({})),
  deleteAutomation: vi.fn(async (_id: number) => true),
  pruneActivity: vi.fn(async (_days?: number) => 0),
  pruneReports: vi.fn(async (_days?: number) => 0),
  getHelper: vi.fn(async (_id: number) => undefined as unknown),
  memberById: vi.fn(async (_id: number) => undefined as unknown),
  addReport: vi.fn(async (_input: Record<string, unknown>) => ({})),
  getSetting: vi.fn<(key: string) => Promise<string | null>>(async () => null),
  setSetting: vi.fn<(key: string, value: string) => Promise<void>>(async () => {}),
  recordTick: vi.fn<(now: Date) => Promise<void>>(async () => {}),
  retireStaleProposals: vi.fn(async (_now: Date) => ({ expired: 0, superseded: 0 })),
}))
vi.mock('@/lib/db/queries', () => ({ dueAutomations, claimAutomation, ...q }))

// The environment is the whole configuration here; a second look at the
// store finds nothing new unless a test says otherwise.
const { hydrateSecrets, recheckSecrets } = vi.hoisted(() => ({
  hydrateSecrets: vi.fn(async () => {}),
  recheckSecrets: vi.fn(async () => true),
}))
vi.mock('@/lib/settings', () => ({ hydrateSecrets, recheckSecrets }))

const { pruneModelEvents, pruneUsedCodes } = vi.hoisted(() => ({
  pruneModelEvents: vi.fn(async (_days?: number) => {}),
  pruneUsedCodes: vi.fn(async () => {}),
}))
vi.mock('@/lib/model-events', () => ({ pruneModelEvents }))
vi.mock('@/lib/oauth/server', () => ({ pruneUsedCodes }))

vi.mock('@/lib/agent', async (orig) => {
  const actual = await orig<typeof import('@/lib/agent')>()
  return {
    runAgent, decideWatcherPost, reviewDraft, cutFromDraft, looksBefore,
    scheduledInstruction: actual.scheduledInstruction,
    TURN_BUDGET_MS: actual.TURN_BUDGET_MS,
  }
})
vi.mock('@upstash/qstash', () => ({
  Receiver: class {
    constructor(opts: { currentSigningKey: string; nextSigningKey: string }) {
      receivers.push(opts)
    }
    verify = verify
  },
}))
// Each run is a trace of its own in Langfuse, and what it notes there is what
// a held-back report is diagnosed from once the logs have gone.
const { traceRun, noteRun, traced } = vi.hoisted(() => ({
  traceRun: vi.fn(async (_name: string, _attrs: unknown, fn: () => Promise<unknown>) => fn()),
  noteRun: vi.fn(),
  traced: vi.fn(async (_attrs: unknown, fn: () => Promise<unknown>) => fn()),
}))
vi.mock('@/lib/telemetry', async (orig) => ({ ...(await orig<typeof import('@/lib/telemetry')>()), traceRun, noteRun, traced }))

const { POST, GET } = await import('@/app/api/tick/route')
const { APICallError, RetryError } = await import('ai')

const ROWAN: Member = { id: 9, name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false, createdAt: new Date('2026-08-01T00:00:00Z') }

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: 1,
    memberId: 9,
    label: 'bin night',
    cronExpr: '0 19 * * 1',
    instruction: 'Remind everyone to put the bins out.',
    nextRunAt: new Date('2026-09-07T09:00:00Z'),
    lastRunAt: null,
    enabled: true,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    repeat: 'always',
    helperId: null,
    ...over,
  } as Automation
}

function tick(headers: Record<string, string> = {}) {
  return POST(new Request('https://hearth.test/api/tick', { method: 'POST', headers, body: '' }))
}
const authed = () => tick({ 'x-tick-secret': 'let-me-in' })

/** What the runs kept for their members, in order. */
const reports = () => q.addReport.mock.calls.map(([r]) => r as Record<string, unknown>)

/** Every note the runs made, merged in order, the way Langfuse merges updates to one observation. */
const noted = () =>
  noteRun.mock.calls.reduce<Record<string, unknown>>((all, [n]) => ({ ...all, ...n, metadata: { ...(all.metadata as object), ...n.metadata } }), {})

beforeEach(() => {
  vi.clearAllMocks()
  receivers.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const k of ['QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'TICK_SECRET']) delete process.env[k]
  looksBefore.mockImplementation(() => [])
  dueAutomations.mockResolvedValue([])
  claimAutomation.mockResolvedValue(true)
  runAgent.mockResolvedValue({ text: 'Bins out tonight.', model: 'primary:test' })
  decideWatcherPost.mockResolvedValue({ decision: 'post', confidence: 0.9, model: 'primary:test' })
  reviewDraft.mockImplementation(async ({ draft }: { draft: string }) => ({ claims: [], unsupported: [], message: draft }))
  cutFromDraft.mockResolvedValue(null)
  q.memberById.mockResolvedValue(ROWAN)
  q.getHelper.mockResolvedValue(undefined)
  q.addReport.mockResolvedValue({})
  q.getSetting.mockResolvedValue(null)
  q.setSetting.mockResolvedValue(undefined)
  q.deleteAutomation.mockResolvedValue(true)
  q.retireStaleProposals.mockResolvedValue({ expired: 0, superseded: 0 })
})

describe('POST /api/tick authorisation', () => {
  it('rejects an unsigned request when nothing is configured', async () => {
    expect((await tick()).status).toBe(401)
    expect(dueAutomations).not.toHaveBeenCalled()
  })

  it('accepts a valid QStash signature, checked with the next key too once there is one', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockResolvedValue(true)
    expect((await tick({ 'upstash-signature': 'v1=abc' })).status).toBe(200)
    expect(dueAutomations).toHaveBeenCalled()
    expect(receivers.at(-1)).toEqual({ currentSigningKey: 'sig_current', nextSigningKey: 'sig_current' })
    process.env.QSTASH_NEXT_SIGNING_KEY = 'sig_next'
    await tick({ 'upstash-signature': 'v1=abc' })
    expect(receivers.at(-1)).toEqual({ currentSigningKey: 'sig_current', nextSigningKey: 'sig_next' })
  })

  it('records every tick it accepts, so a quiet scheduler shows on the System page', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockResolvedValue(true)
    await tick({ 'upstash-signature': 'v1=abc' })
    expect(q.recordTick).toHaveBeenCalled()
    const [at] = q.recordTick.mock.calls.at(-1) ?? []
    expect(at?.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(q.retireStaleProposals).toHaveBeenCalled()
  })

  it('logs when recording the tick itself fails, without failing the request', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockResolvedValue(true)
    q.recordTick.mockRejectedValueOnce(new Error('db unreachable'))
    const res = await tick({ 'upstash-signature': 'v1=abc' })
    expect(res.status).toBe(200)
    expect(console.error).toHaveBeenCalledWith('[tick] could not record the tick:', expect.any(Error))
  })

  /** Hourly stamps, the last one `ago` before now. */
  function stamped(ago: number) {
    const last = Date.now() - ago
    q.getSetting.mockImplementation(async (key: string) => {
      if (key === 'last_tick_at') return new Date(last).toISOString()
      if (key === 'prev_tick_at') return new Date(last - 3_600_000).toISOString()
      return null
    })
    return last
  }

  it('records nothing for a QStash retry of a tick already on record, and still runs it', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockResolvedValue(true)
    stamped(12_000)
    expect((await tick({ 'upstash-signature': 'v1=abc', 'upstash-retried': '1' })).status).toBe(200)
    expect(q.recordTick).not.toHaveBeenCalled()
    expect(dueAutomations).toHaveBeenCalled()
    // The first attempt says it is one, and is the pulse.
    await tick({ 'upstash-signature': 'v1=abc', 'upstash-retried': '0' })
    expect(q.recordTick).toHaveBeenCalledTimes(1)
  })

  it('records a retry whose first try left no stamp, at the time that tick was due', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockResolvedValue(true)
    // The last stamp is an hour and twelve seconds old: the tick due twelve
    // seconds ago failed before it was recorded, and this is its retry.
    const last = stamped(3_612_000)
    await tick({ 'upstash-signature': 'v1=abc', 'upstash-retried': '1' })
    expect(q.recordTick).toHaveBeenCalledTimes(1)
    expect(q.recordTick.mock.calls[0][0].getTime()).toBe(last + 3_600_000)
  })

  it('records nothing for a tick it refuses', async () => {
    expect((await tick()).status).toBe(401)
    expect(q.recordTick).not.toHaveBeenCalled()
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
    expect(console.warn).toHaveBeenCalledWith('[tick] signature verification failed:', expect.any(Error))
  })

  it('accepts the manual admin secret when QStash is not configured', async () => {
    process.env.TICK_SECRET = 'let-me-in'
    expect((await tick({ 'x-tick-secret': 'let-me-in' })).status).toBe(200)
    expect((await tick({ 'x-tick-secret': 'nope' })).status).toBe(401)
    // A manual poke is not the scheduler's pulse.
    expect(q.recordTick).not.toHaveBeenCalled()
  })

  it('checks the keys it holds before reading the store, and reads it fresh only once they pass', async () => {
    process.env.TICK_SECRET = 'let-me-in'
    expect((await tick({ 'x-tick-secret': 'let-me-in' })).status).toBe(200)
    expect(hydrateSecrets).toHaveBeenCalledTimes(1)
    expect(recheckSecrets).not.toHaveBeenCalled()
  })

  it('turns a stranger away without touching the database once it has looked this hour', async () => {
    process.env.TICK_SECRET = 'let-me-in'
    recheckSecrets.mockResolvedValueOnce(false)
    expect((await tick({ 'x-tick-secret': 'guess' })).status).toBe(401)
    expect(hydrateSecrets).not.toHaveBeenCalled()
    expect(dueAutomations).not.toHaveBeenCalled()
  })

  it('takes a key changed on another instance once a second look finds it', async () => {
    process.env.TICK_SECRET = 'before-the-change'
    recheckSecrets.mockImplementationOnce(async () => {
      process.env.TICK_SECRET = 'let-me-in'
      return true
    })
    expect((await tick({ 'x-tick-secret': 'let-me-in' })).status).toBe(200)
    expect(dueAutomations).toHaveBeenCalled()
  })

  it('refuses the key it held once the store says it has changed', async () => {
    process.env.TICK_SECRET = 'let-me-in'
    hydrateSecrets.mockImplementationOnce(async () => {
      process.env.TICK_SECRET = 'rotated'
    })
    expect((await tick({ 'x-tick-secret': 'let-me-in' })).status).toBe(401)
    expect(dueAutomations).not.toHaveBeenCalled()
  })

  it('accepts a GET, since Vercel Cron sends one', async () => {
    process.env.TICK_SECRET = 'let-me-in'
    const res = await GET(new Request('https://hearth.test/api/tick', { headers: { 'x-tick-secret': 'let-me-in' } }))
    await expect(res.json()).resolves.toEqual({ ok: true, ran: 0, skipped: 0 })
  })
})

describe('running due automations', () => {
  beforeEach(() => {
    process.env.TICK_SECRET = 'let-me-in'
  })

  it('claims, runs, and keeps what it found as a report for whoever set it up', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(reports()).toEqual([{ memberId: 9, automationId: 1, label: 'bin night', helper: null, status: 'ready', body: 'Bins out tonight.', detail: null }])
  })

  it('claims as of now, and schedules the following run strictly in the future', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    const [, asOf, next] = claimAutomation.mock.calls[0]
    expect(asOf.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(asOf.getTime()).toBeLessThanOrEqual(Date.now())
    expect(next!.getTime()).toBeGreaterThan(Date.now())
  })

  it('starts no run without room for a whole turn and its checks, leaving the rest unclaimed for the next tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      dueAutomations.mockResolvedValue([automation({ id: 1 }), automation({ id: 2 }), automation({ id: 3 })])
      // A minute in, a turn and its checks still fit before the tick's own
      // deadline; eleven seconds later they would not.
      const slow = (ms: number) => async () => {
        vi.setSystemTime(Date.now() + ms)
        return { text: 'Bins out tonight.', model: 'primary:test' }
      }
      runAgent.mockImplementationOnce(slow(60_000)).mockImplementationOnce(slow(11_000))
      await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 2, skipped: 0 })
      expect(claimAutomation).toHaveBeenCalledTimes(2)
      expect(console.warn).toHaveBeenCalledWith('[tick] out of time: 1 due automation(s) left for the next tick')
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds every run to the tick, leaving its checks the end of it and the decision the very end', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now()
      dueAutomations.mockResolvedValue([automation({ id: 1 }), automation({ id: 2 })])
      await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 2, skipped: 0 })
      expect(runAgent.mock.calls.map(([input]) => input.deadline)).toEqual([start + 220_000, start + 220_000])
      expect(reviewDraft.mock.calls.map(([input]) => input.deadline)).toEqual([start + 250_000, start + 250_000])
      expect(decideWatcherPost.mock.calls.map(([input]) => input.deadline)).toEqual([start + 280_000, start + 280_000])
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips an automation another tick already claimed', async () => {
    dueAutomations.mockResolvedValue([automation()])
    claimAutomation.mockResolvedValue(false)
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 1 })
    expect(runAgent).not.toHaveBeenCalled()
    expect(q.addReport).not.toHaveBeenCalled()
  })

  it("runs the author's own words as the author, on markers of its own, with the read-only tools a run gets", async () => {
    dueAutomations.mockResolvedValue([automation({ id: 12 })])
    await authed()
    expect(q.memberById).toHaveBeenCalledWith(9)
    const input = runAgent.mock.calls[0][0] as Record<string, unknown>
    expect(input).toMatchObject({ member: ROWAN, memberName: 'Rowan', cursorScope: 'auto:12' })
    expect(input.helper).toBeUndefined()
    // The default list, which is what a scheduled run may reach for.
    expect(input.tools).toBeUndefined()
  })

  it('tells the run what becomes of what it writes, how to stay quiet, and how to flag a real problem', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    const prompt = (runAgent.mock.calls[0][0] as { text: string }).text
    expect(prompt).toContain('Remind everyone to put the bins out.')
    expect(prompt).toContain('kept as a report for Rowan to read later')
    expect(prompt).toContain('reply with exactly SKIP')
    expect(prompt).toContain('a quiet run needs no explanation')
    expect(prompt).toContain('write PROBLEM:')
    expect(prompt).toContain('no handover line')
    expect(prompt).not.toMatch(/chat|post/i)
  })

  it('pauses rather than runs one whose author is no longer allowed, gone from the family, or never named', async () => {
    for (const [row, memberId] of [[{ ...ROWAN, allowed: false }, 9], [undefined, 9], [undefined, null]] as const) {
      vi.clearAllMocks()
      q.memberById.mockResolvedValue(row)
      dueAutomations.mockResolvedValue([automation({ memberId })])
      await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 1 })
      expect(q.setAutomationEnabled).toHaveBeenCalledWith(1, false)
      expect(runAgent).not.toHaveBeenCalled()
      expect(q.addReport).not.toHaveBeenCalled()
      expect(noted()).toMatchObject({ output: 'whoever set it up is no longer allowed, so it was paused', metadata: { outcome: 'not run' } })
    }
    // A row that names nobody is not looked up at all.
    expect(q.memberById).not.toHaveBeenCalled()
  })

  it('runs a job handed to a helper as that helper, and its report carries the helper\'s name', async () => {
    q.getHelper.mockResolvedValueOnce({ id: 3, name: 'Chef', role: 'Plans meals.' })
    dueAutomations.mockResolvedValue([automation({ id: 8, helperId: 3, repeat: 'once', label: 'Chef: plan dinners' })])
    runAgent.mockResolvedValue({ text: 'Five dinners: soup, pasta, tacos, curry, roast.', model: 'primary:test' })
    await authed()
    expect(q.getHelper).toHaveBeenCalledWith(3)
    expect((runAgent.mock.calls[0][0] as { helper?: { name: string } }).helper?.name).toBe('Chef')
    expect(noteRun).toHaveBeenCalledWith({ input: 'INSTRUCTION:\nRemind everyone to put the bins out.', metadata: { helper: 'Chef' } })
    // The checks judge what it wrote, unsigned; the name goes on the report.
    expect(decideWatcherPost.mock.calls[0][0].draft).toBe('Five dinners: soup, pasta, tacos, curry, roast.')
    expect(reports()[0]).toMatchObject({ label: 'Chef: plan dinners', helper: 'Chef', status: 'ready', body: 'Five dinners: soup, pasta, tacos, curry, roast.' })
  })

  it('runs a job as Hearth itself when its helper has gone, or cannot be looked up', async () => {
    dueAutomations.mockResolvedValue([automation({ id: 8, helperId: 3 })])
    q.getHelper.mockRejectedValueOnce(new Error('db away'))
    await authed()
    expect((runAgent.mock.calls[0][0] as { helper?: unknown }).helper).toBeUndefined()
    expect(reports()[0]).toMatchObject({ helper: null, body: 'Bins out tonight.' })
  })

  it('keeps a marked problem attached to SKIP as a problem report, the narration left in the logs', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: 'Checked the feed.\n**PROBLEM**: PocketSmith returned 502.\nSKIP', model: 'primary:test' })
    await authed()
    expect(reports()).toEqual([expect.objectContaining({ status: 'problem', body: '**PROBLEM**: PocketSmith returned 502.', detail: null })])
    expect(decideWatcherPost).not.toHaveBeenCalled()
    expect(noteRun).toHaveBeenCalledWith({ output: 'Checked the feed.\n**PROBLEM**: PocketSmith returned 502.', metadata: { outcome: 'problem' }, level: 'WARNING' })
  })

  it('keeps nothing when a quiet run merely explains itself, and says so only in the logs', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: 'Going through the batch: two parcel updates and a newsletter. Nothing to act on.\n\nSKIP', model: 'primary:test' })
    await authed()
    expect(q.addReport).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('[tick] bin night stayed quiet:', expect.stringContaining('two parcel updates'))
  })

  it('keeps nothing on a plain SKIP, punctuated or not, or an empty reply, and still counts the run', async () => {
    for (const text of ['SKIP', 'Skip.', '']) {
      vi.clearAllMocks()
      dueAutomations.mockResolvedValue([automation()])
      runAgent.mockResolvedValue({ text, model: 'primary:test' })
      await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
      expect(q.addReport).not.toHaveBeenCalled()
      expect(decideWatcherPost).not.toHaveBeenCalled()
      expect(noteRun).toHaveBeenCalledWith({ output: text, metadata: { outcome: 'skipped' } })
    }
  })

  it('does not eat a real report that merely mentions skipping', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: 'Two new transactions. You can skip the receipt check.', model: 'primary:test' })
    await authed()
    expect(reports()[0]).toMatchObject({ status: 'ready', body: 'Two new transactions. You can skip the receipt check.' })
  })

  it('reports a failing automation to its member and keeps going', async () => {
    dueAutomations.mockResolvedValue([automation({ id: 1 }), automation({ id: 2 })])
    runAgent.mockRejectedValueOnce(new Error('model exploded'))
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(reports()[0]).toEqual({ memberId: 9, automationId: 1, label: 'bin night', helper: null, status: 'problem', body: 'It failed: model exploded', detail: null })
    expect(reports()[1]).toMatchObject({ automationId: 2, status: 'ready' })
    expect(console.error).toHaveBeenCalledWith('[tick] automation 1 failed:', expect.any(Error))
  })

  it('logs a report it cannot keep, with what it said, and still counts the run', async () => {
    dueAutomations.mockResolvedValue([automation()])
    q.addReport.mockRejectedValueOnce(new Error('db away'))
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(console.error).toHaveBeenCalledWith('[tick] could not keep a report for bin night:', 'db away', 'Bins out tonight.')
  })

  it('keeps ninety days of activity, thirty of reports, and no used OAuth code past its expiry, carrying on when any cannot be pruned', async () => {
    await authed()
    expect(pruneModelEvents).toHaveBeenCalledWith(30)
    expect(q.pruneActivity).toHaveBeenCalledWith(90)
    expect(q.pruneReports).toHaveBeenCalledWith(30)
    expect(pruneUsedCodes).toHaveBeenCalled()
    q.pruneActivity.mockRejectedValueOnce(new Error('db away'))
    q.pruneReports.mockRejectedValueOnce(new Error('db gone'))
    pruneUsedCodes.mockRejectedValueOnce(new Error('db lost'))
    expect((await authed()).status).toBe(200)
    expect(console.error).toHaveBeenCalledWith('[tick] could not prune the activity log:', 'db away')
    expect(console.error).toHaveBeenCalledWith('[tick] could not prune the reports:', 'db gone')
    expect(console.error).toHaveBeenCalledWith('[tick] could not prune used OAuth codes:', 'db lost')
  })

  it('logs retired proposals when there were any, and a failure to retire them without failing the tick', async () => {
    q.retireStaleProposals.mockResolvedValueOnce({ expired: 2, superseded: 1 })
    await authed()
    expect(console.info).toHaveBeenCalledWith('[tick] proposals retired: 2 expired, 1 already on the calendar')
    q.retireStaleProposals.mockRejectedValueOnce(new Error('db away'))
    expect((await authed()).status).toBe(200)
    expect(console.error).toHaveBeenCalledWith('[tick] could not retire stale proposals:', expect.any(Error))
  })

  describe('what a run read', () => {
    const KEY = 'mail_cursor:auto:1:9:google'
    const staged = [{ key: KEY, at: '2026-09-24T01:00:00.000Z', ids: ['m1'], prev: null }]

    it('is spent once its report is kept, and not when the model fails', async () => {
      dueAutomations.mockResolvedValue([automation()])
      runAgent.mockResolvedValueOnce({ text: 'School: excursion form due Friday.', model: 'primary:test', cursors: staged })
      await authed()
      expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))

      q.setSetting.mockClear()
      runAgent.mockRejectedValueOnce(new Error('429 quota'))
      await authed()
      expect(q.setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
    })

    it('is spent with a PROBLEM when the run already wrote something unrepeatable on it, and left new when it did not', async () => {
      dueAutomations.mockResolvedValue([automation()])
      runAgent.mockResolvedValueOnce({ text: 'PROBLEM: read_email failed after adding to the list\nSKIP', model: 'primary:test', cursors: staged, wrote: ['add_to_list'] })
      await authed()
      expect(reports()[0]).toMatchObject({ status: 'problem', body: 'PROBLEM: read_email failed after adding to the list' })
      expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))

      vi.clearAllMocks()
      dueAutomations.mockResolvedValue([automation()])
      runAgent.mockResolvedValueOnce({ text: 'PROBLEM: read_email failed for the school message\nSKIP', model: 'primary:test', cursors: staged })
      await authed()
      expect(q.setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
      // And counted, being about what was read.
      expect(q.setSetting).toHaveBeenCalledWith('unspent:1', expect.stringContaining(KEY))
    })

    it('is spent on a plain SKIP, which is the run deciding there is nothing to say', async () => {
      dueAutomations.mockResolvedValue([automation()])
      runAgent.mockResolvedValueOnce({ text: 'SKIP', model: 'primary:test', cursors: staged })
      await authed()
      expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
    })

    it('is spent when the checks hold the draft back, since the member has the draft, marked', async () => {
      dueAutomations.mockResolvedValue([automation()])
      runAgent.mockResolvedValueOnce({ text: 'Bins out tonight.', model: 'primary:test', cursors: staged })
      decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.8, model: 'primary:test', reason: 'a time the evidence does not give' })
      await authed()
      expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
      expect(reports()[0]).toMatchObject({ status: 'held' })
    })

    it('counts a failure on what its model looked at, and moves past it in time', async () => {
      const look = staged[0]
      const since = new Date(Date.now() - 20 * 3600_000).toISOString()
      dueAutomations.mockResolvedValue([automation()])
      const failure = new Error('the attachment cannot be read')
      runAgent.mockRejectedValueOnce(failure)
      looksBefore.mockImplementation((err) => (err === failure ? [look] : []))
      q.getSetting.mockImplementation(async (key: string) =>
        key === 'unspent:1' ? JSON.stringify({ [look.key]: { from: '-', since, last: since, runs: 2, move: look } }) : null,
      )
      await authed()
      expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
      expect(reports().map((r) => r.body)).toEqual([
        expect.stringMatching(/^Failed on the same new items 3 runs running \(the attachment cannot be read\), so it has moved past them without reporting them: mail in your linked Gmail mailbox up to /),
        'It failed: the attachment cannot be read',
      ])
    })
  })

  describe('jobs that run once, or until they find something', () => {
    it('runs a one-off once: the claim switches it off and the run takes it off the list', async () => {
      dueAutomations.mockResolvedValue([automation({ id: 4, repeat: 'once', label: 'call the plumber' })])
      await authed()
      expect(claimAutomation).toHaveBeenCalledWith(4, expect.any(Date), null)
      expect(reports()[0]).toMatchObject({ automationId: 4, status: 'ready' })
      expect(q.deleteAutomation).toHaveBeenCalledWith(4)
      expect(noteRun).toHaveBeenCalledWith({ metadata: { retired: 'its one run' } })
    })

    it('takes a one-off off the list even when it never ran, rather than leaving it to run late', async () => {
      dueAutomations.mockResolvedValue([automation({ id: 4, repeat: 'once' })])
      q.memberById.mockResolvedValue({ ...ROWAN, allowed: false })
      await authed()
      expect(runAgent).not.toHaveBeenCalled()
      expect(q.deleteAutomation).toHaveBeenCalledWith(4)
    })

    it('keeps a watch-until going while it finds nothing, and leaves a schedule alone', async () => {
      dueAutomations.mockResolvedValue([automation({ id: 5, repeat: 'until' }), automation({ id: 6 })])
      runAgent.mockResolvedValue({ text: 'SKIP', model: 'primary:test' })
      await authed()
      const [, , next] = claimAutomation.mock.calls[0]
      expect(next!.getTime()).toBeGreaterThan(Date.now())
      expect(q.deleteAutomation).not.toHaveBeenCalled()
    })

    it('stops a watch-until once it reports, and says so on the report in its own words', async () => {
      dueAutomations.mockResolvedValue([automation({ id: 5, repeat: 'until', instruction: 'Report the camp dates once the school sends them.' })])
      runAgent.mockResolvedValue({ text: 'Camp is 3 to 5 March.', model: 'primary:test' })
      await authed()
      expect(reports()[0]).toMatchObject({
        status: 'ready',
        body: 'Camp is 3 to 5 March.',
        detail: "That's what it was waiting for, so it has stopped checking. Ask again if it should keep watching.",
      })
      expect(q.deleteAutomation).toHaveBeenCalledWith(5)
      expect(noteRun).toHaveBeenCalledWith({ metadata: { retired: 'it found what it was waiting for' } })
      // The writer was told a report ends it, so it reports only once the thing has happened.
      expect(runAgent.mock.calls[0][0].text).toContain('stops for good once it reports anything')
      // The line is said in code, after the checks: they judged the report alone.
      expect(decideWatcherPost.mock.calls[0][0].draft).toBe('Camp is 3 to 5 March.')
    })

    it('stops a watch-until whose find the checks held back, since what it read is spent, and says so', async () => {
      dueAutomations.mockResolvedValue([automation({ id: 5, repeat: 'until', label: 'camp dates' })])
      runAgent.mockResolvedValue({ text: 'Camp is 3 to 5 March.', model: 'primary:test' })
      decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.9, reason: 'invented', model: 'primary:test' })
      await authed()
      expect(q.deleteAutomation).toHaveBeenCalledWith(5)
      expect(reports()[0]).toMatchObject({ status: 'held', body: 'Camp is 3 to 5 March.' })
      expect(String(reports()[0].detail)).toBe(
        'Held back: the check said skip at 0.90: invented. It found something, so it has stopped watching; ask again if it should keep watching.',
      )
    })

    it('logs a finished job it could not take off the list, and carries on', async () => {
      dueAutomations.mockResolvedValue([automation({ id: 4, repeat: 'once', label: 'plumber' }), automation({ id: 7 })])
      q.deleteAutomation.mockRejectedValueOnce(new Error('db away'))
      await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 2, skipped: 0 })
      expect(console.error).toHaveBeenCalledWith('[tick] could not remove plumber after its one run:', 'db away')
    })
  })
})

describe('the checks on what a run wrote', () => {
  beforeEach(() => {
    process.env.TICK_SECRET = 'let-me-in'
    dueAutomations.mockResolvedValue([automation()])
  })

  it('checks the draft against the clock, the instruction, the facts the writer had and the tool results', async () => {
    runAgent.mockResolvedValue({
      text: 'Bins out tonight.', model: 'primary:test',
      evidence: 'recall({}) -> {"memories":[]}', facts: 'Known household facts:\n- [4] bin night is Monday',
    })
    await authed()
    const evidence = (decideWatcherPost.mock.calls[0][0] as { evidence: string }).evidence
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ label: 'bin night', draft: 'Bins out tonight.' }))
    expect(evidence).toMatch(/^NOW: .* \(Australia\/Melbourne\)\. TODAY: \d{4}-\d{2}-\d{2}\.\n\nINSTRUCTION:\nRemind everyone to put the bins out\.\n\n/)
    expect(evidence).toContain('Known household facts:\n- [4] bin night is Monday\n\nTOOL RESULTS:\nrecall({}) -> {"memories":[]}')
    expect(reviewDraft).toHaveBeenCalledWith(expect.objectContaining({ evidence }))
    expect(noteRun).toHaveBeenCalledWith({ input: evidence, metadata: { writer: 'primary:test' } })
  })

  it('says so when the run fetched nothing and had no facts, rather than leave the judge guessing', async () => {
    await authed()
    const evidence = (decideWatcherPost.mock.calls[0][0] as { evidence: string }).evidence
    expect(evidence).toMatch(/INSTRUCTION:\nRemind everyone to put the bins out\.\n\nTOOL RESULTS:\n\(none\)$/)
  })

  it('holds a draft back when the decision is skip, keeping it for the member marked held, with why', async () => {
    decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.8, model: 'primary:test', reason: 'a time the evidence does not give' })
    await authed()
    expect(reports()).toEqual([
      {
        memberId: 9, automationId: 1, label: 'bin night', helper: null, status: 'held', body: 'Bins out tonight.',
        detail: 'Held back: the check said skip at 0.80: a time the evidence does not give.',
      },
    ])
  })

  it('says what the claim check cut when the decision then holds the rest back', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight', 'a refund'], unsupported: ['a refund'], message: 'Bins out tonight.' })
    decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.59, model: 'gemini:gemini-3.5-flash-lite' })
    await authed()
    expect(reports()[0]).toMatchObject({ status: 'held', body: 'Bins out tonight.', detail: 'Held back: the check said skip at 0.59. The claim check cut: a refund.' })
  })

  // A whole brief was once held back at 0.95 over one To do a later email had
  // answered: the claim check passed the statement (the request says it) and
  // the judge, sure, faulted it with the later mail beside it. One statement
  // the judge quotes is cut from a draft the check has passed, as a failed
  // claim is, and the rest is judged again rather than lost with it.
  it('cuts the one statement a sure judge faults in a checked draft, judges the rest again, and keeps that', async () => {
    runAgent.mockResolvedValue({ text: 'Bins out tonight. The swimming form is due Friday.', model: 'primary:test' })
    reviewDraft.mockResolvedValue({ claims: ['bins tonight', 'the swimming form is due Friday'], unsupported: [], message: 'Bins out tonight. The swimming form is due Friday.' })
    decideWatcherPost
      .mockResolvedValueOnce({
        decision: 'skip', confidence: 0.95, model: 'primary:test',
        reason: 'the draft states something the evidence does not contain: the swimming form is due Friday', notInEvidence: 'the swimming form is due Friday',
      })
      .mockResolvedValueOnce({ decision: 'post', confidence: 0.9, model: 'primary:test' })
    cutFromDraft.mockResolvedValue('Bins out tonight.')
    await authed()
    expect(cutFromDraft).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'bin night', draft: 'Bins out tonight. The swimming form is due Friday.', unsupported: ['the swimming form is due Friday'] }),
    )
    // The cut draft is a rewrite nobody has checked since: judged on the full line.
    expect(decideWatcherPost).toHaveBeenCalledTimes(2)
    expect(decideWatcherPost.mock.calls[1][0]).toMatchObject({ draft: 'Bins out tonight.', verified: false })
    expect(reports()).toEqual([
      expect.objectContaining({ status: 'ready', body: 'Bins out tonight.', detail: 'One statement the check found no evidence for was cut: the swimming form is due Friday' }),
    ])
    expect(noteRun).toHaveBeenCalledWith({
      metadata: { second_decision: 'post', second_confidence: 0.9 },
      detail: { judge_cut: 'the swimming form is due Friday' },
    })
  })

  it('holds the draft, both answers in the reason, when the rest is held too', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight'], unsupported: [], message: 'Bins out tonight.' })
    decideWatcherPost
      .mockResolvedValueOnce({ decision: 'skip', confidence: 0.95, model: 'primary:test', reason: 'the draft states something the evidence does not contain: a time', notInEvidence: 'a time' })
      .mockResolvedValueOnce({ decision: 'skip', confidence: 0.6, model: 'primary:test', reason: 'the judge was not sure enough of its answers' })
    cutFromDraft.mockResolvedValue('Bins out.')
    await authed()
    expect(reports()).toEqual([
      expect.objectContaining({
        status: 'held',
        body: 'Bins out tonight.',
        detail:
          'Held back: the check said skip at 0.95: the draft states something the evidence does not contain: a time; with it cut, the check said skip at 0.60: the judge was not sure enough of its answers.',
      }),
    ])
    expect(noteRun).toHaveBeenCalledWith({
      metadata: { second_decision: 'skip', second_confidence: 0.6 },
      detail: { judge_cut: 'a time', second_reason: 'the judge was not sure enough of its answers' },
    })
  })

  it('says so when the second ruling gave no reason', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight'], unsupported: [], message: 'Bins out tonight.' })
    decideWatcherPost
      .mockResolvedValueOnce({ decision: 'skip', confidence: 0.95, model: 'primary:test', reason: 'invented: a time', notInEvidence: 'a time' })
      .mockResolvedValueOnce({ decision: 'skip', confidence: 0.6, model: 'primary:test' })
    cutFromDraft.mockResolvedValue('Bins out.')
    await authed()
    expect(String(reports()[0].detail)).toBe('Held back: the check said skip at 0.95: invented: a time; with it cut, the check said skip at 0.60.')
  })

  it('holds it when cutting the statement leaves nothing, and on the first ruling when the cut cannot be made', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight'], unsupported: [], message: 'Bins out tonight.' })
    decideWatcherPost.mockResolvedValue({
      decision: 'skip', confidence: 0.95, model: 'primary:test', reason: 'the draft states something the evidence does not contain: bins tonight', notInEvidence: 'bins tonight',
    })
    cutFromDraft.mockResolvedValue(null)
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledTimes(1)
    expect(String(reports()[0].detail)).toContain('skip at 0.95: the draft states something the evidence does not contain: bins tonight; cutting it left nothing to report')

    q.addReport.mockClear()
    decideWatcherPost.mockClear()
    cutFromDraft.mockRejectedValue(new Error('No object generated'))
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledTimes(1)
    expect(reports()[0]).toMatchObject({ status: 'held' })
    expect(String(reports()[0].detail)).toContain('; it could not be cut and judged again (No object generated)')
  })

  it('leaves the first ruling standing, the draft held and what it read spent, when the tick ran out of time for the second round', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now()
      const staged = [{ key: 'mail_cursor:auto:1:9:google', at: '2026-10-06T01:00:00.000Z', ids: ['m1'], prev: null }]
      runAgent.mockResolvedValueOnce({ text: 'Bins out tonight.', model: 'primary:test', cursors: staged })
      reviewDraft.mockResolvedValue({ claims: ['bins tonight'], unsupported: [], message: 'Bins out tonight.' })
      decideWatcherPost.mockResolvedValue({
        decision: 'skip', confidence: 0.95, model: 'primary:test', reason: 'the draft states something the evidence does not contain: tonight', notInEvidence: 'tonight',
      })
      // The judge had ruled; the cut was refused for want of time, which is no second ruling and no UNJUDGED.
      cutFromDraft.mockImplementation(async () => {
        vi.setSystemTime(start + 280_000)
        throw new Error('Timed out before any model was asked')
      })
      await authed()
      expect(decideWatcherPost).toHaveBeenCalledTimes(1)
      expect(reports()[0]).toMatchObject({ status: 'held' })
      expect(String(reports()[0].detail)).toContain('Held back: the check said skip at 0.95')
      expect(String(reports()[0].detail)).toContain('could not be cut and judged again (Timed out before any model was asked)')
      expect(q.setSetting).toHaveBeenCalledWith('mail_cursor:auto:1:9:google', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('cuts nothing from a draft the check did not pass whole, nor when the judge quoted no statement', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight', 'a refund'], unsupported: ['a refund'], message: 'Bins out tonight.' })
    decideWatcherPost.mockResolvedValue({
      decision: 'skip', confidence: 0.95, model: 'primary:test', reason: 'the draft states something the evidence does not contain: tonight', notInEvidence: 'tonight',
    })
    await authed()
    expect(cutFromDraft).not.toHaveBeenCalled()
    expect(reports()[0]).toMatchObject({ status: 'held' })

    q.addReport.mockClear()
    reviewDraft.mockResolvedValue({ claims: ['bins tonight'], unsupported: [], message: 'Bins out tonight.' })
    decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.95, model: 'primary:test', reason: 'the draft states something the evidence does not contain' })
    await authed()
    expect(cutFromDraft).not.toHaveBeenCalled()
    expect(reports()[0]).toMatchObject({ status: 'held' })
  })

  it("keeps what the judge decided: the line is the judge's own, never a second one here", async () => {
    decideWatcherPost.mockResolvedValue({ decision: 'post', confidence: 0.63, model: 'gemini:gemini-3.5-flash-lite' })
    await authed()
    expect(reports()[0]).toMatchObject({ status: 'ready', body: 'Bins out tonight.', detail: null })
  })

  it('keeps the reviewed draft as written, never a retype from the decision', async () => {
    runAgent.mockResolvedValue({ text: '**Bins** out tonight.', model: 'primary:test' })
    decideWatcherPost.mockResolvedValue({ decision: 'post', confidence: 0.95, message: 'Bins out tonight.', model: 'primary:test' })
    await authed()
    expect(reports()[0]).toMatchObject({ body: '**Bins** out tonight.' })
  })

  it('keeps the draft marked unchecked when the decision itself fails, with what the claim check cut', async () => {
    decideWatcherPost.mockRejectedValue(new Error('No object generated'))
    await authed()
    expect(reports()[0]).toMatchObject({ status: 'ready', body: 'Bins out tonight.', detail: 'Not checked against its evidence: the check failed (No object generated).' })
    expect(noteRun).toHaveBeenCalledWith({ metadata: { decision: 'unavailable, kept unchecked' }, detail: { decision_error: 'No object generated' } })

    q.addReport.mockClear()
    reviewDraft.mockResolvedValue({ claims: ['bins tonight', 'a refund'], unsupported: ['a refund'], message: 'Bins out tonight.' })
    await authed()
    expect(reports()[0].detail).toBe('Not checked against its evidence: the check failed (No object generated). The claim check cut: a refund')
  })

  it('keeps nothing, and leaves what the run read new, when the tick ran out of time for the decision', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now()
      const staged = [{ key: 'mail_cursor:auto:1:9:google', at: '2026-10-06T01:00:00.000Z', ids: ['m1'], prev: null }]
      runAgent.mockResolvedValueOnce({ text: 'Bins out tonight.', model: 'primary:test', cursors: staged })
      // The first judge used up the tick, and the next was never asked.
      decideWatcherPost.mockImplementation(async () => {
        vi.setSystemTime(start + 280_000)
        throw new Error('The operation was aborted due to timeout')
      })
      await authed()
      expect(q.addReport).not.toHaveBeenCalled()
      expect(q.setSetting).not.toHaveBeenCalledWith('mail_cursor:auto:1:9:google', expect.anything())
      // Nobody ruled on it, which says nothing about the mail: it is not counted either.
      expect(q.setSetting).not.toHaveBeenCalledWith('unspent:1', expect.anything())
      expect(noteRun).toHaveBeenCalledWith({ metadata: { decision: 'out of time' } })
      expect(noteRun).toHaveBeenCalledWith({ output: 'Bins out tonight.', metadata: { outcome: 'held back unjudged' }, level: 'WARNING' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an unjudged draft held, and spends what it read, when the run already acted on it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now()
      const staged = [{ key: 'mail_cursor:auto:1:9:google', at: '2026-10-06T01:00:00.000Z', ids: ['m1'], prev: null }]
      runAgent.mockResolvedValueOnce({ text: 'Added the permission slip to the list.', model: 'primary:test', cursors: staged, wrote: ['add_to_list'] })
      decideWatcherPost.mockImplementation(async () => {
        vi.setSystemTime(start + 280_000)
        throw new Error('The operation was aborted due to timeout')
      })
      await authed()
      expect(q.setSetting).toHaveBeenCalledWith('mail_cursor:auto:1:9:google', expect.stringContaining('m1'))
      expect(reports()).toEqual([
        expect.objectContaining({
          status: 'held',
          body: 'Added the permission slip to the list.',
          detail: 'The tick ran out of time before the checks could finish, after the run had already acted on what it read.',
        }),
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('checks the claims before deciding, decides on what survived, and says what was cut', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight', 'recycling week'], unsupported: ['recycling week'], message: 'Bins out tonight.' })
    runAgent.mockResolvedValue({ text: 'Bins out tonight, recycling week.', model: 'primary:test' })
    await authed()
    expect(reviewDraft).toHaveBeenCalledWith(expect.objectContaining({ draft: 'Bins out tonight, recycling week.' }))
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ draft: 'Bins out tonight.' }))
    expect(reports()[0]).toMatchObject({ status: 'ready', body: 'Bins out tonight.', detail: 'The claim check cut: recycling week' })
    expect(noteRun).toHaveBeenCalledWith({ metadata: { claims: 2, unsupported: 1, verified: false }, detail: { check_cut: ['recycling week'] } })
  })

  it('tells the decision when the check went through the draft and passed every statement', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight'], unsupported: [], message: 'Bins out tonight.' })
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ draft: 'Bins out tonight.', verified: true }))
  })

  it('leaves the full line standing when the check rewrote the draft, found nothing to check, or could not run', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight', 'recycling week'], unsupported: ['recycling week'], message: 'Bins out tonight.' })
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ verified: false }))

    decideWatcherPost.mockClear()
    reviewDraft.mockResolvedValue({ claims: [], unsupported: [], message: 'Bins out tonight.' })
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ verified: false }))

    decideWatcherPost.mockClear()
    reviewDraft.mockRejectedValue(new Error('No object generated'))
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ draft: 'Bins out tonight.', verified: false }))
    expect(noteRun).toHaveBeenCalledWith({ metadata: { claim_check: 'unavailable' } })
    expect(console.error).toHaveBeenCalledWith('[tick] bin night: claim check unavailable, deciding on the raw draft:', 'No object generated')
  })

  it('keeps the draft held, never deciding on it, when no claim survives the check', async () => {
    reviewDraft.mockResolvedValue({ claims: ['a trip to Lisbon'], unsupported: ['a trip to Lisbon'], message: null })
    await authed()
    expect(decideWatcherPost).not.toHaveBeenCalled()
    expect(reports()[0]).toMatchObject({ status: 'held', body: 'Bins out tonight.', detail: 'Held back: no claim survived the check: a trip to Lisbon.' })
    expect(noteRun).toHaveBeenCalledWith({ metadata: { claims: 1, unsupported: 1 }, detail: { held_because: 'no claim survived the check: a trip to Lisbon' } })
  })

  it('keeps the draft held, never deciding on it as written, when what failed the check could not be cut out', async () => {
    reviewDraft.mockResolvedValue({
      claims: ['bins tonight', 'a trip to Lisbon'], unsupported: ['a trip to Lisbon'], message: null,
      rewriteFailed: 'Timed out before any model was asked',
    })
    await authed()
    expect(decideWatcherPost).not.toHaveBeenCalled()
    expect(String(reports()[0].detail)).toBe('Held back: claims failed the check and could not be cut out (Timed out before any model was asked): a trip to Lisbon.')
  })

  it('keeps nothing and leaves what it read new when the tick ran out of time to cut out a failed claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const start = Date.now()
      const staged = [{ key: 'mail_cursor:auto:1:9:google', at: '2026-09-24T01:00:00.000Z', ids: ['m1'], prev: null }]
      runAgent.mockResolvedValueOnce({ text: 'Bins out tonight, and a trip to Lisbon.', model: 'primary:test', cursors: staged })
      // The check ran long, and the rewrite was refused for want of time, not by any judge.
      reviewDraft.mockImplementation(async () => {
        vi.setSystemTime(start + 255_000)
        return { claims: ['bins tonight', 'a trip to Lisbon'], unsupported: ['a trip to Lisbon'], message: null, rewriteFailed: 'Timed out before any model was asked' }
      })
      await authed()
      expect(decideWatcherPost).not.toHaveBeenCalled()
      expect(q.addReport).not.toHaveBeenCalled()
      expect(q.setSetting).not.toHaveBeenCalledWith('mail_cursor:auto:1:9:google', expect.anything())
      expect(q.setSetting).not.toHaveBeenCalledWith('unspent:1', expect.anything())
      expect(console.warn).toHaveBeenCalledWith('[tick] bin night: held back, the tick ran out of time to cut out claims that failed the check: a trip to Lisbon')
    } finally {
      vi.useRealTimers()
    }
  })

  it('says when the output allowance cut the report short, beside anything else the checks changed', async () => {
    runAgent.mockResolvedValue({ text: '**To do**\n- Bins out tonight.', model: 'primary:test', cutShort: true })
    reviewDraft.mockResolvedValue({ claims: ['bins', 'a refund'], unsupported: ['a refund'], message: '**To do**\n- Bins out tonight.' })
    await authed()
    expect(reports()[0].detail).toBe('The claim check cut: a refund The output allowance cut it short, so it lost its unfinished end.')
    expect(noteRun).toHaveBeenCalledWith({ output: '**To do**\n- Bins out tonight.', metadata: { outcome: 'kept', cut_short: true }, level: 'WARNING' })
  })
})

describe('the stuck guard', () => {
  const KEY = 'mail_cursor:auto:1:9:google'
  const HOUR = 3600_000
  const move = (ids: string[], at = '2026-09-24T01:00:00.000Z', key = KEY) => ({ key, at, ids, prev: null })
  const stuckAt = (entries: Record<string, unknown>) =>
    q.getSetting.mockImplementation(async (key: string) => (key === 'unspent:1' ? JSON.stringify(entries) : null))
  const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()
  const entry = (runs: number, hoursAgo: number, ids = ['m1']) => ({ from: '-', since: ago(hoursAgo), last: ago(hoursAgo), runs, move: move(ids) })
  const written = () => {
    const call = q.setSetting.mock.calls.findLast(([k]) => k === 'unspent:1')
    return call?.[1] ? JSON.parse(call[1]) : call ? {} : undefined
  }
  const problem = () => ({ text: 'PROBLEM: read_email failed for the school message\nSKIP', model: 'primary:test', cursors: [move(['m1'])] })
  /** A run that fails outright after looking, its look kept against the error. */
  const failsWith = (err: unknown) => {
    runAgent.mockRejectedValueOnce(err)
    looksBefore.mockImplementation((e) => (e === err ? [move(['m1'])] : []))
  }
  const movedReport = () => reports().find((r) => String(r.body).startsWith('Failed on the same new items'))

  beforeEach(() => {
    process.env.TICK_SECRET = 'let-me-in'
    dueAutomations.mockResolvedValue([automation()])
  })

  it('counts a run that leaves the mail unspent, and says nothing more yet', async () => {
    runAgent.mockResolvedValue(problem())
    await authed()
    expect(written()[KEY]).toMatchObject({ from: '-', runs: 1, move: { ids: ['m1'] } })
    expect(q.setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
    expect(movedReport()).toBeUndefined()
  })

  it('counts on from the last run when it is stuck at the same place, keeping when it started', async () => {
    const first = entry(1, 2)
    stuckAt({ [KEY]: first })
    failsWith(new Error('the attachment cannot be read'))
    await authed()
    expect(written()[KEY]).toMatchObject({ from: '-', since: first.since, runs: 2, move: first.move })
    expect(Date.parse(written()[KEY].last)).toBeGreaterThan(Date.parse(first.last))
  })

  const apiError = (message: string, statusCode: number | undefined, isRetryable = false) =>
    new APICallError({ message, url: 'https://llm.test', requestBodyValues: {}, statusCode, isRetryable })
  const retried = (last: Error) => new RetryError({ message: `Failed after 3 attempts. Last error: ${last.message}`, reason: 'maxRetriesExceeded', errors: [last] })

  it.each([
    ['a rate limit', () => retried(apiError('Provider returned error', 429, true))],
    ['a retried call whose last try the provider marked retryable, in words that say nothing', () => retried(apiError('Conflict', 409, true))],
    ['a gateway error', () => apiError('Bad Gateway', 502, true)],
    ['no credit left', () => apiError('Insufficient credits', 402)],
    ['a key the provider refuses', () => apiError('User not found.', 401)],
    ['a key Gemini answers a 400 for', () => apiError('API key not valid. Please pass a valid API key.', 400)],
    ['no connection', () => apiError('Cannot connect to API: connect ECONNREFUSED 10.0.0.1:443', undefined, true)],
    ['a step that timed out', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['a request aborted', () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
    ['nothing configured', () => new Error('No LLM configured: set GEMINI_API_KEY, OPENROUTER_API_KEY, or LLM_BASE_URL + LLM_MODEL')],
  ])('does not count %s, which says nothing about the mail', async (_what, make) => {
    stuckAt({ [KEY]: entry(2, 20) })
    failsWith(make())
    await authed()
    expect(q.setSetting).not.toHaveBeenCalledWith('unspent:1', expect.anything())
    expect(q.setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
  })

  it.each([
    ['a request too long for the model, whose token count is no status code', () => retried(apiError('The input token count (1048576) exceeds the maximum number of tokens allowed (1048576).', 400))],
    ['a payload the provider will not take', () => apiError('Request Entity Too Large', 413)],
    ['a reply no model could finish', () => new Error('openrouter:minimax/minimax-m3:free returned no text')],
  ])('counts %s, which fails the same way every time', async (_what, make) => {
    stuckAt({ [KEY]: entry(2, 20) })
    failsWith(make())
    await authed()
    expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
  })

  it("does not count a PROBLEM that is a tool's service down or unset, only one about what was read", async () => {
    stuckAt({ [KEY]: entry(2, 20) })
    runAgent.mockResolvedValue({ ...problem(), text: 'PROBLEM: weather returned 503 Service Unavailable\nPROBLEM: Jira is not configured\nSKIP' })
    await authed()
    expect(q.setSetting).not.toHaveBeenCalledWith('unspent:1', expect.anything())
    // Both kept for the member all the same: they are what went wrong.
    expect(reports()[0]).toMatchObject({ status: 'problem', body: 'PROBLEM: weather returned 503 Service Unavailable\nPROBLEM: Jira is not configured' })

    runAgent.mockResolvedValue({ ...problem(), text: 'PROBLEM: weather returned 503\nPROBLEM: read_email failed for the school message\nSKIP' })
    await authed()
    expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
  })

  it('counts a PROBLEM whose status is a link in the mail, not a service', async () => {
    stuckAt({ [KEY]: entry(2, 20) })
    runAgent.mockResolvedValue({ ...problem(), text: 'PROBLEM: read_url on the school newsletter link failed: The page answered 403.\nSKIP' })
    await authed()
    expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
  })

  it('reads a count that never noted its last run by when it started', async () => {
    const { last: _last, ...older } = entry(1, 2)
    stuckAt({ [KEY]: older })
    runAgent.mockResolvedValue(problem())
    await authed()
    expect(written()[KEY]).toMatchObject({ since: older.since, runs: 2 })
  })

  it('forgets a count not added to in over a week', async () => {
    stuckAt({ [KEY]: entry(2, 9 * 24) })
    runAgent.mockResolvedValue(problem())
    await authed()
    expect(written()[KEY]).toMatchObject({ runs: 1 })
    expect(q.setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
  })

  it('still moves a weekly automation on, whose runs are a week apart', async () => {
    stuckAt({ [KEY]: { ...entry(2, 14 * 24), last: ago(7 * 24) } })
    runAgent.mockResolvedValue(problem())
    await authed()
    expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
  })

  it('moves a cursor held at a real place on no further than it has got since, naming the span', async () => {
    const from = '2026-09-22T21:00:00.000Z'
    const ahead = '2026-09-24T03:00:00.000Z'
    const first = { from, since: ago(20), last: ago(20), runs: 2, move: { key: KEY, at: '2026-09-23T01:00:00.000Z', ids: ['m0'], prev: { at: from, ids: [] } } }
    // Another reader has meanwhile moved the stored cursor on past the stuck move.
    q.getSetting.mockImplementation(async (key: string) =>
      key === 'unspent:1' ? JSON.stringify({ [KEY]: first })
      : key === KEY ? JSON.stringify({ at: ahead, ids: ['c1'] })
      : null,
    )
    runAgent.mockResolvedValue({ ...problem(), cursors: [{ key: KEY, at: '2026-09-24T01:00:00.000Z', ids: ['m1'], prev: { at: from, ids: [] } }] })
    await authed()
    const spent = JSON.parse(q.setSetting.mock.calls.find(([k]) => k === KEY)![1])
    expect(spent.at).toBe(ahead)
    expect(spent.ids).toEqual(['c1', 'm0'])
    expect(String(movedReport()!.body)).toMatch(/mail in your linked Gmail mailbox from Wed,? 23 Sept 2026,? 7:00\s?am to Wed,? 23 Sept 2026,? 11:00\s?am/)
  })

  it('starts the count again when the cursor is held somewhere new', async () => {
    stuckAt({ [KEY]: { ...entry(2, 20), from: '2026-09-20T00:00:00.000Z' } })
    runAgent.mockResolvedValue(problem())
    await authed()
    expect(written()[KEY]).toMatchObject({ from: '-', runs: 1 })
    expect(q.setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
  })

  it('does not move past three quick failures, only ones spread over hours', async () => {
    stuckAt({ [KEY]: entry(2, 2) })
    runAgent.mockResolvedValue(problem())
    await authed()
    expect(written()[KEY]).toMatchObject({ runs: 3 })
    expect(q.setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
  })

  it('moves past what the first stuck run saw, not what has arrived since, and says so once', async () => {
    stuckAt({ [KEY]: entry(2, 20, ['m0']) })
    runAgent.mockResolvedValue(problem())
    await authed()
    const spent = q.setSetting.mock.calls.find(([k]) => k === KEY)
    expect(JSON.parse(spent![1]).ids).toEqual(['m0'])
    expect(q.setSetting).toHaveBeenCalledWith('unspent:1', '')
    const told = reports().filter((r) => String(r.body).startsWith('Failed on the same new items'))
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ memberId: 9, automationId: 1, status: 'problem' })
    expect(String(told[0].body)).toContain('Failed on the same new items 3 runs running (the run reported a problem)')
    expect(String(told[0].body)).toContain('mail in your linked Gmail mailbox up to')
  })

  it('moves past on a third failure outright too, and still reports that failure', async () => {
    stuckAt({ [KEY]: entry(2, 20) })
    failsWith(new Error('the attachment cannot be read'))
    await authed()
    expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
    expect(String(movedReport()!.body)).toContain('(the attachment cannot be read), so it has moved past them')
    expect(reports().at(-1)).toMatchObject({ body: 'It failed: the attachment cannot be read' })
  })

  it('names each mailbox it moves past by what it is', async () => {
    const outlook = 'mail_cursor:auto:1:9:microsoft'
    const other = 'mail_cursor:auto:1:9:yahoo'
    const odd = 'board_cursor:auto:1'
    const old = (key: string) => ({ ...entry(2, 20), move: move(['x'], '2026-09-24T01:00:00.000Z', key) })
    stuckAt({ [outlook]: old(outlook), [other]: old(other), [odd]: old(odd) })
    runAgent.mockResolvedValue({ ...problem(), cursors: [move(['x'], '2026-09-24T01:00:00.000Z', outlook), move(['x'], '2026-09-24T01:00:00.000Z', other), move(['x'], '2026-09-24T01:00:00.000Z', odd)] })
    await authed()
    const body = String(movedReport()!.body)
    expect(body).toContain('mail in your linked Outlook mailbox up to')
    expect(body).toContain('mail in your linked yahoo mailbox up to')
    expect(body).toContain('new items up to')
  })

  it("keeps each mailbox's count apart, so one whose fetch fails some runs neither resets nor rides on another", async () => {
    const other = 'mail_cursor:auto:1:9:microsoft'
    const otherEntry = { ...entry(1, 1), move: { ...move(['o1']), key: other } }
    stuckAt({ [KEY]: entry(2, 20), [other]: otherEntry })
    runAgent.mockResolvedValue(problem())
    await authed()
    // Only this mailbox was looked at this run: it moves on, the other waits where it was.
    expect(q.setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
    expect(q.setSetting).not.toHaveBeenCalledWith(other, expect.anything())
    expect(written()).toEqual({ [other]: otherEntry })
  })

  it('clears a cursor from the count once a run spends it, and leaves the count alone when it held nothing of the run', async () => {
    stuckAt({ [KEY]: entry(2, 20) })
    runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', model: 'primary:test', cursors: [move(['m1'])] })
    await authed()
    expect(reports()[0]).toMatchObject({ status: 'ready', body: '**To do**\n- School: permission slip due Friday.' })
    expect(q.setSetting).toHaveBeenCalledWith('unspent:1', '')
    expect(movedReport()).toBeUndefined()

    q.setSetting.mockClear()
    stuckAt({ 'mail_cursor:auto:1:9:microsoft': { ...entry(1, 1), move: move(['o1'], '2026-09-24T01:00:00.000Z', 'mail_cursor:auto:1:9:microsoft') } })
    await authed()
    expect(q.setSetting).not.toHaveBeenCalledWith('unspent:1', expect.anything())
  })

  it('treats an unreadable count as none', async () => {
    for (const raw of ['{not json', 'null', '42']) {
      vi.clearAllMocks()
      dueAutomations.mockResolvedValue([automation()])
      q.getSetting.mockImplementation(async (key: string) => (key === 'unspent:1' ? raw : null))
      runAgent.mockResolvedValue(problem())
      await authed()
      expect(written()[KEY]).toMatchObject({ runs: 1 })
    }
  })

  it('keeps the run going when the guard itself cannot be written, and still keeps a report when clearing fails', async () => {
    q.setSetting.mockImplementation(async (key: string) => {
      if (key === 'unspent:1') throw new Error('db down')
    })
    failsWith(new Error('the attachment cannot be read'))
    await authed()
    expect(console.error).toHaveBeenCalledWith('[tick] stuck guard failed:', expect.any(Error))
    expect(reports().at(-1)).toMatchObject({ body: 'It failed: the attachment cannot be read' })

    q.addReport.mockClear()
    stuckAt({ [KEY]: entry(1, 1) })
    runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', model: 'primary:test', cursors: [move(['m1'])] })
    await authed()
    expect(reports()[0]).toMatchObject({ status: 'ready' })
    expect(console.error).toHaveBeenCalledWith('[tick] stuck guard failed:', 'db down')
  })

  it('logs a guard that fails on a PROBLEM, and still counts the run', async () => {
    q.setSetting.mockImplementation(async (key: string) => {
      if (key === 'unspent:1') throw new Error('db down')
    })
    runAgent.mockResolvedValue(problem())
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(console.error).toHaveBeenCalledWith('[tick] stuck guard failed:', expect.any(Error))
  })
})

describe('what each run tells Langfuse', () => {
  beforeEach(() => {
    process.env.TICK_SECRET = 'let-me-in'
  })

  it('traces each claimed run on its own, named for what it is, with what it judged against and what it kept', async () => {
    dueAutomations.mockResolvedValue([automation(), automation({ id: 2, label: 'recycling' })])
    await authed()
    expect(traceRun).toHaveBeenCalledTimes(2)
    expect(traceRun).toHaveBeenCalledWith(
      'hearth.watcher',
      { sessionId: 'automation-1', tags: ['watcher'], metadata: { label: 'bin night', automation: '1' } },
      expect.any(Function),
    )
    expect(traceRun.mock.calls[1][1]).toMatchObject({ sessionId: 'automation-2', metadata: { label: 'recycling', automation: '2' } })
    expect(noteRun).toHaveBeenCalledWith({ input: 'INSTRUCTION:\nRemind everyone to put the bins out.' })
    expect(noteRun).toHaveBeenCalledWith({ output: 'Bins out tonight.', metadata: { outcome: 'kept' } })
    expect(noteRun).toHaveBeenCalledWith(expect.objectContaining({ metadata: { decision: 'post', confidence: 0.9, judge: 'primary:test' } }))
  })

  it('marks a held draft as a warning, the reason kept apart from the shape', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight'], unsupported: [], message: 'Bins out tonight.' })
    decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.8, model: 'primary:test', reason: 'a time the evidence does not give' })
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    expect(noteRun).toHaveBeenCalledWith({ metadata: { claims: 1, unsupported: 0, verified: true } })
    // The reason quotes the draft, so it travels as detail, which a household
    // that keeps content out of Langfuse does not record.
    expect(noteRun).toHaveBeenCalledWith({ metadata: { decision: 'skip', confidence: 0.8, judge: 'primary:test' }, detail: { reason: 'a time the evidence does not give' } })
    expect(noteRun).toHaveBeenCalledWith({ output: 'Bins out tonight.', metadata: { outcome: 'held back' }, level: 'WARNING' })
  })

  it('says that a failed run failed', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockRejectedValueOnce(new Error('model exploded'))
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 0 })
    expect(noteRun).toHaveBeenCalledWith({ output: 'model exploded', metadata: { outcome: 'failed' }, level: 'ERROR' })
  })

  it('marks a run that put a draft to the checks, which a groundedness evaluator filters on, and only that', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    expect(noteRun).toHaveBeenCalledWith({ metadata: { draft: 'yes' } })

    noteRun.mockClear()
    runAgent.mockResolvedValue({ text: 'SKIP', model: 'primary:test' })
    await authed()
    expect(noteRun).not.toHaveBeenCalledWith({ metadata: { draft: 'yes' } })
    expect(noteRun).toHaveBeenCalledWith({ output: 'SKIP', metadata: { outcome: 'skipped' } })
  })

  it('makes whoever set a run up its user on every call in it, the checks included', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    expect(traced).toHaveBeenCalledWith({ userId: '9' }, expect.any(Function))
    expect(decideWatcherPost).toHaveBeenCalled()
  })
})
