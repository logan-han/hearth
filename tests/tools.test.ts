import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'

const listMail = vi.fn()
const readMail = vi.fn()
const sendMail = vi.fn()
const listEvents = vi.fn()
const createEvent = vi.fn()

const clientForIds: number[] = []
vi.mock('@/lib/providers', async (orig) => {
  const actual = await orig<typeof import('@/lib/providers')>()
  const stub = (provider: string) => ({ provider, listMail, readMail, sendMail, listEvents, createEvent })
  return {
    ...actual,
    clientFor: (id: number, p: string) => {
      clientForIds.push(id)
      return stub(p)
    },
    clientsFor: async () => [stub('google')],
  }
})

const { mailTools } = await import('@/lib/tools/mail')
const { calendarTools } = await import('@/lib/tools/calendar')
const { familyCalendarTools } = await import('@/lib/tools/familycal')
const { memoryTools } = await import('@/lib/tools/memory')
const { automationTools } = await import('@/lib/tools/automation')
const { searchTools } = await import('@/lib/tools/search')
const { requireMember } = await import('@/lib/tools/context')

let client: PGlite
let ctx: ToolContext

const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.han.life'
  client = (await freshDb()).client
  const member = await q.upsertMember('111', 'Logan', { allowed: true })
  ctx = { chatId: '-100', member, memberName: 'Logan', now: new Date('2026-08-27T00:00:00Z'), notices: [] }
  await q.saveConnection({ memberId: member.id, provider: 'google', email: 'a@b.com', refreshToken: 'r', scopes: null })
})
afterEach(async () => closeDb(client))

describe('requireMember', () => {
  it('explains what to do when the sender is unknown', () => {
    expect(() => requireMember({ ...ctx, member: null })).toThrow(/direct message/)
  })
})

describe('mail tools', () => {
  it('reads across every linked account', async () => {
    listMail.mockResolvedValue([{ id: 'm1', subject: 's', from: 'f', to: 't', snippet: '', date: '', unread: true }])
    const r = await call(mailTools(ctx), 'list_email', { limit: 5 })
    expect((r.accounts as { provider: string }[])[0].provider).toBe('google')
  })

  it('reports a provider failure per account rather than failing the lot', async () => {
    listMail.mockRejectedValue(new Error('Google API 429'))
    const r = await call(mailTools(ctx), 'list_email', { limit: 5 })
    expect(String((r.accounts as { error: string }[])[0].error)).toContain('429')
  })

  it('turns a missing link into advice, not an error', async () => {
    const { NotConnectedError } = await import('@/lib/providers/token')
    readMail.mockRejectedValue(new NotConnectedError('microsoft'))
    const r = await call(mailTools(ctx), 'read_email', { id: 'x', provider: 'microsoft' })
    expect(String(r.error)).toContain('/connect')
  })

  it('drafts without sending', async () => {
    const r = await call(mailTools(ctx), 'draft_email', { to: ['a@b.com'], subject: 's', body: 'b' })
    expect(r.draft_id).toBeDefined()
    expect(sendMail).not.toHaveBeenCalled()
    expect(String(r.next_step)).toContain('confirm')
  })

  it('refuses to send when the confirmation flag is false', async () => {
    const d = await call(mailTools(ctx), 'draft_email', { to: ['a@b.com'], subject: 's', body: 'b' })
    const r = await call(mailTools(ctx), 'send_email', { draft_id: d.draft_id, confirmed: false })
    expect(String(r.error)).toContain('Not sent')
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('sends a confirmed draft exactly once', async () => {
    sendMail.mockResolvedValue({ ok: true })
    const d = await call(mailTools(ctx), 'draft_email', { to: ['a@b.com', 'c@d.com'], subject: 's', body: 'b' })
    const first = await call(mailTools(ctx), 'send_email', { draft_id: d.draft_id, confirmed: true })
    expect(first.sent).toBe(true)
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ['a@b.com', 'c@d.com'] }))
    const second = await call(mailTools(ctx), 'send_email', { draft_id: d.draft_id, confirmed: true })
    expect(second.error).toBeDefined()
    expect(sendMail).toHaveBeenCalledTimes(1)
  })

  it('hands a draft back to pending when the send fails', async () => {
    sendMail.mockRejectedValue(new Error('smtp exploded'))
    const d = await call(mailTools(ctx), 'draft_email', { to: ['a@b.com'], subject: 's', body: 'b' })
    const r = await call(mailTools(ctx), 'send_email', { draft_id: d.draft_id, confirmed: true })
    expect(String(r.error)).toContain('smtp exploded')
    expect((await q.getDraft(Number(d.draft_id)))!.status).toBe('pending')
  })

  it('will not let one member send another member\'s draft', async () => {
    const d = await call(mailTools(ctx), 'draft_email', { to: ['a@b.com'], subject: 's', body: 'b' })
    const other = await q.upsertMember('222', 'Someone', { allowed: true })
    const r = await call(mailTools({ ...ctx, member: other }), 'send_email', { draft_id: d.draft_id, confirmed: true })
    expect(String(r.error)).toContain('drafted')
  })

  it('rejects an unknown draft id', async () => {
    expect(String((await call(mailTools(ctx), 'send_email', { draft_id: 999, confirmed: true })).error)).toContain('No draft')
  })

  it('cancels a pending draft once', async () => {
    const d = await call(mailTools(ctx), 'draft_email', { to: ['a@b.com'], subject: 's', body: 'b' })
    expect((await call(mailTools(ctx), 'cancel_draft', { draft_id: d.draft_id })).cancelled).toBe(true)
    expect((await call(mailTools(ctx), 'cancel_draft', { draft_id: d.draft_id })).error).toBeDefined()
  })
})

describe('draft_email supersedes its own revisions', () => {
  const draft = (to: string[], subject: string) =>
    call(mailTools(ctx), 'draft_email', { to, subject, body: 'text' })

  it('cancels the previous pending draft to the same people', async () => {
    const first = await draft(['a@x.com'], 'v1')
    const second = await draft(['A@x.com '], 'v2')
    expect(second.superseded).toEqual([first.draft_id])
    expect((await q.getDraft(first.draft_id as number))!.status).toBe('cancelled')
    expect((await q.getDraft(second.draft_id as number))!.status).toBe('pending')
  })

  it('leaves a pending draft to different people alone', async () => {
    const first = await draft(['a@x.com'], 'one')
    const other = await draft(['b@y.com'], 'two')
    expect(other.superseded).toBeUndefined()
    expect((await q.getDraft(first.draft_id as number))!.status).toBe('pending')
  })
})

describe('read_email across the family', () => {
  it("opens another member's mailbox when told whose it is", async () => {
    const ada = await q.upsertMember('222', 'Ada', { allowed: true })
    readMail.mockResolvedValue({ id: 'm1', subject: 'S', body: 'B' })
    clientForIds.length = 0
    const r = await call(mailTools(ctx), 'read_email', { id: 'm1', provider: 'microsoft', of: 'ada' })
    expect(r.body).toBe('B')
    expect(clientForIds.at(-1)).toBe(ada.id)
  })

  it('refuses to read another member\'s mail in front of strangers', async () => {
    await q.upsertMember('222', 'Ada', { allowed: true })
    await q.rememberChat('-100', 'group', 'Family')
    await q.noteStranger('-100', { id: '9', name: 'Guest' })
    const r = await call(mailTools(ctx), 'read_email', { id: 'm1', provider: 'microsoft', of: 'Ada' })
    expect(String(r.error)).toContain('unrecognised')
  })

  it('knows nobody by a name that is not in the family', async () => {
    const r = await call(mailTools(ctx), 'read_email', { id: 'm1', provider: 'google', of: 'Nobody' })
    expect(String(r.error)).toContain('Nobody')
  })
})

describe('new_mail', () => {
  const mail = (id: string, hoursAgo: number, subject = 'S') => ({
    id, from: 'school@x.edu', to: 'me@x.com', subject,
    snippet: '…', date: new Date(Date.parse('2026-08-27T00:00:00Z') - hoursAgo * 3600_000).toISOString(),
    unread: true,
  })

  it('reaches back only a few hours on the first look', async () => {
    listMail.mockResolvedValue([mail('a', 2), mail('b', 20)])
    const r = await call(mailTools(ctx), 'new_mail', { limit: 10 })
    const acct = (r.accounts as { first_check: boolean; messages: { id: string }[] }[])[0]
    expect(acct.first_check).toBe(true)
    expect(acct.messages.map((m) => m.id)).toEqual(['a'])
  })

  it('never reports the same message twice', async () => {
    listMail.mockResolvedValue([mail('a', 2)])
    await call(mailTools(ctx), 'new_mail', { limit: 10 })
    const again = await call(mailTools(ctx), 'new_mail', { limit: 10 })
    expect((again.accounts as { messages: unknown[] }[])[0].messages).toEqual([])
  })

  it('reports only what arrived since the last look', async () => {
    listMail.mockResolvedValue([mail('a', 2)])
    await call(mailTools(ctx), 'new_mail', { limit: 10 })
    listMail.mockResolvedValue([mail('fresh', 1), mail('a', 2)])
    const r = await call(mailTools(ctx), 'new_mail', { limit: 10 })
    expect((r.accounts as { messages: { id: string }[] }[])[0].messages.map((m) => m.id)).toEqual(['fresh'])
  })

  it('keeps a message with an unreadable date rather than losing it', async () => {
    listMail.mockResolvedValue([{ ...mail('odd', 1), date: 'not a date' }])
    const r = await call(mailTools(ctx), 'new_mail', { limit: 10 })
    expect((r.accounts as { messages: { id: string }[] }[])[0].messages.map((m) => m.id)).toEqual(['odd'])
    const again = await call(mailTools(ctx), 'new_mail', { limit: 10 })
    expect((again.accounts as { messages: unknown[] }[])[0].messages).toEqual([])
  })

  it('sweeps every allowed member with everyone set, each on their own cursor', async () => {
    await q.upsertMember('222', 'Ada', { allowed: true })
    listMail.mockResolvedValue([mail('a', 2)])
    const r = await call(mailTools(ctx), 'new_mail', { limit: 10, everyone: true })
    const accounts = r.accounts as { member: string; messages: { id: string }[] }[]
    expect(accounts.map((a) => a.member).sort()).toEqual(['Ada', 'Logan'])
    expect(accounts.every((a) => a.messages.length === 1)).toBe(true)
    const again = await call(mailTools(ctx), 'new_mail', { limit: 10, everyone: true })
    expect((again.accounts as { messages: unknown[] }[]).every((a) => a.messages.length === 0)).toBe(true)
  })

  it('refuses a family-wide sweep while a stranger is in the room', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await q.noteStranger('-100', { id: '9', name: 'Guest' })
    const r = await call(mailTools(ctx), 'new_mail', { limit: 10, everyone: true })
    expect(String(r.error)).toContain('unrecognised')
  })
})

describe('calendar tools', () => {
  it('reads a window as Melbourne local time', async () => {
    listEvents.mockResolvedValue([])
    await call(calendarTools(ctx), 'list_calendar', { from: '2026-08-27T00:00', to: '2026-08-28T00:00' })
    // 27 Aug is AEST, so local midnight is 14:00 UTC the day before.
    expect((listEvents.mock.calls[0][0] as Date).toISOString()).toBe('2026-08-26T14:00:00.000Z')
  })

  it('renders each event with a local time alongside the raw one', async () => {
    listEvents.mockResolvedValue([{ id: 'e', title: 'X', start: '2026-08-27T00:00:00Z', end: '', allDay: false }])
    const r = await call(calendarTools(ctx), 'list_calendar', { from: '2026-08-27T00:00', to: '2026-08-28T00:00' })
    const acct = (r.accounts as { events: { start_local: string }[] }[])[0]
    expect(acct.events[0].start_local).toMatch(/Aug/)
  })

  it('defaults an event to one hour', async () => {
    createEvent.mockResolvedValue({ id: 'e', title: 'T', start: '', end: '', allDay: false })
    await call(calendarTools(ctx), 'create_calendar_event', { title: 'T', start: '2026-08-27T09:00', all_day: false })
    const arg = createEvent.mock.calls[0][0] as { start: Date; end: Date }
    expect(arg.end.getTime() - arg.start.getTime()).toBe(3_600_000)
  })

  it('surfaces a create failure', async () => {
    createEvent.mockRejectedValue(new Error('calendar full'))
    const r = await call(calendarTools(ctx), 'create_calendar_event', { title: 'T', start: '2026-08-27T09:00', all_day: false })
    expect(String(r.error)).toContain('calendar full')
  })

  it('reports one account failing without sinking the reply', async () => {
    listEvents.mockRejectedValue(new Error('Graph said 503'))
    const r = await call(calendarTools(ctx), 'list_calendar', { from: '2026-08-27T00:00', to: '2026-08-28T00:00' })
    expect(String((r.accounts as { error?: string }[])[0].error)).toContain('Graph said 503')
  })

  it('turns a missing link into the /connect nudge', async () => {
    const { NotConnectedError } = await import('@/lib/providers/token')
    listEvents.mockRejectedValue(new NotConnectedError('google'))
    const r = await call(calendarTools(ctx), 'list_calendar', { from: '2026-08-27T00:00', to: '2026-08-28T00:00' })
    expect(String((r.accounts as { error?: string }[])[0].error)).toContain('/connect')
  })

  it('creates on the named provider, honouring an explicit end', async () => {
    createEvent.mockResolvedValue({ id: 'e', title: 'T', start: '', end: '', allDay: false })
    const r = await call(calendarTools(ctx), 'create_calendar_event', {
      title: 'T', start: '2026-08-27T09:00', end: '2026-08-27T11:30', all_day: false, provider: 'microsoft',
    })
    expect(r.provider).toBe('microsoft')
    const arg = createEvent.mock.calls[0][0] as { start: Date; end: Date }
    expect(arg.end.getTime() - arg.start.getTime()).toBe(2.5 * 3_600_000)
  })

  it('shows an event that has no start time without inventing one', async () => {
    listEvents.mockResolvedValue([{ id: 'e', title: 'X', start: '', end: '', allDay: true }])
    const r = await call(calendarTools(ctx), 'list_calendar', { from: '2026-08-27T00:00', to: '2026-08-28T00:00' })
    expect((r.accounts as { events: { start_local: string }[] }[])[0].events[0].start_local).toBe('')
  })
})

describe('family calendar tools', () => {
  it('adds an event and announces it, because feeds refresh slowly', async () => {
    const r = await call(familyCalendarTools(ctx), 'add_family_event', { title: 'Soccer', start: '2026-08-29T09:00', all_day: false })
    expect(r.id).toBeDefined()
    expect(ctx.notices.join(' ')).toContain('Soccer')
    expect(String(r.note)).toContain('few hours')
  })

  it('gives an all-day event a whole day', async () => {
    await call(familyCalendarTools(ctx), 'add_family_event', { title: 'Trip', start: '2026-08-29', all_day: true })
    const [e] = await q.listFamilyEvents(new Date('2026-01-01'), new Date('2027-01-01'))
    expect(e.endsAt.getTime() - e.startsAt.getTime()).toBe(86_400_000)
  })

  it('treats a date with no time as all-day, never a midnight event', async () => {
    const r = await call(familyCalendarTools(ctx), 'add_family_event', {
      title: 'Pupil-free day', start: '2026-08-31', all_day: false,
    })
    expect(r.all_day).toBe(true)
    const [e] = await q.listFamilyEvents(new Date('2026-08-30'), new Date('2026-09-01'))
    expect(e.allDay).toBe(true)
    expect(e.endsAt.getTime() - e.startsAt.getTime()).toBe(86_400_000)
  })

  it('refuses to add the same event twice', async () => {
    const first = await call(familyCalendarTools(ctx), 'add_family_event', {
      title: 'Soccer', start: '2026-08-29T09:00', all_day: false,
    })
    const again = await call(familyCalendarTools(ctx), 'add_family_event', {
      title: 'soccer', start: '2026-08-29T09:00', all_day: false,
    })
    expect(again.already_on_calendar).toBe(true)
    expect(again.id).toBe(first.id)
    expect(await q.listFamilyEvents(new Date('2026-08-01'), new Date('2026-09-30'))).toHaveLength(1)
  })

  it('lets a cancelled event be added afresh', async () => {
    const a = await call(familyCalendarTools(ctx), 'add_family_event', {
      title: 'Soccer', start: '2026-08-29T09:00', all_day: false,
    })
    await call(familyCalendarTools(ctx), 'cancel_family_event', { id: a.id })
    const again = await call(familyCalendarTools(ctx), 'add_family_event', {
      title: 'Soccer', start: '2026-08-29T09:00', all_day: false,
    })
    expect(again.already_on_calendar).toBeUndefined()
    expect(again.id).not.toBe(a.id)
  })

  it('can show cancelled events, to explain a stale subscribed calendar', async () => {
    const a = await call(familyCalendarTools(ctx), 'add_family_event', {
      title: 'Gone', start: '2026-08-29T09:00', all_day: false,
    })
    await call(familyCalendarTools(ctx), 'cancel_family_event', { id: a.id })
    const r = await call(familyCalendarTools(ctx), 'list_family_events', {
      from: '2026-08-01', to: '2026-09-30', include_cancelled: true,
    })
    expect((r.events as Record<string, unknown>[])[0]).toMatchObject({ title: 'Gone', cancelled: true })
  })

  it('lists what is on, hiding cancellations', async () => {
    const a = await call(familyCalendarTools(ctx), 'add_family_event', { title: 'Gone', start: '2026-08-29T09:00', all_day: false })
    await call(familyCalendarTools(ctx), 'add_family_event', { title: 'Stays', start: '2026-08-30T09:00', all_day: false })
    await call(familyCalendarTools(ctx), 'cancel_family_event', { id: a.id })
    const r = await call(familyCalendarTools(ctx), 'list_family_events', { from: '2026-08-01', to: '2026-09-30' })
    expect((r.events as { title: string }[]).map((e) => e.title)).toEqual(['Stays'])
  })

  it('refuses to cancel something that is not there', async () => {
    expect((await call(familyCalendarTools(ctx), 'cancel_family_event', { id: 999 })).error).toBeDefined()
  })

  it('hands back a subscribable feed url', async () => {
    const r = await call(familyCalendarTools(ctx), 'family_calendar_link', {})
    expect(String(r.url)).toMatch(/^https:\/\/hearth\.han\.life\/api\/calendar\/.+\/family\.ics$/)
  })
})

describe('memory tools', () => {
  it('stores, filters and forgets', async () => {
    await call(memoryTools(ctx), 'remember', { fact: 'bin night is Monday' })
    await call(memoryTools(ctx), 'remember', { fact: 'Ada is allergic to peanuts' })
    const filtered = await call(memoryTools(ctx), 'recall', { contains: 'BIN' })
    expect(filtered.memories).toHaveLength(1)
    const all = await call(memoryTools(ctx), 'recall', {})
    expect(all.memories).toHaveLength(2)
    await call(memoryTools(ctx), 'forget', { id: (filtered.memories as { id: number }[])[0].id })
    expect((await call(memoryTools(ctx), 'recall', {})).memories).toHaveLength(1)
  })
})

describe('automation tools', () => {
  it('creates one and reports the next run in local time', async () => {
    const r = await call(automationTools(ctx), 'create_automation', { label: 'bins', cron: '0 19 * * 1', instruction: 'remind' })
    expect(r.id).toBeDefined()
    expect(r.timezone).toBe('Australia/Melbourne')
    expect(String(r.next_run_local)).toMatch(/7:00 pm/)
  })

  it('rejects a cron it cannot parse', async () => {
    const r = await call(automationTools(ctx), 'create_automation', { label: 'x', cron: 'every monday', instruction: 'i' })
    expect(String(r.error)).toContain('not a valid')
  })

  it('lists only this chat, pauses and resumes', async () => {
    const a = await call(automationTools(ctx), 'create_automation', { label: 'bins', cron: '0 19 * * 1', instruction: 'i' })
    await call(automationTools({ ...ctx, chatId: 'elsewhere' }), 'create_automation', { label: 'other', cron: '0 8 * * *', instruction: 'i' })
    expect((await call(automationTools(ctx), 'list_automations', {})).automations).toHaveLength(1)

    const paused = await call(automationTools(ctx), 'pause_automation', { id: a.id, enabled: false })
    expect(paused.next_run_local).toBeNull()
    const resumed = await call(automationTools(ctx), 'pause_automation', { id: a.id, enabled: true })
    expect(resumed.next_run_local).not.toBeNull()
    expect((await q.getAutomation(Number(a.id)))!.enabled).toBe(true)
  })

  it('reports an unknown id rather than pretending', async () => {
    expect((await call(automationTools(ctx), 'pause_automation', { id: 999, enabled: true })).error).toBeDefined()
    expect((await call(automationTools(ctx), 'delete_automation', { id: 999 })).error).toBeDefined()
  })

  it('deletes', async () => {
    const a = await call(automationTools(ctx), 'create_automation', { label: 'bins', cron: '0 19 * * 1', instruction: 'i' })
    expect((await call(automationTools(ctx), 'delete_automation', { id: a.id })).deleted).toBe(a.id)
  })
})

describe('web search', () => {
  const fetchMock = vi.fn()
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset() })
  afterEach(() => vi.unstubAllGlobals())

  it('says so when no key is configured', async () => {
    delete process.env.TAVILY_API_KEY
    expect(String((await call(searchTools, 'web_search', { query: 'x', depth: 'basic' })).error)).toContain('TAVILY_API_KEY')
  })

  it('returns the answer and trimmed extracts', async () => {
    process.env.TAVILY_API_KEY = 'tvly'
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ answer: 'It is 21 degrees.', results: [{ title: 'T', url: 'u', content: 'x'.repeat(900) }] }),
    })
    const r = await call(searchTools, 'web_search', { query: 'weather', depth: 'advanced' })
    expect(r.answer).toBe('It is 21 degrees.')
    expect((r.results as { extract: string }[])[0].extract).toHaveLength(600)
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)).search_depth).toBe('advanced')
  })

  it('reports a failed search with its status', async () => {
    process.env.TAVILY_API_KEY = 'tvly'
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' })
    expect(String((await call(searchTools, 'web_search', { query: 'x', depth: 'basic' })).error)).toContain('401')
  })
})
