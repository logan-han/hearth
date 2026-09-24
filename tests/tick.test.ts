import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Automation } from '@/lib/db/schema'

const dueAutomations = vi.fn<(now: Date) => Promise<Automation[]>>()
const claimAutomation = vi.fn<(id: number, expected: Date, next: Date | null) => Promise<boolean>>()
const runAgent = vi.fn()
const looksBefore = vi.fn((_err?: unknown) => [] as unknown[])
const decideWatcherPost = vi.fn()
const reviewDraft = vi.fn()
const newTransactions = vi.fn()
const newMail = vi.fn()
const listEvents = vi.fn()
const boardSummary = vi.fn()
const weatherTool = vi.fn()
const spendingSummary = vi.fn()
const budgetSummary = vi.fn()
const strangersIn = vi.fn<(chatId: string) => Promise<{ id: string; name: string }[]>>()
const unaskedQuestions = vi.fn<() => Promise<{ id: number; question: string }[]>>()
const markQuestionsAsked = vi.fn<(ids: number[]) => Promise<void>>()
const allowedMembers = vi.fn<() => Promise<{ id: number; telegramUserId: string; name: string; isAdmin: boolean; allowed: boolean }[]>>()
type Counted = (room: { chatId: string; title: string | null }, unaccounted: number | null) => Promise<void>
const installBuiltins = vi.fn(async (_now?: Date, _on?: { counted?: Counted }) => ({ installed: [] as string[], converted: 0, retired: 0, synced: 0 }))
const send = vi.fn<(chatId: string, text: string) => Promise<void>>()
const verify = vi.fn<() => Promise<boolean>>()
const insertValues = vi.fn()
const buildTools = vi.fn(
  () =>
    ({
      new_transactions: { execute: newTransactions },
      new_mail: { execute: newMail },
      list_family_events: { execute: listEvents },
      jira_board_summary: { execute: boardSummary },
      weather: { execute: weatherTool },
      spending_summary: { execute: spendingSummary },
      budget_summary: { execute: budgetSummary },
    }) as Record<string, { execute?: (...args: unknown[]) => unknown }>,
)

const { unaccountedIn, memberByTelegramId, creatorRows, setAutomationEnabled } = vi.hoisted(() => ({
  setAutomationEnabled: vi.fn(async (_id: number, _enabled: boolean) => ({})),
  unaccountedIn: vi.fn<(chatId: string) => Promise<number | null>>(async () => 0),
  memberByTelegramId: vi.fn<(id: string) => Promise<{ allowed: boolean } | undefined>>(async () => ({ allowed: true })),
  creatorRows: vi.fn(async () => [] as unknown[]),
}))
vi.mock('@/lib/headcount', () => ({ unaccountedIn }))

const { recordMessage, messagesSince, getSetting, setSetting, recordTick, retireStaleProposals } = vi.hoisted(() => ({
  recordMessage: vi.fn(async () => 1),
  messagesSince: vi.fn(async () => [] as unknown[]),
  getSetting: vi.fn<(key: string) => Promise<string | null>>(async () => null),
  setSetting: vi.fn<(key: string, value: string) => Promise<void>>(async () => {}),
  recordTick: vi.fn<(now: Date) => Promise<void>>(async () => {}),
  retireStaleProposals: vi.fn(async (_now: Date) => ({ expired: 0, superseded: 0 })),
}))
vi.mock('@/lib/db/queries', () => ({
  dueAutomations,
  claimAutomation,
  recordMessage,
  messagesSince,
  getSetting,
  setSetting,
  recordTick,
  retireStaleProposals,
  strangersIn,
  unaskedQuestions,
  markQuestionsAsked,
  allowedMembers,
  memberByTelegramId,
  setAutomationEnabled,
}))
vi.mock('@/lib/builtins', () => ({ installBuiltins }))
vi.mock('@/lib/agent', () => ({ runAgent, decideWatcherPost, reviewDraft, looksBefore }))
vi.mock('@/lib/tools', () => ({ buildTools }))
vi.mock('@/lib/telegram', () => ({ send }))
vi.mock('@upstash/qstash', () => ({ Receiver: class { verify = verify } }))
vi.mock('@/lib/db', () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: creatorRows }) }) }),
    insert: () => ({ values: insertValues }),
  }),
  schema: { members: { id: 'id' }, messages: {} },
}))

const { POST, GET } = await import('@/app/api/tick/route')
const { GrammyError, HttpError } = await import('grammy')
const { APICallError, RetryError } = await import('ai')

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

/** The household's date, which the nightly memory pass records as done. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date())

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
  looksBefore.mockImplementation(() => [])
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
  spendingSummary.mockResolvedValue({ error: 'PocketSmith is not configured.' })
  budgetSummary.mockResolvedValue({ error: 'PocketSmith is not configured.' })
  strangersIn.mockResolvedValue([])
  unaccountedIn.mockResolvedValue(0)
  memberByTelegramId.mockResolvedValue({ allowed: true })
  creatorRows.mockResolvedValue([])
  delete process.env.ALLOWED_TELEGRAM_IDS
  unaskedQuestions.mockResolvedValue([])
  markQuestionsAsked.mockResolvedValue(undefined)
  allowedMembers.mockResolvedValue([{ id: 9, telegramUserId: '900', name: 'Boss', isAdmin: true, allowed: true }])
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

  it('records every tick it accepts, so a quiet scheduler shows on the System page', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockResolvedValue(true)
    await tick({ 'upstash-signature': 'v1=abc' })
    expect(recordTick).toHaveBeenCalled()
    const [at] = recordTick.mock.calls.at(-1) ?? []
    expect(at?.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(retireStaleProposals).toHaveBeenCalled()
  })

  it('logs when recording the tick itself fails, without failing the request', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = 'sig_current'
    verify.mockResolvedValue(true)
    recordTick.mockRejectedValueOnce(new Error('db unreachable'))
    const res = await tick({ 'upstash-signature': 'v1=abc' })
    expect(res.status).toBe(200)
    expect(console.error).toHaveBeenCalledWith('[tick] could not record the tick:', expect.any(Error))
  })

  it('records nothing for a tick it refuses', async () => {
    expect((await tick()).status).toBe(401)
    expect(recordTick).not.toHaveBeenCalled()
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
    // A manual poke is not the scheduler's pulse.
    expect(recordTick).not.toHaveBeenCalled()
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

  it('claims as of now, and schedules the following run strictly in the future', async () => {
    dueAutomations.mockResolvedValue([automation()])
    await authed()
    const [, asOf, next] = claimAutomation.mock.calls[0]
    expect(asOf.getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(asOf.getTime()).toBeLessThanOrEqual(Date.now())
    expect(next!.getTime()).toBeGreaterThan(Date.now())
  })

  it('skips an automation another tick already claimed', async () => {
    dueAutomations.mockResolvedValue([automation()])
    claimAutomation.mockResolvedValue(false)
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 1 })
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('installs the built-in watchers before looking at what is due', async () => {
    await authed()
    expect(installBuiltins).toHaveBeenCalledTimes(1)
    expect(installBuiltins.mock.invocationCallOrder[0]).toBeLessThan(dueAutomations.mock.invocationCallOrder[0])
  })

  it('carries on when the built-in install fails', async () => {
    installBuiltins.mockRejectedValueOnce(new Error('chats table on fire'))
    dueAutomations.mockResolvedValue([automation()])
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
  })

  it('logs when the built-in watchers changed something', async () => {
    installBuiltins.mockResolvedValueOnce({ installed: ['Morning brief in Family'], converted: 0, retired: 0, synced: 0 })
    await authed()
    expect(console.info).toHaveBeenCalledWith(
      '[tick] built-in watchers:',
      JSON.stringify({ installed: ['Morning brief in Family'], converted: 0, retired: 0, synced: 0 }),
    )
  })

  it('claims a group run but posts nothing while someone unrecognised is in the room', async () => {
    dueAutomations.mockResolvedValue([automation(), automation({ id: 2, chatId: '111' })])
    strangersIn.mockImplementation(async (chatId: string) => (chatId === '-100999' ? [{ id: '555', name: 'Someone' }] : []))
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 1 })
    expect(claimAutomation).toHaveBeenCalledTimes(2)
    expect(send).not.toHaveBeenCalledWith('-100999', expect.anything())
    expect(send).toHaveBeenCalledWith('111', 'Bins out tonight.')
  })

  it('posts nothing into the DM of someone who is no longer allowed', async () => {
    dueAutomations.mockResolvedValue([automation({ chatId: '222', kind: 'money', label: '2Up transactions' })])
    memberByTelegramId.mockResolvedValue({ allowed: false })
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 1 })
    expect(claimAutomation).toHaveBeenCalledTimes(1)
    expect(newTransactions).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    // Deleted outright is the same: nobody left to post to.
    memberByTelegramId.mockResolvedValue(undefined)
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 1 })
    expect(send).not.toHaveBeenCalled()
  })

  it('still posts into a founder\'s DM, which the env seed allows', async () => {
    process.env.ALLOWED_TELEGRAM_IDS = '111'
    memberByTelegramId.mockResolvedValue(undefined)
    dueAutomations.mockResolvedValue([automation({ chatId: '111' })])
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(send).toHaveBeenCalledWith('111', 'Bins out tonight.')
  })

  it('runs a revoked creator\'s group watcher as the family, and tells an admin rather than them', async () => {
    creatorRows.mockResolvedValue([{ id: 9, telegramUserId: '222', name: 'Nanny', allowed: false, isAdmin: false }])
    dueAutomations.mockResolvedValue([automation({ memberId: 9, kind: 'morning', label: 'Morning brief' })])
    // A fetch problem goes to the creator first when there is one, which a revoked one no longer is.
    newMail.mockResolvedValue({ error: 'Graph answered 503' })
    await authed()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('Graph answered 503'))
    expect(send).not.toHaveBeenCalledWith('222', expect.anything())
    expect(setAutomationEnabled).not.toHaveBeenCalled()
  })

  it('pauses a revoked creator\'s own instruction rather than running it with the household\'s tools', async () => {
    creatorRows.mockResolvedValue([{ id: 9, telegramUserId: '222', name: 'Nanny', allowed: false, isAdmin: false }])
    dueAutomations.mockResolvedValue([automation({ memberId: 9, label: 'check everyone\'s mail' })])
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 1 })
    expect(runAgent).not.toHaveBeenCalled()
    expect(setAutomationEnabled).toHaveBeenCalledWith(1, false)
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('Paused **check everyone\'s mail**'))
    expect(send).not.toHaveBeenCalledWith('222', expect.anything())
  })

  it('pauses one whose creator has gone from the members table altogether', async () => {
    creatorRows.mockResolvedValue([])
    dueAutomations.mockResolvedValue([automation({ memberId: 9 })])
    await authed()
    expect(runAgent).not.toHaveBeenCalled()
    expect(setAutomationEnabled).toHaveBeenCalledWith(1, false)
  })

  it('holds a group post while Telegram counts people nobody has vouched for, telling an admin once', async () => {
    dueAutomations.mockResolvedValue([automation()])
    unaccountedIn.mockResolvedValue(2)
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 1 })
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('-100999', expect.anything())
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('Telegram counts 2 people there I cannot match to an allowed member'))
    expect(setSetting).toHaveBeenCalledWith('unaccounted:-100999', '2')

    // The next hour, the same count: logged, not said again.
    send.mockClear()
    getSetting.mockImplementation(async (key: string) => (key === 'unaccounted:-100999' ? '2' : key === 'memory_sweep_day' ? today() : null))
    await authed()
    expect(send).not.toHaveBeenCalled()
  })

  it('tells an admin again when the count changes', async () => {
    dueAutomations.mockResolvedValue([automation()])
    unaccountedIn.mockResolvedValue(3)
    getSetting.mockImplementation(async (key: string) => (key === 'unaccounted:-100999' ? '2' : key === 'memory_sweep_day' ? today() : null))
    await authed()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('Telegram counts 3 people'))
    expect(setSetting).toHaveBeenCalledWith('unaccounted:-100999', '3')
  })

  it('reports a Telegram hiccup during the count as the failure it is, not as a room it cannot see', async () => {
    dueAutomations.mockResolvedValue([automation()])
    unaccountedIn.mockRejectedValueOnce(new Error('Too Many Requests: retry after 5'))
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 0 })
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('failed: Too Many Requests'))
    expect(send).not.toHaveBeenCalledWith('900', expect.stringContaining('would not say'))
  })

  it('tells an admin, once, when a new room is not given its built-in watchers', async () => {
    installBuiltins.mockImplementationOnce(async (_now, on) => {
      await on?.counted?.({ chatId: '-400', title: 'School parents' }, 23)
      return { installed: [], converted: 0, retired: 0, synced: 0 }
    })
    await authed()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('The built-in watchers were not set up in School parents'))
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('Telegram counts 23 people'))
    expect(setSetting).toHaveBeenCalledWith('unaccounted:-400', '23')
  })

  it('holds a group post when Telegram will not say who is there', async () => {
    dueAutomations.mockResolvedValue([automation()])
    unaccountedIn.mockResolvedValue(null)
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 0, skipped: 1 })
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('would not say who is there'))
    expect(setSetting).toHaveBeenCalledWith('unaccounted:-100999', 'unknown')
  })

  it('posts again once the room is accounted for, and forgets the count it warned about', async () => {
    dueAutomations.mockResolvedValue([automation()])
    getSetting.mockImplementation(async (key: string) => (key === 'unaccounted:-100999' ? '2' : key === 'memory_sweep_day' ? today() : null))
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
    expect(setSetting).toHaveBeenCalledWith('unaccounted:-100999', '0')
  })

  it('spends what a custom automation read once its post has gone, and not when the model fails', async () => {
    const staged = [{ key: 'up_cursor:-100999:joint', at: '2026-09-24T01:00:00.000Z', ids: ['t1'], prev: null }]
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValueOnce({ text: 'CAFE $4.50', notices: [], model: 'primary:test', cursors: staged })
    await authed()
    expect(setSetting).toHaveBeenCalledWith('up_cursor:-100999:joint', expect.stringContaining('t1'))

    setSetting.mockClear()
    runAgent.mockRejectedValueOnce(new Error('429 quota'))
    await authed()
    expect(setSetting).not.toHaveBeenCalledWith('up_cursor:-100999:joint', expect.anything())
  })

  it('spends what a custom automation read with a PROBLEM, when it already wrote something unrepeatable on it', async () => {
    const staged = [{ key: 'mail_cursor:-100999:1:google', at: '2026-09-24T01:00:00.000Z', ids: ['m1'], prev: null }]
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValueOnce({ text: 'PROBLEM: read_email failed after adding to the list\nSKIP', notices: [], model: 'primary:test', cursors: staged, wrote: ['add_to_list'] })
    await authed()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('read_email failed'))
    expect(setSetting).toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.stringContaining('m1'))
  })

  it('spends it too when the hourly cap holds back a post it already wrote on, and gives an admin the draft', async () => {
    const staged = [{ key: 'mail_cursor:-100999:1:google', at: '2026-09-24T01:00:00.000Z', ids: ['m1'], prev: null }]
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValueOnce({ text: 'Added the permission slip to the list.', notices: [], model: 'primary:test', cursors: staged, wrote: ['add_to_list'] })
    const recent = Array.from({ length: 6 }, (_, i) => new Date(Date.now() - (i + 1) * 60_000).toISOString())
    getSetting.mockImplementation(async (key: string) =>
      key === 'proactive_posts:-100999' ? JSON.stringify({ posts: recent, cappedAt: new Date().toISOString() }) : key === 'memory_sweep_day' ? today() : null,
    )
    await authed()
    expect(send).not.toHaveBeenCalledWith('-100999', expect.anything())
    expect(setSetting).toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.stringContaining('m1'))
    expect(send).toHaveBeenCalledWith('900', expect.stringMatching(/hourly cap was reached after the run had already acted[\s\S]*Draft:\nAdded the permission slip/))
  })

  it('counts a custom automation that fails on what its model looked at, and moves past it in time', async () => {
    const look = { key: 'mail_cursor:-100999:1:google', at: '2026-09-24T01:00:00.000Z', ids: ['m1'], prev: null }
    const since = new Date(Date.now() - 20 * 3600_000).toISOString()
    dueAutomations.mockResolvedValue([automation()])
    const failure = new Error('the attachment cannot be read')
    runAgent.mockRejectedValueOnce(failure)
    looksBefore.mockImplementation((err) => (err === failure ? [look] : []))
    getSetting.mockImplementation(async (key: string) =>
      key === 'unspent:1' ? JSON.stringify({ [look.key]: { from: '-', since, runs: 2, move: look } }) : key === 'memory_sweep_day' ? today() : null,
    )
    await authed()
    expect(setSetting).toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.stringContaining('m1'))
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('**bin night** failed on the same new items 3 runs running'))
  })

  it('pauses an automation Telegram refuses the chat for, rather than failing every hour', async () => {
    const { GrammyError } = await import('grammy')
    dueAutomations.mockResolvedValue([automation({ chatId: '111' })])
    // The post is the first thing said, and Telegram turns the chat away.
    send.mockRejectedValueOnce(new GrammyError('Call to sendMessage failed!', { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 'sendMessage', {}))
    await authed()
    expect(send.mock.calls[0][0]).toBe('111')
    expect(setAutomationEnabled).toHaveBeenCalledWith(1, false)
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('Paused **bin night**: Telegram will not let me post in chat 111'))
  })

  it('pauses one Telegram will not let post in a group it has muted the bot in', async () => {
    const { GrammyError } = await import('grammy')
    dueAutomations.mockResolvedValue([automation()])
    send.mockRejectedValueOnce(new GrammyError('Call to sendMessage failed!', { ok: false, error_code: 400, description: 'Bad Request: have no rights to send a message' }, 'sendMessage', {}))
    await authed()
    expect(setAutomationEnabled).toHaveBeenCalledWith(1, false)
  })

  it('does not pause on a 400 that is about the message, not the chat', async () => {
    const { GrammyError } = await import('grammy')
    dueAutomations.mockResolvedValue([automation()])
    send.mockRejectedValueOnce(new GrammyError('Call to sendMessage failed!', { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }, 'sendMessage', {}))
    await authed()
    expect(setAutomationEnabled).not.toHaveBeenCalled()
  })

  it('reports an ordinary send failure without pausing anything', async () => {
    dueAutomations.mockResolvedValue([automation()])
    send.mockRejectedValueOnce(new Error('socket hang up'))
    await authed()
    expect(setAutomationEnabled).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('failed: socket hang up'))
  })

  it('reports a failing automation to an admin DM, never the chat, and keeps going', async () => {
    dueAutomations.mockResolvedValue([automation({ id: 1 }), automation({ id: 2 })])
    runAgent.mockRejectedValueOnce(new Error('model exploded'))
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('model exploded'))
    expect(send).not.toHaveBeenCalledWith('-100999', expect.stringContaining('model exploded'))
  })

  it('treats a failed admin lookup as no admins, and still logs that nobody could be told', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockRejectedValueOnce(new Error('model exploded'))
    allowedMembers.mockRejectedValueOnce(new Error('members table locked'))
    await authed()
    expect(send).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith('[tick] no admin reachable by DM:', expect.stringContaining('model exploded'))
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
    runAgent.mockResolvedValue({ text: 'SKIP', notices: ['Added to the family calendar: **Athletics carnival**'], model: 'primary:test' })
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', 'Added to the family calendar: **Athletics carnival**')
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
        { chatId: '-100999', authorName: 'Rowan', role: 'user', content: 'Bin night is Monday by the way' },
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
      // The tick still records its pulse; it is the day's claim that must not happen yet.
      expect(setSetting).not.toHaveBeenCalledWith('memory_sweep_day', expect.anything())
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

  it('logs when the nightly memory pass itself fails, without failing the tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T18:30:00Z')) // 4:30am in Melbourne
    try {
      getSetting.mockImplementation(async () => null)
      messagesSince.mockResolvedValue([
        { chatId: '-100999', authorName: 'Rowan', role: 'user', content: 'Bin night is Monday by the way' },
      ] as never)
      runAgent.mockRejectedValueOnce(new Error('model down'))
      const res = await authed()
      expect(res.status).toBe(200)
      expect(console.error).toHaveBeenCalledWith('[tick] memory pass failed:', expect.any(Error))
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

  it('checks the draft against the instruction, the facts the writer had and the tool results', async () => {
    runAgent.mockResolvedValue({
      text: 'Bins out tonight.', notices: [], model: 'primary:test',
      evidence: 'recall({}) -> {"memories":[]}', facts: 'Known household facts:\n- [4] bin night is Monday',
    })
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'bin night',
        draft: 'Bins out tonight.',
        evidence: expect.stringContaining('Remind everyone to put the bins out.'),
      }),
    )
    expect((decideWatcherPost.mock.calls[0][0] as { evidence: string }).evidence).toContain('recall({})')
    expect((decideWatcherPost.mock.calls[0][0] as { evidence: string }).evidence).toContain('- [4] bin night is Monday')
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
  })

  it('holds a draft back when the decision is skip, and tells an admin why, with the draft', async () => {
    decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.8, model: 'primary:test', reason: 'a time the evidence does not give' })
    await authed()
    expect(send).not.toHaveBeenCalledWith('-100999', expect.anything())
    expect(insertValues).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    const [to, text] = send.mock.calls[0]
    expect(to).toBe('900')
    expect(text).toContain('held back')
    expect(text).toContain('skip at 0.80: a time the evidence does not give')
    expect(text).toContain('Draft:\nBins out tonight.')
  })

  it('posts what the judge decided: the line is the judge\'s own, never a second one here', async () => {
    decideWatcherPost.mockResolvedValue({ decision: 'post', confidence: 0.63, model: 'jev:jev-latest' })
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
    expect(send).not.toHaveBeenCalledWith('900', expect.stringContaining('held back'))
  })

  it('posts the reviewed draft as written, never a retype from the decision', async () => {
    runAgent.mockResolvedValue({ text: '**Bins** out tonight.', notices: [], model: 'primary:test' })
    decideWatcherPost.mockResolvedValue({ decision: 'post', confidence: 0.95, message: 'Bins out tonight.', model: 'primary:test' })
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', '**Bins** out tonight.')
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

  it('tells the decision when the check went through the draft and passed every statement', async () => {
    reviewDraft.mockResolvedValue({ claims: ['bins tonight'], unsupported: [], message: 'Bins out tonight.' })
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ draft: 'Bins out tonight.', verified: true }))
  })

  it('leaves the full line standing when the check rewrote the draft, found nothing to check, or could not run', async () => {
    // A rewrite nobody has checked since, and a draft with nothing checkable
    // in it, are both drafts the finer check cannot vouch for.
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
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ verified: false }))
  })

  it('posts nothing when no claim survives the check, and tells an admin which failed', async () => {
    reviewDraft.mockResolvedValue({ claims: ['a trip to Lisbon'], unsupported: ['a trip to Lisbon'], message: null })
    await authed()
    expect(decideWatcherPost).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith('-100999', expect.anything())
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('no claim survived the check: a trip to Lisbon'))
  })

  it('falls back to deciding on the raw draft when the check itself fails', async () => {
    reviewDraft.mockRejectedValue(new Error('No object generated'))
    await authed()
    expect(decideWatcherPost).toHaveBeenCalledWith(expect.objectContaining({ draft: 'Bins out tonight.' }))
    expect(send).toHaveBeenCalledWith('-100999', 'Bins out tonight.')
  })

  it('never puts a tool notice through the decision', async () => {
    runAgent.mockResolvedValue({ text: 'SKIP', notices: ['Added to the family calendar: **Athletics carnival**'], model: 'primary:test' })
    await authed()
    expect(decideWatcherPost).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('-100999', 'Added to the family calendar: **Athletics carnival**')
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
      transactions: [{ description: 'FARESAVER LISBON', amount: '$389.60', when: 'Tue 26 Aug 2026, 14:02', status: 'SETTLED', by: 'Rowan' }],
    })
    runAgent.mockResolvedValue({ text: '2Up: **$389.60** FARESAVER LISBON, Tue 26 Aug. Purpose not recorded.', notices: [], model: 'primary:test' })
    await authed()
    const call = runAgent.mock.calls[0][0] as { mode: string; tools: string[]; text: string; chatType: string }
    expect(call.mode).toBe('watcher')
    expect(call.tools).toEqual(['recall', 'list_family_events', 'list_email'])
    expect(call.chatType).toBe('group')
    expect(call.text).toContain('FARESAVER LISBON')
    expect(call.text).toContain('purpose not recorded')
    expect(call.text).not.toContain('likely is')
    const decision = decideWatcherPost.mock.calls[0][0] as { evidence: string }
    expect(decision.evidence).toContain('$389.60')
    expect(send).toHaveBeenCalledWith('-100999', '2Up: **$389.60** FARESAVER LISBON, Tue 26 Aug. Purpose not recorded.')
  })

  it('tells an admin when the money fetch errors, and leaves the chat alone', async () => {
    dueAutomations.mockResolvedValue([money()])
    newTransactions.mockResolvedValue({ error: 'Up Bank is not configured.' })
    await authed()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('Up Bank is not configured'))
    expect(runAgent).not.toHaveBeenCalled()
  })

  const brief = (over: Partial<Automation> = {}) => automation({ kind: 'morning', label: 'Morning brief', ...over })
  const snapshot = (over: Partial<Automation> = {}) => automation({ kind: 'snapshot', label: 'Money snapshot', ...over })

  /** A brief whose mail fetch stages a cursor move on the run's context, as the real tool does. */
  /** Where the staged look starts from: the stored cursor it read, or none on a first look. */
  let stagedFrom: string | undefined
  beforeEach(() => {
    stagedFrom = undefined
  })
  const stagingMail = () =>
    buildTools.mockImplementationOnce(((ctx: { pendingCursors?: unknown[] }) => ({
      new_transactions: { execute: newTransactions },
      new_mail: {
        execute: async (...a: unknown[]) => {
          ctx.pendingCursors = [{ key: 'mail_cursor:-100999:1:google', at: '2026-09-24T01:00:00.000Z', ids: ['m1'], prev: stagedFrom ? { at: stagedFrom, ids: [] } : null }]
          return newMail(...a)
        },
      },
      list_family_events: { execute: listEvents },
      jira_board_summary: { execute: boardSummary },
      weather: { execute: weatherTool },
      spending_summary: { execute: spendingSummary },
      budget_summary: { execute: budgetSummary },
    })) as never)
  const mailWaiting = { accounts: [{ member: 'Rowan', mailbox: "Rowan's Gmail", provider: 'google', messages: [{ id: 'm1', from: 'School', subject: 'Excursion', snippet: 'Permission slip due Friday', date: '2026-09-24T00:30:00Z' }] }] }

  it('spends the mail it read only once the brief has gone out', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test' })
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', expect.stringContaining('permission slip'))
    expect(setSetting).toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.stringContaining('m1'))
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(
      setSetting.mock.invocationCallOrder[setSetting.mock.calls.findIndex(([k]) => k === 'mail_cursor:-100999:1:google')],
    )
  })

  it('leaves the mail for tomorrow when the model fails, rather than spending it unseen', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockRejectedValueOnce(new Error('429 quota'))
    await authed()
    expect(setSetting).not.toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.anything())
  })

  it('leaves it too when the post itself cannot be sent', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test' })
    // The brief's post is the first thing said, and Telegram refuses it.
    send.mockRejectedValueOnce(new Error('Telegram is down'))
    await authed()
    expect(send.mock.calls[0][0]).toBe('-100999')
    expect(setSetting).not.toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.anything())
  })

  it('spends it before the bookkeeping after the post, so a failed write there cannot bring the post round again', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test' })
    await authed()
    const order = (key: string) => setSetting.mock.invocationCallOrder[setSetting.mock.calls.findIndex(([k]) => String(k).startsWith(key))]
    expect(order('mail_cursor:')).toBeLessThan(order('proactive_posts:'))
  })

  it('leaves the mail new when the run could only report a PROBLEM', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockResolvedValue({ text: 'PROBLEM: read_email failed for the school message\nSKIP', notices: [], model: 'primary:test' })
    await authed()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('read_email failed'))
    expect(setSetting).not.toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.anything())
  })

  it('spends it on a plain SKIP, which is the run deciding there is nothing to say', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockResolvedValue({ text: 'SKIP', notices: [], model: 'primary:test' })
    await authed()
    expect(setSetting).toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.stringContaining('m1'))
  })

  it('spends it when the checks hold the draft back, since an admin has the draft', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test' })
    decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.9, model: 'primary:test', reason: 'a date the evidence does not give' })
    await authed()
    expect(send).not.toHaveBeenCalledWith('-100999', expect.anything())
    expect(setSetting).toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.stringContaining('m1'))
  })

  it('leaves it new when the hourly cap holds the post back, for the next run under the cap', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test' })
    const recent = Array.from({ length: 6 }, (_, i) => new Date(Date.now() - (i + 1) * 60_000).toISOString())
    getSetting.mockImplementation(async (key: string) =>
      key === 'proactive_posts:-100999' ? JSON.stringify({ posts: recent }) : key === 'memory_sweep_day' ? today() : null,
    )
    await authed()
    expect(send).not.toHaveBeenCalledWith('-100999', expect.anything())
    expect(setSetting).not.toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.anything())
    // The cap clears on its own, so it is not a run stuck on the mail.
    expect(setSetting).not.toHaveBeenCalledWith('unspent:1', expect.anything())
  })

  it('tells an admin when a post went out cut short by the output allowance', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test', cutShort: true })
    await authed()
    expect(send).toHaveBeenCalledWith('-100999', expect.stringContaining('permission slip'))
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('**Morning brief** ran out of room'))
  })

  describe('the stuck guard', () => {
    const KEY = 'mail_cursor:-100999:1:google'
    const HOUR = 3600_000
    const move = (ids: string[], at = '2026-09-24T01:00:00.000Z') => ({ key: KEY, at, ids, prev: null })
    const stuckAt = (entries: Record<string, unknown>) =>
      getSetting.mockImplementation(async (key: string) =>
        key === 'unspent:1' ? JSON.stringify(entries) : key === 'memory_sweep_day' ? today() : null,
      )
    const entry = (runs: number, hoursAgo: number, ids = ['m1']) => ({ from: '-', since: new Date(Date.now() - hoursAgo * HOUR).toISOString(), runs, move: move(ids) })
    const written = () => {
      const call = setSetting.mock.calls.findLast(([k]) => k === 'unspent:1')
      return call?.[1] ? JSON.parse(call[1]) : call ? {} : undefined
    }
    const problem = { text: 'PROBLEM: read_email failed for the school message\nSKIP', notices: [], model: 'primary:test' }
    beforeEach(() => {
      dueAutomations.mockResolvedValue([brief()])
      stagingMail()
      newMail.mockResolvedValue(mailWaiting)
    })

    it('counts a run that leaves the mail unspent, and says nothing more yet', async () => {
      runAgent.mockResolvedValue(problem)
      await authed()
      expect(written()[KEY]).toMatchObject({ from: '-', runs: 1, move: { ids: ['m1'] } })
      expect(setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
      expect(send).not.toHaveBeenCalledWith('900', expect.stringContaining('moved past'))
    })

    it('counts on from the last run when it is stuck at the same place, keeping when it started', async () => {
      const first = entry(1, 2)
      stuckAt({ [KEY]: first })
      runAgent.mockRejectedValueOnce(new Error('the attachment cannot be read'))
      await authed()
      expect(written()[KEY]).toEqual({ ...first, runs: 2 })
    })

    const apiError = (message: string, statusCode: number | undefined, isRetryable = false) =>
      new APICallError({ message, url: 'https://llm.test', requestBodyValues: {}, statusCode, isRetryable })
    const retried = (last: Error) => new RetryError({ message: `Failed after 3 attempts. Last error: ${last.message}`, reason: 'maxRetriesExceeded', errors: [last] })
    const grammy = (code: number, description: string) =>
      new GrammyError('Call to sendMessage failed!', { ok: false, error_code: code, description }, 'sendMessage', {})

    it.each([
      ['a rate limit', () => retried(apiError('Provider returned error', 429, true))],
      ['a gateway error', () => apiError('Bad Gateway', 502, true)],
      ['no credit left', () => apiError('Insufficient credits', 402)],
      ['a key the provider refuses', () => apiError('User not found.', 401)],
      ['a key Gemini answers a 400 for', () => apiError('API key not valid. Please pass a valid API key.', 400)],
      ['no connection', () => apiError('Cannot connect to API: connect ECONNREFUSED 10.0.0.1:443', undefined, true)],
      ['a step that timed out', () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
      ['Telegram flooded', () => grammy(429, 'Too Many Requests: retry after 5')],
      ['Telegram unreachable', () => new HttpError('Network request for sendMessage failed!', new Error('ECONNRESET'))],
      ['nothing configured', () => new Error('No LLM configured: set GEMINI_API_KEY, OPENROUTER_API_KEY, or LLM_BASE_URL + LLM_MODEL')],
    ])('does not count %s, which says nothing about the mail', async (_what, make) => {
      stuckAt({ [KEY]: entry(2, 20) })
      runAgent.mockRejectedValueOnce(make())
      await authed()
      expect(setSetting).not.toHaveBeenCalledWith('unspent:1', expect.anything())
      expect(setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
    })

    it.each([
      ['a request too long for the model, whose token count is no status code', () => retried(apiError('The input token count (1048576) exceeds the maximum number of tokens allowed (1048576).', 400))],
      ['a payload the provider will not take', () => apiError('Request Entity Too Large', 413)],
      ['a reply no model could finish', () => new Error('openrouter:minimax/minimax-m3:free returned no text')],
    ])('counts %s, which fails the same way every time', async (_what, make) => {
      stuckAt({ [KEY]: entry(2, 20) })
      runAgent.mockRejectedValueOnce(make())
      await authed()
      expect(setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
    })

    it('counts a post Telegram cannot parse, which would fail the same way next time', async () => {
      stuckAt({ [KEY]: entry(2, 20) })
      runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test' })
      send.mockRejectedValueOnce(grammy(400, "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 12"))
      await authed()
      expect(setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
    })

    it('does not count a PROBLEM that is a tool\'s service down or unset, only one about what was read', async () => {
      stuckAt({ [KEY]: entry(2, 20) })
      runAgent.mockResolvedValue({ text: 'PROBLEM: weather returned 503 Service Unavailable\nPROBLEM: Jira is not configured\nSKIP', notices: [], model: 'primary:test' })
      await authed()
      expect(setSetting).not.toHaveBeenCalledWith('unspent:1', expect.anything())

      stagingMail()
      runAgent.mockResolvedValue({ text: 'PROBLEM: weather returned 503\nPROBLEM: read_email failed for the school message\nSKIP', notices: [], model: 'primary:test' })
      await authed()
      expect(setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
    })

    it('forgets a count that has not got there in over a week', async () => {
      stuckAt({ [KEY]: entry(2, 9 * 24) })
      runAgent.mockResolvedValue(problem)
      await authed()
      expect(written()[KEY]).toMatchObject({ runs: 1 })
      expect(setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
    })

    it('moves a cursor held at a real place on no further than it has got since, naming the span', async () => {
      const from = '2026-09-22T21:00:00.000Z'
      const ahead = '2026-09-24T03:00:00.000Z'
      stagedFrom = from
      const first = { from, since: new Date(Date.now() - 20 * HOUR).toISOString(), runs: 2, move: { key: KEY, at: '2026-09-23T01:00:00.000Z', ids: ['m0'], prev: { at: from, ids: [] } } }
      // A chat turn has meanwhile moved the stored cursor on past the stuck move.
      getSetting.mockImplementation(async (key: string) =>
        key === 'unspent:1' ? JSON.stringify({ [KEY]: first })
        : key === KEY ? JSON.stringify({ at: ahead, ids: ['c1'] })
        : key === 'memory_sweep_day' ? today() : null,
      )
      runAgent.mockResolvedValue(problem)
      await authed()
      const spent = JSON.parse(setSetting.mock.calls.find(([k]) => k === KEY)![1])
      expect(spent.at).toBe(ahead)
      expect(spent.ids).toEqual(['c1', 'm0'])
      expect(send).toHaveBeenCalledWith('900', expect.stringMatching(/mail in a linked Gmail mailbox from Wed,? 23 Sept 2026,? 7:00\s?am to Wed,? 23 Sept 2026,? 11:00\s?am/))
    })

    it('starts the count again when the cursor is held somewhere new', async () => {
      stuckAt({ [KEY]: { ...entry(2, 20), from: '2026-09-20T00:00:00.000Z' } })
      runAgent.mockResolvedValue(problem)
      await authed()
      expect(written()[KEY]).toMatchObject({ from: '-', runs: 1 })
      expect(setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
    })

    it('does not move past three quick failures, only ones spread over hours', async () => {
      stuckAt({ [KEY]: entry(2, 2) })
      runAgent.mockResolvedValue(problem)
      await authed()
      expect(written()[KEY]).toMatchObject({ runs: 3 })
      expect(setSetting).not.toHaveBeenCalledWith(KEY, expect.anything())
    })

    it('moves past what the first stuck run saw, not what has arrived since, and tells an admin once', async () => {
      stuckAt({ [KEY]: entry(2, 20, ['m0']) })
      runAgent.mockResolvedValue(problem)
      await authed()
      const spent = setSetting.mock.calls.find(([k]) => k === KEY)
      expect(JSON.parse(spent![1]).ids).toEqual(['m0'])
      expect(setSetting).toHaveBeenCalledWith('unspent:1', '')
      const told = send.mock.calls.filter(([to, text]) => to === '900' && text.includes('moved past'))
      expect(told).toHaveLength(1)
      expect(told[0][1]).toContain('**Morning brief** failed on the same new items 3 runs running (the run reported a problem)')
      expect(told[0][1]).toContain('mail in a linked Gmail mailbox up to')
    })

    it('moves past on a third failure outright too, and still reports that failure', async () => {
      stuckAt({ [KEY]: entry(2, 20) })
      runAgent.mockRejectedValueOnce(new Error('the attachment cannot be read'))
      await authed()
      expect(setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
      expect(send).toHaveBeenCalledWith('900', expect.stringContaining('(the attachment cannot be read), so I have moved past them'))
      expect(send).toHaveBeenCalledWith('900', expect.stringContaining('failed: the attachment cannot be read'))
    })

    it('keeps each mailbox\'s count apart, so one whose fetch fails some runs neither resets nor rides on another', async () => {
      const other = 'mail_cursor:-100999:2:microsoft'
      const otherEntry = { ...entry(1, 1), move: { ...move(['o1']), key: other } }
      stuckAt({ [KEY]: entry(2, 20), [other]: otherEntry })
      runAgent.mockResolvedValue(problem)
      await authed()
      // Only this mailbox was looked at this run: it moves on, the other waits where it was.
      expect(setSetting).toHaveBeenCalledWith(KEY, expect.stringContaining('m1'))
      expect(setSetting).not.toHaveBeenCalledWith(other, expect.anything())
      expect(written()).toEqual({ [other]: otherEntry })
    })

    it('clears a cursor from the count once a run spends it', async () => {
      stuckAt({ [KEY]: entry(2, 20) })
      runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test' })
      await authed()
      expect(send).toHaveBeenCalledWith('-100999', expect.stringContaining('permission slip'))
      expect(setSetting).toHaveBeenCalledWith('unspent:1', '')
      expect(send).not.toHaveBeenCalledWith('900', expect.stringContaining('moved past'))
    })

    it('treats an unreadable count as none', async () => {
      getSetting.mockImplementation(async (key: string) => (key === 'unspent:1' ? '{not json' : key === 'memory_sweep_day' ? today() : null))
      runAgent.mockResolvedValue(problem)
      await authed()
      expect(written()[KEY]).toMatchObject({ runs: 1 })
    })

    it('keeps the run going when the guard itself cannot be written, and still posts when clearing fails', async () => {
      setSetting.mockImplementation(async (key: string) => {
        if (key === 'unspent:1') throw new Error('db down')
      })
      runAgent.mockRejectedValueOnce(new Error('the attachment cannot be read'))
      await authed()
      expect(console.error).toHaveBeenCalledWith('[tick] stuck guard failed:', expect.any(Error))
      expect(send).toHaveBeenCalledWith('900', expect.stringContaining('failed: the attachment cannot be read'))

      stuckAt({ [KEY]: entry(1, 1) })
      stagingMail()
      runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test' })
      await authed()
      expect(send).toHaveBeenCalledWith('-100999', expect.stringContaining('permission slip'))
      expect(console.error).toHaveBeenCalledWith('[tick] stuck guard failed:', 'db down')
    })
  })

  it('sets the first marker even on a quiet morning that needs no model', async () => {
    dueAutomations.mockResolvedValue([brief()])
    stagingMail()
    newMail.mockResolvedValue({ accounts: [{ member: 'Rowan', mailbox: "Rowan's Gmail", provider: 'google', first_check: true, messages: [] }] })
    await authed()
    expect(runAgent).not.toHaveBeenCalled()
    expect(setSetting).toHaveBeenCalledWith('mail_cursor:-100999:1:google', expect.anything())
  })

  it('asks for the whole day\'s events and a day\'s mail, with room to write it all', async () => {
    dueAutomations.mockResolvedValue([brief()])
    newMail.mockResolvedValue(mailWaiting)
    runAgent.mockResolvedValue({ text: '**To do**\n- School: permission slip due Friday.', notices: [], model: 'primary:test' })
    await authed()
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne' }).format(new Date())
    expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ from: day, to: day }), expect.anything())
    expect(newMail).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }), expect.anything())
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 2400 }))
  })

  it('sweeps every mailbox into the brief from a group and only the owner\'s from a DM', async () => {
    dueAutomations.mockResolvedValue([brief({ id: 1, chatId: '-100999' }), brief({ id: 2, chatId: '111' })])
    await authed()
    expect(newMail).toHaveBeenNthCalledWith(1, expect.objectContaining({ everyone: true }), expect.anything())
    expect(newMail).toHaveBeenNthCalledWith(2, expect.objectContaining({ everyone: false }), expect.anything())
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('briefs on new mail alone, with the mail tools, and asks whose mailbox it came from in a group', async () => {
    dueAutomations.mockResolvedValue([brief()])
    newMail.mockResolvedValue({
      accounts: [{ member: 'Sam', mailbox: "Sam's Outlook", provider: 'microsoft', first_check: false, messages: [{ id: 'm1', from: 'school', subject: 'Athletics carnival', snippet: 'Thu 15 Oct', date: '2026-09-01' }] }],
    })
    runAgent.mockResolvedValue({ text: 'Sam: school says the athletics carnival is Thu 15 Oct.', notices: [], model: 'primary:test' })
    await authed()
    const call = runAgent.mock.calls[0][0] as { tools: string[]; text: string }
    expect(call.tools).toEqual(['recall', 'read_email', 'propose_family_event', 'list_family_events'])
    expect(call.text).toContain('whose mailbox')
    expect(call.text).toContain('a person, never a provider')
    expect(call.text).toContain('Athletics carnival')
    expect(send).toHaveBeenCalledWith('-100999', 'Sam: school says the athletics carnival is Thu 15 Oct.')
  })

  it('hands the brief its mail as plain lines, so a quoted subject or sender reaches the model without escapes', async () => {
    dueAutomations.mockResolvedValue([brief()])
    newMail.mockResolvedValue({
      accounts: [{ member: 'Sam', mailbox: "Sam's Outlook", provider: 'microsoft', first_check: false, messages: [
        { id: 'm1', from: 'Sign Desk <no-reply@signdesk.example>', subject: 'Signature requested on "Lease renewal - 12 Elm Street"', snippet: 'Please sign by Friday.', date: '2026-09-18' },
      ] }],
    })
    await authed()
    const call = runAgent.mock.calls[0][0] as { text: string }
    expect(call.text).toContain('subject: Signature requested on "Lease renewal - 12 Elm Street"')
    expect(call.text).toContain('from: Sign Desk <no-reply@signdesk.example>')
    expect(call.text).not.toContain('\\"')
    expect(call.text).not.toContain('"subject":')
    const decision = decideWatcherPost.mock.calls[0][0] as { evidence: string }
    expect(decision.evidence).toContain('subject: Signature requested on "Lease renewal - 12 Elm Street"')
  })

  it('reports a broken mailbox to an admin but still phrases the rest', async () => {
    dueAutomations.mockResolvedValue([brief()])
    newMail.mockResolvedValue({
      accounts: [
        { member: 'Sam', mailbox: "Sam's Outlook", provider: 'microsoft', error: 'token revoked' },
        { member: 'Rowan', mailbox: "Rowan's Gmail", provider: 'google', first_check: false, messages: [{ id: 'm2', from: 'clinic', subject: 'Appointment', snippet: 'Fri', date: '2026-09-01' }] },
      ],
    })
    await authed()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining("new_mail (Sam's Outlook): token revoked"))
    expect(runAgent).toHaveBeenCalled()
  })

  it('treats nobody having linked a mailbox yet as a setting, not a fault', async () => {
    dueAutomations.mockResolvedValue([brief()])
    newMail.mockResolvedValue({ error: 'Nobody has linked a mailbox yet. Send /connect to link one.' })
    await authed()
    expect(send).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('skips the brief when nothing is on, nothing arrived and nothing is due, and treats missing integrations as settings', async () => {
    dueAutomations.mockResolvedValue([brief()])
    await authed()
    expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ include_cancelled: false }), expect.anything())
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('briefs the day when something is on, with weather included only when it worked', async () => {
    dueAutomations.mockResolvedValue([brief()])
    listEvents.mockResolvedValue({ events: [{ id: 1, title: 'Swimming', start_local: 'Wed 3 Sep 2026, 09:00' }] })
    weatherTool.mockResolvedValue({ place: 'Melbourne', now: { summary: 'Rain' } })
    runAgent.mockResolvedValue({ text: 'Swimming at 9am; take an umbrella, rain is forecast.', notices: [], model: 'primary:test' })
    await authed()
    const call = runAgent.mock.calls[0][0] as { text: string; tools: string[] }
    expect(call.text).toContain('Swimming')
    expect(call.text).toContain('Rain')
    expect(call.text).not.toContain('not configured')
    expect(call.tools).toEqual(['recall', 'read_email', 'propose_family_event', 'list_family_events'])
    expect(send).toHaveBeenCalledWith('-100999', 'Swimming at 9am; take an umbrella, rain is forecast.')
  })

  it('briefs on an overdue board item even with an empty calendar', async () => {
    dueAutomations.mockResolvedValue([brief()])
    boardSummary.mockResolvedValue({ project: 'HTL', open: 3, overdue: [{ key: 'HTL-344', summary: 'Pay rates' }] })
    await authed()
    expect(runAgent).toHaveBeenCalled()
    expect((runAgent.mock.calls[0][0] as { text: string }).text).toContain('HTL-344')
  })

  it("puts the nightly pass's open questions to the family in the group brief, once, even on an empty day", async () => {
    dueAutomations.mockResolvedValue([brief()])
    unaskedQuestions.mockResolvedValue([{ id: 7, question: "Who attends Hillside Grammar? A tuition notice was in Rowan's mail." }])
    runAgent.mockResolvedValue({ text: "Not sure about:\nWho attends Hillside Grammar? A tuition notice was in Rowan's mail.", notices: [], model: 'primary:test' })
    await authed()
    const call = runAgent.mock.calls[0][0] as { text: string }
    expect(call.text).toContain('Who attends Hillside Grammar?')
    expect(call.text).toContain('Not sure about')
    expect(send).toHaveBeenCalledWith('-100999', expect.stringContaining('Who attends Hillside Grammar?'))
    expect(markQuestionsAsked).toHaveBeenCalledWith([7])
  })

  it('keeps the questions for the group brief, not a personal one', async () => {
    dueAutomations.mockResolvedValue([brief({ chatId: '111' })])
    unaskedQuestions.mockResolvedValue([{ id: 7, question: 'Who attends Hillside Grammar?' }])
    await authed()
    expect(unaskedQuestions).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
    expect(markQuestionsAsked).not.toHaveBeenCalled()
  })

  it('treats a failed lookup of open questions as none, rather than failing the brief', async () => {
    dueAutomations.mockResolvedValue([brief()])
    listEvents.mockResolvedValue({ events: [{ id: 1, title: 'Swimming', start_local: 'Wed 3 Sep 2026, 09:00' }] })
    unaskedQuestions.mockRejectedValueOnce(new Error('questions table locked'))
    await authed()
    expect(runAgent).toHaveBeenCalled()
    expect(markQuestionsAsked).not.toHaveBeenCalled()
  })

  it('posts the money snapshot from PocketSmith, the week and the month so far with the budget', async () => {
    dueAutomations.mockResolvedValue([snapshot()])
    spendingSummary.mockImplementation(async ({ from, source }: { from?: string; source: string }) =>
      source === 'pocketsmith'
        ? { source, transactions: from ? 12 : 40, spent: from ? '$812.40' : '$3,120.00' }
        : { error: 'should not have fallen back' },
    )
    budgetSummary.mockResolvedValue({ expenses: { actual: '$3,120.00', forecast: '$5,000.00', used: '62%' }, period_progress: '15 of 30 days (50% of the month)' })
    runAgent.mockResolvedValue({ text: '**Week to Sun 15 Sep**\n| | |\n| --- | --- |\n| This week | $812.40 |', notices: [], model: 'primary:test' })
    await authed()
    const call = runAgent.mock.calls[0][0] as { tools: string[]; text: string }
    expect(call.tools).toEqual(['recall'])
    expect(call.text).toContain('$812.40')
    expect(call.text).toContain('$3,120.00')
    expect(call.text).toContain('62%')
    expect(call.text).not.toContain('fallen back')
    expect(spendingSummary).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith('-100999', expect.stringContaining('$812.40'))
  })

  it('falls back to the raw Up feed for the snapshot when PocketSmith is not configured', async () => {
    dueAutomations.mockResolvedValue([snapshot()])
    spendingSummary.mockImplementation(async ({ source }: { source: string }) =>
      source === 'pocketsmith' ? { error: 'PocketSmith is not configured.' } : { source: 'up', transactions: 9, spent: '$389.60' },
    )
    await authed()
    expect(spendingSummary).toHaveBeenCalledTimes(4)
    const call = runAgent.mock.calls[0][0] as { text: string }
    expect(call.text).toContain('$389.60')
    expect(call.text).not.toContain('not configured')
    expect(send).not.toHaveBeenCalledWith('900', expect.anything())
  })

  it('stays quiet on the snapshot when no bank is connected, or when no money moved', async () => {
    dueAutomations.mockResolvedValue([snapshot()])
    spendingSummary.mockResolvedValue({ error: 'Up Bank is not configured.' })
    await authed()
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    spendingSummary.mockResolvedValue({ source: 'pocketsmith', transactions: 0, spent: '$0.00' })
    await authed()
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('reports a bank that will not answer to an admin, and leaves the chat alone', async () => {
    dueAutomations.mockResolvedValue([snapshot()])
    spendingSummary.mockResolvedValue({ error: 'PocketSmith API 502' })
    await authed()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('spending_summary (week): PocketSmith API 502'))
    expect(runAgent).not.toHaveBeenCalled()
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

describe('the corners of a run', () => {
  beforeEach(() => {
    process.env.TICK_SECRET = 'let-me-in'
  })
  const authed = () => tick({ 'x-tick-secret': 'let-me-in' })

  it('reports a mail fetch that fails outright, with nothing left to phrase', async () => {
    dueAutomations.mockResolvedValue([automation({ kind: 'morning', label: 'Morning brief' })])
    newMail.mockResolvedValue({ error: 'Graph answered 503' })
    await authed()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('new_mail: Graph answered 503'))
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('reports a calendar or board failure in the morning brief, and stays quiet when nothing is left to say', async () => {
    dueAutomations.mockResolvedValue([automation({ kind: 'morning', label: 'Morning brief' })])
    listEvents.mockResolvedValue({ error: 'calendar down' })
    boardSummary.mockResolvedValue({ error: 'Jira API 500 on /search' })
    weatherTool.mockResolvedValue({ now: { temp: 12 } })
    await authed()
    expect(send).toHaveBeenCalledTimes(1)
    const [to, text] = send.mock.calls[0]
    expect(to).toBe('900')
    expect(text).toContain('list_family_events: calendar down')
    expect(text).toContain('jira_board_summary: Jira API 500 on /search')
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('cuts a long held-back draft short in the admin DM', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: 'x'.repeat(700), notices: [], model: 'primary:test' })
    decideWatcherPost.mockResolvedValue({ decision: 'skip', confidence: 0.9, model: 'primary:test' })
    await authed()
    const text = String(send.mock.calls[0][1])
    expect(text).toContain('x'.repeat(600) + '…')
    expect(text).not.toContain('x'.repeat(601))
  })

  it('copes with a tool that answers nothing at all', async () => {
    dueAutomations.mockResolvedValue([automation({ kind: 'money', label: '2Up transactions' })])
    newTransactions.mockResolvedValue(undefined)
    await expect((await authed()).json()).resolves.toEqual({ ok: true, ran: 1, skipped: 0 })
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses to run a tool with no execute callback, and reports the failure', async () => {
    dueAutomations.mockResolvedValue([automation({ kind: 'money', label: '2Up transactions' })])
    buildTools.mockReturnValueOnce({ new_transactions: {} })
    await authed()
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('new_transactions cannot run outside a model turn'))
  })

  it('phrases for a private chat when the automation lives in one', async () => {
    dueAutomations.mockResolvedValue([
      automation({ id: 1, chatId: '111' }),
      automation({ id: 2, chatId: '111', kind: 'money', label: '2Up transactions' }),
    ])
    newTransactions.mockResolvedValue({ account: '2Up', count: 1, transactions: [{ description: 'CAFE', amount: '$4.50', when: 'Mon', status: 'SETTLED' }] })
    await authed()
    expect(runAgent).toHaveBeenCalledTimes(2)
    for (const [input] of runAgent.mock.calls) expect((input as { chatType: string }).chatType).toBe('private')
  })

  it('routes a problem hidden in a tool notice to the admins, and swallows a bare SKIP notice', async () => {
    dueAutomations.mockResolvedValue([automation()])
    runAgent.mockResolvedValue({ text: 'SKIP', notices: ['SKIP\nPROBLEM: calendar unreachable', 'SKIP'], model: 'primary:test' })
    await authed()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('900', expect.stringContaining('PROBLEM: calendar unreachable'))
  })

  it('looks the creator up when the automation has one, and runs a watcher without them if they are gone', async () => {
    dueAutomations.mockResolvedValue([automation({ memberId: 9, kind: 'money', label: '2Up transactions' })])
    newTransactions.mockResolvedValue({ account: '2Up', count: 1, transactions: [{ description: 'CAFE', amount: '$4.50', when: 'Mon', status: 'SETTLED' }] })
    await authed()
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ member: null, memberName: 'the family' }))
  })

  it('logs retired proposals when there were any', async () => {
    retireStaleProposals.mockResolvedValue({ expired: 2, superseded: 1 })
    await authed()
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('proposals retired: 2 expired, 1 already on the calendar'))
  })

  it('logs when retiring stale proposals fails, without failing the tick', async () => {
    retireStaleProposals.mockRejectedValueOnce(new Error('proposals table locked'))
    const res = await authed()
    expect(res.status).toBe(200)
    expect(console.error).toHaveBeenCalledWith('[tick] could not retire stale proposals:', expect.any(Error))
  })

  it('writes the nightly transcript with the bot as you and a nameless sender as someone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T18:30:00Z')) // 4:30am in Melbourne
    try {
      getSetting.mockImplementation(async () => null)
      messagesSince.mockResolvedValue([
        { chatId: '-1', authorName: null, role: 'user', content: 'hello there' },
        { chatId: '-1', authorName: null, role: 'assistant', content: 'hi, how can I help' },
      ] as never)
      await authed()
      const call = runAgent.mock.calls.at(-1)![0] as { text: string }
      expect(call.text).toContain('[-1] someone: hello there')
      expect(call.text).toContain('[-1] you: hi, how can I help')
    } finally {
      vi.useRealTimers()
    }
  })
})
