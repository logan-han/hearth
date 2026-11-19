import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'
import { commitCursors } from '@/lib/tools/cursor'
import { localDateKey, dayAfter, daysAfter, localToUtc } from '@/lib/cron'

// The mailbox and calendar behind the brief, answering with whatever a test sets.
const listMail = vi.fn()
const listEvents = vi.fn()
const stub = (provider: string) => ({ provider, listMail, listEvents })
const linked = vi.fn(async (_id: number) => [stub('google')])
vi.mock('@/lib/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/providers')>()),
  clientFor: (_id: number, p: string) => stub(p),
  clientsFor: (id: number) => linked(id),
}))

// PocketSmith, switched on and answering only where a test says so.
const ps = vi.hoisted(() => ({
  pocketsmithConfigured: vi.fn(() => false),
  listTransactions: vi.fn(async () => [] as unknown[]),
  budgetSummary: vi.fn(),
  budgetByCategory: vi.fn(async () => [] as unknown[]),
}))
vi.mock('@/lib/providers/pocketsmith', async (orig) => ({ ...(await orig<typeof import('@/lib/providers/pocketsmith')>()), ...ps }))

const { assembleBrief, gatherBrief, gatherSnapshot, remindersBetween, errorOf, isUnconfigured, isUnlinked, LOOK_AHEAD_DAYS } = await import('@/lib/brief')
const { briefTools, BRIEF_GUIDE, SNAPSHOT_GUIDE } = await import('@/lib/tools/brief')
const { mailTools } = await import('@/lib/tools/mail')

type BriefInput = Parameters<typeof assembleBrief>[0]

/** What was fetched on a quiet Tuesday, with `over` laid on top. */
function fetched(over: Partial<BriefInput> = {}): BriefInput {
  return {
    day: '2026-09-15',
    next: '2026-09-16',
    horizon: '2026-09-28',
    events: { events: [] },
    tomorrowEvents: { events: [] },
    comingEvents: { events: [] },
    calendars: { accounts: [] },
    mail: { accounts: [] },
    board: { overdue: [], due_today: [], due_next: [] },
    weather: { summary: 'Fine' },
    proposals: { proposals: [] },
    questions: [],
    reminders: [],
    ...over,
  }
}

describe('assembleBrief', () => {
  it('has nothing to tell on a day with nothing new', () => {
    const brief = assembleBrief(fetched())
    expect(brief.empty).toBe(true)
    expect(brief.problems).toEqual([])
    expect(brief.asked).toEqual([])
  })

  it('reports a family calendar that failed once, not once per lookup, and leaves its events out', () => {
    const down = { error: 'family calendar down' }
    const brief = assembleBrief(fetched({ events: down, tomorrowEvents: down, comingEvents: down }))
    expect(brief.problems).toEqual(['list_family_events: family calendar down'])
    expect(brief.data).not.toHaveProperty('events')
  })

  it('reports each family calendar lookup that failed its own way', () => {
    const brief = assembleBrief(fetched({ tomorrowEvents: { error: 'tomorrow down' }, comingEvents: { error: 'later down' } }))
    expect(brief.problems).toEqual(['list_family_events (tomorrow): tomorrow down', 'list_family_events (coming): later down'])
  })

  it('takes nothing linked as a setting, not a fault, and a calendar that will not answer as one', () => {
    const unlinked = assembleBrief(fetched({ calendars: { error: "No calendar linked. Link one on Hearth's Connect page: https://hearth.example/connect." } }))
    expect(unlinked.problems).toEqual([])
    expect(unlinked.data).not.toHaveProperty('calendars')
    const down = assembleBrief(fetched({ calendars: { error: 'Graph said 503' } }))
    expect(down.problems).toEqual(['list_calendar: Graph said 503'])
    const one = assembleBrief(fetched({ calendars: { accounts: [{ calendar: "Rowan's Outlook Calendar", provider: 'microsoft', error: 'timed out' }] } }))
    expect(one.problems).toEqual(["list_calendar (Rowan's Outlook Calendar): timed out"])
    const nameless = assembleBrief(fetched({ calendars: { accounts: [{ provider: 'google', error: 'timed out' }] } }))
    expect(nameless.problems).toEqual(['list_calendar (google): timed out'])
  })

  it('lists an event on today and tomorrow once, under today', () => {
    const camp = { id: 7, title: 'Camp' }
    const brief = assembleBrief(fetched({ events: { events: [camp] }, tomorrowEvents: { events: [camp] } }))
    expect(brief.data.events).toEqual({ events: [camp] })
    expect(brief.data).not.toHaveProperty('tomorrow')
    expect(brief.empty).toBe(false)
  })

  it('names a mailbox that failed in problems and hands on only those that answered', () => {
    const mail = {
      accounts: [
        { mailbox: "Rowan's Outlook", provider: 'microsoft', error: 'timed out' },
        { mailbox: "Rowan's Gmail", provider: 'google', messages: [{ subject: 'Excursion form' }] },
      ],
    }
    const brief = assembleBrief(fetched({ mail }))
    expect(brief.problems).toEqual(["new_mail (Rowan's Outlook): timed out"])
    expect(brief.data.mail).toEqual({ accounts: [{ mailbox: "Rowan's Gmail", provider: 'google', messages: [{ subject: 'Excursion form' }] }] })
    expect(brief.empty).toBe(false)
  })

  it('takes no mailbox linked as a setting, and one that will not answer at all as a fault', () => {
    expect(assembleBrief(fetched({ mail: { error: "No email account linked. Link one on Hearth's Connect page: x." } })).problems).toEqual([])
    const down = assembleBrief(fetched({ mail: { error: 'Gmail said 500' } }))
    expect(down.problems).toEqual(['new_mail: Gmail said 500'])
    expect(down.data).not.toHaveProperty('mail')
    // A shape with no accounts is handed on as it came.
    expect(assembleBrief(fetched({ mail: { odd: true } })).data.mail).toEqual({ odd: true })
  })

  it('splits the calendars by when each event starts: today, tomorrow and the fortnight', () => {
    const calendars = {
      accounts: [{
        calendar: "Rowan's Google Calendar",
        provider: 'google',
        events: [
          { id: 'a', title: 'Camp day 3', start: '2026-09-13', allDay: true },
          { id: 'b', title: 'Dentist', start: localToUtc('2026-09-15T09:00').toISOString() },
          { id: 'c', title: 'Flight', start: localToUtc('2026-09-16T07:00').toISOString() },
          { id: 'd', title: 'Swim', start: localToUtc('2026-09-21T16:00').toISOString() },
          { id: 'e', title: 'No start' },
        ],
      }, { calendar: 'empty', provider: 'microsoft' }],
    }
    const brief = assembleBrief(fetched({ calendars }))
    const today = (brief.data.calendars as { accounts: { events: { id: string }[] }[] }).accounts
    expect(today[0].events.map((e) => e.id)).toEqual(['a', 'b', 'e'])
    expect((brief.data.tomorrow as { calendars: { events: { id: string }[] }[] }).calendars[0].events.map((e) => e.id)).toEqual(['c'])
    expect((brief.data.coming as { calendars: { events: { id: string }[] }[] }).calendars[0].events.map((e) => e.id)).toEqual(['d'])
    expect(brief.empty).toBe(false)
  })

  it("brings tomorrow's family events, the fortnight's, the board's dates and the reminders, each in its place", () => {
    const brief = assembleBrief(fetched({
      tomorrowEvents: { events: [{ id: 2, title: 'Excursion' }] },
      comingEvents: { events: [{ id: 3, title: 'Fete' }] },
      board: { overdue: [{ key: 'HTL-1' }], due_today: [], due_next: [{ key: 'HTL-2', due: '2026-09-20' }, { key: 'HTL-3', due: '2026-10-30' }, { key: 'HTL-4' }] },
      reminders: [{ label: 'bins', at: '7:00 pm', date: '2026-09-15' }, { label: 'rates', at: 'Thu 17 Sept, 9:00 am', date: '2026-09-17' }],
      proposals: { proposals: [{ id: 9, title: 'Disco' }] },
      questions: [{ id: 4, question: 'Who is at Hillside?' }],
    }))
    expect(brief.data.tomorrow).toMatchObject({ events: [{ id: 2, title: 'Excursion' }] })
    expect(brief.data.coming).toMatchObject({ events: [{ id: 3, title: 'Fete' }], board: [{ key: 'HTL-2', due: '2026-09-20' }], reminders: [{ label: 'rates', at: 'Thu 17 Sept, 9:00 am' }] })
    expect(brief.data.reminders).toEqual([{ label: 'bins', at: '7:00 pm' }])
    expect(brief.data.board).toMatchObject({ overdue: [{ key: 'HTL-1' }], due_next: undefined })
    expect(brief.data.proposals).toEqual([{ id: 9, title: 'Disco' }])
    expect(brief.data.questions).toEqual([{ id: 4, question: 'Who is at Hillside?' }])
    expect(brief.asked).toEqual([4])
    expect(brief.empty).toBe(false)
  })

  it('reports a board or weather that will not answer, and takes either unconfigured as a setting', () => {
    expect(assembleBrief(fetched({ board: { error: 'Jira is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).' }, weather: { error: 'Weather is not configured (OPENWEATHER_API_KEY missing).' } })).problems).toEqual([])
    const down = assembleBrief(fetched({ board: { error: 'Jira API 502' }, weather: { error: 'OWM 500' } }))
    expect(down.problems).toEqual(['jira_board_summary: Jira API 502', 'weather: OWM 500'])
    expect(down.data).not.toHaveProperty('board')
    expect(down.data).not.toHaveProperty('weather')
  })

  it('tells a setting from a fault by its words', () => {
    expect(errorOf({ error: 'x' })).toBe('x')
    expect(errorOf({ error: 3 })).toBeNull()
    expect(isUnconfigured('PocketSmith is not configured.')).toBe(true)
    expect(isUnconfigured(null)).toBe(false)
    expect(isUnlinked('No calendar linked. Link one on the dashboard.')).toBe(true)
    expect(isUnlinked('No email account linked.')).toBe(true)
    expect(isUnlinked('timed out')).toBe(false)
    expect(isUnlinked(null)).toBe(false)
  })
})

describe('gathering on demand', () => {
  let client: PGlite
  let ctx: ToolContext
  const now = new Date()
  const day = localDateKey(now)
  const horizon = daysAfter(day, LOOK_AHEAD_DAYS)

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
    process.env.APP_URL = 'https://hearth.example'
    delete process.env.OPENWEATHER_API_KEY
    delete process.env.JIRA_BASE_URL
    ps.pocketsmithConfigured.mockReturnValue(false)
    client = (await freshDb()).client
    const member = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
    ctx = { member, memberName: 'Rowan', now, via: 'mcp', cursorScope: 'key:1' }
    listMail.mockResolvedValue([])
    listEvents.mockResolvedValue({ events: [], more: false })
  })
  afterEach(async () => closeDb(client))

  describe('gatherBrief', () => {
    it('asks for the day, tomorrow and the fortnight, a day of mail, the board, the weather and the proposals', async () => {
      const asked: [string, unknown][] = []
      const run = async (name: string, args: Record<string, unknown>) => {
        asked.push([name, args])
        return {}
      }
      const brief = await gatherBrief(ctx, run)
      expect(asked).toEqual([
        ['list_family_events', { from: day, to: day, include_cancelled: false }],
        ['list_family_events', { from: dayAfter(day), to: dayAfter(day), include_cancelled: false }],
        ['list_family_events', { from: dayAfter(dayAfter(day)), to: horizon, include_cancelled: false }],
        ['list_calendar', { from: day, to: horizon }],
        ['new_mail', { limit: 20 }],
        ['jira_board_summary', {}],
        ['weather', {}],
        ['list_event_proposals', {}],
      ])
      expect(brief.empty).toBe(true)
    })

    it("puts the open questions to the caller once, and lists their own reminders for the fortnight, not another member's", async () => {
      const { row } = await q.askQuestion({ question: 'Who is at Hillside?', candidate: 'Juno attends Hillside' })
      const soon = new Date(now.getTime() + 2 * 86_400_000)
      await q.addAutomation({ memberId: ctx.member!.id, label: 'bins', cronExpr: '0 19 * * 1', instruction: 'i', nextRunAt: soon })
      await q.addAutomation({ memberId: ctx.member!.id, label: 'watch', cronExpr: '0 8 * * *', instruction: 'i', nextRunAt: soon, repeat: 'until' })
      const paused = await q.addAutomation({ memberId: ctx.member!.id, label: 'paused', cronExpr: '0 8 * * *', instruction: 'i', nextRunAt: soon })
      await q.setAutomationEnabled(paused.id, false)
      await q.addAutomation({ memberId: ctx.member!.id, label: 'next month', cronExpr: '0 8 * * *', instruction: 'i', nextRunAt: new Date(now.getTime() + 40 * 86_400_000) })
      const ada = await q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
      await q.addAutomation({ memberId: ada.id, label: 'theirs', cronExpr: '0 8 * * *', instruction: 'i', nextRunAt: soon })

      const brief = await gatherBrief(ctx, async () => ({}))
      expect(brief.data.questions).toEqual([{ id: row.id, question: 'Who is at Hillside?' }])
      expect((brief.data.coming as { reminders: { label: string }[] }).reminders.map((r) => r.label)).toEqual(['bins'])
      // Asked once: the next brief does not ask again, though Home still carries it.
      expect((await q.unaskedQuestions()).length).toBe(0)
      expect((await q.openQuestions()).length).toBe(1)
      expect((await gatherBrief(ctx, async () => ({}))).data).not.toHaveProperty('questions')
    })

    it('words a reminder today by its time, and one later by its day as well', async () => {
      const today = await remindersBetween(ctx.member!.id, new Date(localToUtc(day).getTime()), horizon)
      expect(today).toEqual([])
      const at = localToUtc(`${dayAfter(day)}T19:00`)
      await q.addAutomation({ memberId: ctx.member!.id, label: 'bins', cronExpr: '0 19 * * *', instruction: 'i', nextRunAt: at })
      const morning = localToUtc(`${dayAfter(day)}T06:00`)
      expect(await remindersBetween(ctx.member!.id, morning, horizon)).toEqual([{ label: 'bins', at: '7:00 pm', date: dayAfter(day) }])
      const [ahead] = await remindersBetween(ctx.member!.id, localToUtc(`${day}T06:00`), horizon)
      expect(ahead.at).toMatch(/7:00 pm$/)
      expect(ahead.at).not.toBe('7:00 pm')
    })

    it('goes on without the questions or the reminders when either cannot be read', async () => {
      await client.exec('drop table memory_questions cascade; drop table automations cascade')
      const brief = await gatherBrief(ctx, async () => ({}))
      expect(brief.data).not.toHaveProperty('questions')
      expect(brief.data).not.toHaveProperty('reminders')
      expect(brief.empty).toBe(true)
    })

    it('leaves out a proposals lookup that fails, and reminders for a caller with no member behind them', async () => {
      const run = async (name: string) => {
        if (name === 'list_event_proposals') throw new Error('proposals down')
        return {}
      }
      const brief = await gatherBrief({ ...ctx, member: null }, run)
      expect(brief.data).not.toHaveProperty('proposals')
      expect(brief.data).not.toHaveProperty('reminders')
      expect(brief.problems).toEqual([])
    })
  })

  describe('gatherSnapshot', () => {
    it('reads the past seven days, the month so far and its budget', async () => {
      const asked: [string, unknown][] = []
      const run = async (name: string, args: Record<string, unknown>) => {
        asked.push([name, args])
        return { transactions: name === 'spending_summary' ? 3 : undefined, name }
      }
      const snap = await gatherSnapshot(ctx, run)
      const weekStart = localDateKey(new Date(now.getTime() - 6 * 86_400_000))
      expect(asked).toEqual([['spending_summary', { from: weekStart, to: day }], ['spending_summary', {}], ['budget_summary', {}]])
      expect(snap.data).toMatchObject({ week: `${weekStart} to ${day}`, this_week: { name: 'spending_summary' }, month_so_far: { name: 'spending_summary' }, budget: { name: 'budget_summary' } })
      expect(snap.empty).toBe(false)
      expect(snap.problems).toEqual([])
    })

    it('reports a feed that will not answer, leaves its part out, and has nothing to say for a week with no money moving', async () => {
      const run = async (name: string, args: Record<string, unknown>) =>
        name === 'budget_summary' ? { error: 'PocketSmith API 502' } : args.from ? { error: 'PocketSmith API 500' } : { transactions: 0 }
      const snap = await gatherSnapshot(ctx, run)
      expect(snap.problems).toEqual(['spending_summary (week): PocketSmith API 500', 'budget_summary: PocketSmith API 502'])
      expect(snap.data).not.toHaveProperty('this_week')
      expect(snap.data).not.toHaveProperty('budget')
      expect(snap.data.month_so_far).toEqual({ transactions: 0 })
      expect(snap.empty).toBe(true)
      // PocketSmith switched off is a setting, not a fault.
      const off = await gatherSnapshot(ctx, async () => ({ error: 'PocketSmith is not configured.' }))
      expect(off.problems).toEqual([])
      expect(off.empty).toBe(true)
    })
  })

  describe('morning_brief', () => {
    const call = (c: ToolContext, name: 'morning_brief' | 'money_snapshot') =>
      ((briefTools(c) as Record<string, { execute: unknown }>)[name].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)({}, {})
    const message = (id: string, hoursAgo: number) => ({
      id, from: 'office@school.example', to: 'rowan@hearth.example', cc: '', subject: 'Excursion form',
      snippet: 'Please sign by Friday.', date: new Date(now.getTime() - hoursAgo * 3_600_000).toISOString(), unread: true,
    })

    it('reads the mail on markers of its own, handing their moves to the call, so a client and the brief never spend each other\'s mail', async () => {
      listMail.mockResolvedValue([message('m1', 1)])
      const r = await call(ctx, 'morning_brief')
      expect((r.mail as { accounts: { messages: { id: string }[] }[] }).accounts[0].messages.map((m) => m.id)).toEqual(['m1'])
      expect(r.now).toMatch(/^NOW: /)
      expect(r.how_to_read).toBe(BRIEF_GUIDE)
      expect(r).not.toHaveProperty('nothing_new')
      // Nothing is spent until the call is answered: the moves wait on the caller's context.
      expect(ctx.pendingCursors?.map((p) => p.key)).toEqual([`mail_cursor:brief:${ctx.member!.id}:google`])
      expect(await q.getSetting(`mail_cursor:brief:${ctx.member!.id}:google`)).toBeNull()
      await commitCursors(ctx.pendingCursors)

      // The brief has had it.
      const again: ToolContext = { ...ctx, pendingCursors: undefined }
      const second = await call(again, 'morning_brief')
      expect((second.mail as { accounts: { messages: unknown[] }[] }).accounts[0].messages).toEqual([])
      expect(second.nothing_new).toContain('Nothing on any calendar today')
      // The client's own markers have not been touched.
      const own: ToolContext = { ...ctx, pendingCursors: undefined }
      const fresh = await (mailTools(own).new_mail.execute as unknown as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)({ limit: 10 }, {})
      expect((fresh.accounts as { messages: { id: string }[] }[])[0].messages.map((m) => m.id)).toEqual(['m1'])
    })

    it('says what it could not read, beside the rest', async () => {
      listEvents.mockRejectedValue(new Error('Graph said 503'))
      const r = await call({ ...ctx, pendingCursors: undefined }, 'morning_brief')
      expect(r.could_not_read).toEqual(["list_calendar (Rowan's Google Calendar): Graph said 503"])
      expect(r.how_to_read).toBe(BRIEF_GUIDE)
    })

    it('needs a member to read for', async () => {
      await expect(call({ ...ctx, member: null }, 'morning_brief')).rejects.toThrow(/family member/)
    })

    it('tells a caller how to give it, proposing dates by source so a second sweep finds the first', () => {
      expect(BRIEF_GUIDE).toContain('propose_family_event, passing the message id as source')
      expect(BRIEF_GUIDE).toContain('a date already proposed comes back as that proposal rather than a second one')
      expect(BRIEF_GUIDE).toContain('Nothing here was posted anywhere')
    })
  })

  describe('money_snapshot', () => {
    const call = (c: ToolContext) =>
      ((briefTools(c) as Record<string, { execute: unknown }>).money_snapshot.execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)({}, {})

    it('says no money moved when PocketSmith is not set up, without calling that a fault', async () => {
      const r = await call(ctx)
      expect(r).toMatchObject({ nothing_new: 'No money moved this week or this month.', how_to_read: SNAPSHOT_GUIDE })
      expect(r).not.toHaveProperty('could_not_read')
      expect(r).not.toHaveProperty('this_week')
    })

    it('hands over the week, the month and where each budgeted category stands, in the budget\'s own words', async () => {
      ps.pocketsmithConfigured.mockReturnValue(true)
      ps.listTransactions.mockResolvedValue([
        { id: 1, date: day, payee: 'Coles', amount: -80, category: 'Supermarket', categoryKind: 'expense', isTransfer: false, categoryIsTransfer: false, account: 'NAB', note: null, memo: null, labels: [], originalPayee: null },
      ])
      ps.budgetSummary.mockResolvedValue({ income: { totalActual: 0, totalForecast: 0, currency: 'aud' }, expense: { totalActual: -80, totalForecast: -100, currency: 'aud' } })
      ps.budgetByCategory.mockResolvedValue([
        { title: 'Shopping', actual: 40, forecast: 0, overBy: 40, underBy: 0, from: day, to: day, budgeted: true },
        { title: 'Medical', actual: 150, forecast: 100, overBy: 50, underBy: 0, from: day, to: day, budgeted: true },
        { title: 'Pets', actual: 12, forecast: 0, overBy: 12, underBy: 0, from: day, to: day, budgeted: false },
      ])
      const r = await call(ctx)
      expect(r).toMatchObject({ this_week: { transactions: 1, spent: '$80.00' }, month_so_far: { transactions: 1 } })
      expect(r.budget).toMatchObject({
        over_budget: [{ category: 'Medical', position: 'over by $50.00' }],
        nothing_left_after_rollover: ['Shopping'],
        no_budget_set: ['Pets'],
      })
      expect(r).not.toHaveProperty('nothing_new')
      expect(SNAPSHOT_GUIDE).toContain('nothing_left_after_rollover')
      expect(SNAPSHOT_GUIDE).toContain('never as overspent or as having no budget')
    })
  })
})
