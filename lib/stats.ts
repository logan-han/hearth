import { sql } from 'drizzle-orm'
import { db } from './db'
import { formatLocal, formatLocalDate, localDateKey, localToUtc, dayAfter, timezone } from './cron'
import * as ps from './providers/pocketsmith'
import * as notion from './providers/notion'
import * as jira from './providers/jira'
import * as weather from './providers/weather'
import { describeChain } from './model'
import { chainHealth, type ChainHealth } from './model-events'
import { getSetting } from './db/queries'
import { schedulerPulse, tickCadence, onGrid, nextTickOnOrAfter, describeGrid, type TickGrid } from './scheduler'
import { roleInBrief } from './helpers'

export type Stats = Awaited<ReturnType<typeof gatherStats>>
export type FamilyStats = Awaited<ReturnType<typeof gatherFamilyStats>>

type Row = Record<string, unknown>
const rows = (r: unknown): Row[] => ((r as { rows?: Row[] }).rows ?? []) as Row[]
const one = (r: unknown): Row => rows(r)[0] ?? {}
const n = (v: unknown): number => Number(v ?? 0)

/**
 * A proposal still worth an answer, for a query aliasing event_proposals as
 * `p`: the same rule as pendingProposals in the query layer. Past occasions
 * and events already on the calendar by another route are not questions.
 */
const LIVE_PROPOSAL = sql`p.status = 'pending' and p.ends_at > now() and not exists (
  select 1 from family_events e
  where not e.cancelled and e.starts_at = p.starts_at and lower(trim(e.title)) = lower(trim(p.title))
)`

export async function gatherStats(month?: string) {
  const view = monthView(month, ctxNow())
  const [counts, byDay, models, keyRows, upcoming, automations, listRows, monthEvents, health, lastTickAt, prevTickAt] = await Promise.all([
    db().execute(sql`
      select
        (select count(*) from members where allowed) as members,
        (select count(*) from members where is_admin and allowed) as admins,
        (select count(*) from connections) as connections,
        (select count(*) from mcp_keys) as keys,
        (select count(*) from family_events where not cancelled) as events,
        (select count(*) from memories where invalidated_at is null) as memories,
        (select count(*) from event_proposals p where ${LIVE_PROPOSAL}) as proposals
    `),
    // What was changed each day of the fortnight, and how it was asked for:
    // through an MCP client, on Home, or by a scheduled job.
    db().execute(sql`
      select to_char(created_at at time zone ${timezone()}, 'YYYY-MM-DD') as day,
             count(*) filter (where via = 'mcp') as mcp,
             count(*) filter (where via = 'web') as web,
             count(*) filter (where via = 'watcher') as scheduled
      from activity
      where created_at > now() - interval '14 days'
      group by 1 order by 1
    `),
    // Which model actually ran the scheduled jobs, which is how the fallback
    // chain is judged, read from the chain's own record for the month. That
    // record is a diagnostic, like the chain's health below, so a table that
    // cannot be read leaves the shares empty rather than taking the page down.
    db().execute(sql`
      select slot as model, count(*) as n
      from model_events where outcome = 'answered' and purpose = 'hearth.watcher'
        and created_at > now() - interval '30 days'
      group by 1 order by 2 desc limit 8
    `).catch(() => ({ rows: [] as Row[] })),
    // Every key out there, whose it is and when it was last used: the keys
    // themselves are not kept, so this is what an admin can judge a stale one by.
    db().execute(sql`
      select k.id, k.label, k.created_at, k.last_used_at, m.name as member
      from mcp_keys k join members m on m.id = k.member_id
      order by k.last_used_at desc nulls last, k.id desc
    `),
    db().execute(sql`
      select title, starts_at, all_day from family_events
      where not cancelled and ends_at > now() order by starts_at limit 6
    `),
    db().execute(sql`
      select a.id, a.label, a.cron_expr, a.enabled, a.next_run_at, a.last_run_at, m.name as owner
      from automations a left join members m on m.id = a.member_id
      order by a.enabled desc, a.next_run_at
    `),
    db().execute(sql`
      select l.name, count(i.id) filter (where not i.done) as open, count(i.id) as total
      from lists l left join list_items i on i.list_id = l.id
      group by l.name order by l.name
    `),
    eventsInView(view),
    // Both are diagnostics; a hiccup reading them must not take the page down.
    chainHealth(7).catch((): ChainHealth | null => null),
    getSetting('last_tick_at').catch((): string | null => null),
    getSetting('prev_tick_at').catch((): string | null => null),
  ])

  const c = one(counts)
  const grid = tickCadence(lastTickAt, prevTickAt)
  return {
    timezone: timezone(),
    calendar: buildMonth(view, rows(monthEvents)),
    chainHealth: health,
    scheduler: { ...schedulerPulse(lastTickAt, prevTickAt, ctxNow()), grid: grid ? describeGrid(grid) : null },
    totals: {
      members: n(c.members),
      admins: n(c.admins),
      connections: n(c.connections),
      keys: n(c.keys),
      events: n(c.events),
      memories: n(c.memories),
      proposals: n(c.proposals),
    },
    activity: fortnight(
      rows(byDay).map((r) => ({ day: String(r.day), mcp: n(r.mcp), web: n(r.web), scheduled: n(r.scheduled) })),
    ),
    models: rows(models).map((r) => ({ model: String(r.model), count: n(r.n) })),
    keys: rows(keyRows).map((r) => ({
      id: n(r.id),
      label: String(r.label),
      member: String(r.member),
      created: formatLocalDate(new Date(r.created_at as string)),
      lastUsed: r.last_used_at ? formatLocal(new Date(r.last_used_at as string)) : null,
    })),
    upcoming: rows(upcoming).map((r) => ({
      title: String(r.title),
      when: whenText(r),
      allDay: Boolean(r.all_day),
    })),
    automations: rows(automations).map((r) => ({
      id: n(r.id),
      label: String(r.label),
      cron: String(r.cron_expr),
      enabled: Boolean(r.enabled),
      owner: r.owner ? String(r.owner) : null,
      ...timing(grid, r),
      lastRun: r.last_run_at ? formatLocal(new Date(r.last_run_at as string)) : null,
    })),
    lists: rows(listRows).map((r) => ({ name: String(r.name), open: n(r.open), total: n(r.total) })),
    // Whether each integration is live, keyed by the settings group it is
    // configured in, so the dot sits beside the key that drives it. Each note
    // says what kind of data arrives, not how it is configured.
    connected: [
      {
        group: 'Money',
        items: [
          { name: 'PocketSmith', on: ps.pocketsmithConfigured(), note: 'transactions, spending and budgets' },
        ],
      },
      {
        group: 'Tasks',
        items: [{ name: 'Jira', on: jira.jiraConfigured(), note: 'tasks and tickets' }],
      },
      {
        group: 'Notes',
        items: [{ name: 'Notion', on: notion.notionConfigured(), note: 'pages and databases' }],
      },
      {
        group: 'Web search',
        items: [{ name: 'Tavily', on: Boolean(process.env.TAVILY_API_KEY), note: 'news, hours, prices' }],
      },
      {
        group: 'Weather',
        items: [{ name: 'OpenWeatherMap', on: weather.weatherConfigured(), note: 'conditions and forecasts' }],
      },
      {
        group: 'Scheduler',
        items: [{ name: 'QStash', on: Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY), note: 'runs reminders and scheduled jobs' }],
      },
    ],
    chain: describeChain(),
  }
}

/**
 * When an automation is due and, when that is not on a tick, when it will
 * really run: an automation fires at the first tick on or after its time.
 * Before the scheduler has shown its cadence nothing can be said, so nothing is.
 */
function timing(grid: TickGrid | null, r: Row) {
  if (!r.enabled) return { nextRun: null, offGrid: false, runsAt: null }
  const due = new Date(r.next_run_at as string)
  const offGrid = grid ? !onGrid(grid, due) : false
  return {
    nextRun: formatLocal(due),
    offGrid,
    runsAt: offGrid && grid ? formatLocal(nextTickOnOrAfter(grid, due)) : null,
  }
}

type DayCount = { day: string; mcp: number; web: number; scheduled: number }

/** Fourteen days, oldest first, with quiet days present as zeroes. */
function fortnight(found: DayCount[]): DayCount[] {
  const byDay = new Map(found.map((f) => [f.day, f]))
  const today = new Date()
  const out: DayCount[] = []
  for (let i = 13; i >= 0; i--) {
    const at = new Date(today.getTime() - i * 86_400_000)
    const key = localDateKey(at)
    out.push(byDay.get(key) ?? { day: key, mcp: 0, web: 0, scheduled: 0 })
  }
  return out
}

/** How many of the viewer's latest changes Home lists. */
const ACTIVITY_SHOWN = 15

/** How many ticked items Home carries per list, the most recently added; the rest are a click away. */
const TICKED_SHOWN = 10

/** How many of the viewer's latest reports Home lists; list_reports reaches the rest. */
const REPORTS_SHOWN = 10

/**
 * What any recognised family member may see: the household's shared things,
 * and the viewer's own goals, reminders, reports, keys and record of
 * changes. No settings, no integration wiring, and nothing of another member's.
 */
export async function gatherFamilyStats(month?: string, viewer?: number | null) {
  const view = monthView(month, ctxNow())
  const me = viewer ?? -1
  const [counts, upcoming, automations, listRows, monthEvents, proposalRows, memoryRows, questionRows, lastTickAt, prevTickAt, activityRows, goalRows, helperRows, reportRows, keyRows] = await Promise.all([
    db().execute(sql`
      select
        (select count(*) from family_events where not cancelled) as events,
        (select count(*) from memories where invalidated_at is null) as memories,
        (select count(*) from event_proposals p where ${LIVE_PROPOSAL}) as proposals
    `),
    db().execute(sql`
      select id, title, starts_at, all_day from family_events
      where not cancelled and ends_at > now() order by starts_at limit 6
    `),
    // Every one of the viewer's own: Home is where they pause or delete one
    // from the web, and a paused one sorts last, so a cut-off would hide it.
    db().execute(sql`
      select id, label, cron_expr, enabled, next_run_at, repeat from automations
      where member_id = ${me}
      order by enabled desc, next_run_at
    `),
    // Every open item, but only the latest ticked ones: a weekly shop ticks
    // off over a thousand a year, and nothing prunes them unless asked to.
    // Latest means added last, since nothing records when an item was ticked,
    // so one that sat on the list a while can drop out as it is ticked; Home
    // fetches the whole list from /api/family to reach it again.
    db().execute(sql`
      select name, list_id, id, content, done, ticked from (
        select l.name, l.id as list_id, i.id, i.content, i.done,
               count(i.id) filter (where i.done) over (partition by l.id) as ticked,
               row_number() over (partition by l.id, i.done order by i.id desc) as nth
        from lists l left join list_items i on i.list_id = l.id
      ) x
      where not coalesce(done, false) or nth <= ${TICKED_SHOWN}
      order by name, done, id
    `),
    eventsInView(view),
    // What was found and is waiting for a yes, with whose call or job found it.
    db().execute(sql`
      select p.id, p.title, p.starts_at, p.all_day, p.location, p.description, m.name as who
      from event_proposals p left join members m on m.id = p.member_id
      where ${LIVE_PROPOSAL} order by p.starts_at
    `),
    // What the household keeps in mind, newest first, with who asked for it.
    db().execute(sql`
      select m.id, m.content, m.created_at, mb.name as who
      from memories m left join members mb on mb.id = m.created_by
      where m.invalidated_at is null
      order by m.created_at desc, m.id desc limit 200
    `),
    // What nobody could stand behind yet, put to the family instead.
    db().execute(sql`
      select id, question, candidate, created_at from memory_questions
      where settled_at is null order by id
    `),
    getSetting('last_tick_at').catch((): string | null => null),
    getSetting('prev_tick_at').catch((): string | null => null),
    // What was changed in the viewer's name lately: another member's record
    // (their goals, their calendar) is theirs to look back over.
    db().execute(sql`
      select a.id, a.summary, a.via, a.created_at
      from activity a
      where a.member_id = ${me}
      order by a.created_at desc, a.id desc limit ${ACTIVITY_SHOWN}
    `),
    // The viewer's own goals in progress, each with its latest progress note.
    db().execute(sql`
      select g.id, g.title, g.outcome, g.target_date,
             (select u.note from goal_updates u where u.goal_id = g.id order by u.created_at desc, u.id desc limit 1) as latest
      from goals g
      where g.status = 'active' and g.member_id = ${me}
      order by g.target_date nulls last, g.id
    `),
    // The household's helpers, which anyone can hand a job to.
    db().execute(sql`select id, name, role from helpers order by id`),
    // What the viewer's scheduled jobs found, newest first.
    db().execute(sql`
      select id, label, helper, status, body, detail, created_at from automation_reports
      where member_id = ${me}
      order by created_at desc, id desc limit ${REPORTS_SHOWN}
    `),
    // The viewer's own MCP keys, never the keys themselves, which are not kept.
    db().execute(sql`
      select id, label, created_at, last_used_at from mcp_keys
      where member_id = ${me}
      order by created_at desc, id desc
    `),
  ])

  // One row per item, empty lists included; fold into per-list shapes the
  // family can act on, not just count.
  const lists = new Map<string, { id: number; name: string; ticked: number; items: { id: number; content: string; done: boolean }[] }>()
  for (const r of rows(listRows)) {
    const name = String(r.name)
    const list = lists.get(name) ?? { id: n(r.list_id), name, ticked: n(r.ticked), items: [] }
    if (r.id != null) list.items.push({ id: n(r.id), content: String(r.content), done: Boolean(r.done) })
    lists.set(name, list)
  }

  // Each goal's own steps, in the order they were planned.
  const goalIds = rows(goalRows).map((r) => n(r.id))
  const stepRows = goalIds.length
    ? rows(await db().execute(sql`select id, goal_id, content, done from goal_steps where goal_id in (${sql.join(goalIds.map((id) => sql`${id}`), sql`, `)}) order by id`))
    : []

  const c = one(counts)
  const grid = tickCadence(lastTickAt, prevTickAt)
  return {
    timezone: timezone(),
    // When reminders can fire at all, in words, once the scheduler has shown it.
    scheduler: grid ? describeGrid(grid) : null,
    calendar: buildMonth(view, rows(monthEvents)),
    totals: { events: n(c.events), memories: n(c.memories), proposals: n(c.proposals) },
    upcoming: rows(upcoming).map((r) => ({
      id: n(r.id),
      title: String(r.title),
      when: whenText(r),
      allDay: Boolean(r.all_day),
    })),
    automations: rows(automations).map((r) => ({
      id: n(r.id),
      label: String(r.label),
      cron: String(r.cron_expr),
      enabled: Boolean(r.enabled),
      // A job that goes once it has run, or once it has found what it waits for.
      repeat: r.repeat === 'once' || r.repeat === 'until' ? (r.repeat as 'once' | 'until') : null,
      ...timing(grid, r),
    })),
    lists: [...lists.values()].map((l) => {
      const open = l.items.filter((i) => !i.done).length
      // Every ticked item, the older ones left out of items included.
      return { id: l.id, name: l.name, open, ticked: l.ticked, total: open + l.ticked, items: l.items }
    }),
    proposals: rows(proposalRows).map((r) => ({
      id: n(r.id),
      title: String(r.title),
      when: whenText(r),
      who: r.who ? String(r.who) : null,
      // The first line of what was found, so the family can judge without looking it up.
      detail: [r.location ? String(r.location) : null, readableLine(r.description)].filter(Boolean).join(' · '),
    })),
    memories: rows(memoryRows).map((r) => ({
      id: n(r.id),
      fact: String(r.content),
      who: r.who ? String(r.who) : null,
      since: formatLocalDate(new Date(r.created_at as string)),
    })),
    questions: rows(questionRows).map((r) => ({
      id: n(r.id),
      question: String(r.question),
      candidate: String(r.candidate),
      since: formatLocalDate(new Date(r.created_at as string)),
    })),
    helpers: rows(helperRows).map((r) => ({ id: n(r.id), name: String(r.name), role: roleInBrief(String(r.role)) })),
    goals: rows(goalRows).map((r) => {
      const steps = stepRows.filter((i) => n(i.goal_id) === n(r.id)).map((i) => ({ id: n(i.id), content: String(i.content), done: Boolean(i.done) }))
      const target = r.target_date ? String(r.target_date) : null
      return {
        id: n(r.id),
        title: String(r.title),
        outcome: r.outcome ? String(r.outcome) : null,
        target: target ? formatLocalDate(localToUtc(target)) : null,
        daysLeft: target ? Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${localDateKey(new Date())}T00:00:00Z`)) / DAY_MS) : null,
        done: steps.filter((i) => i.done).length,
        steps,
        latest: r.latest ? String(r.latest) : null,
      }
    }),
    activity: rows(activityRows).map((r) => ({
      id: n(r.id),
      summary: String(r.summary),
      how: r.via === 'watcher' ? 'by a scheduled job' : r.via === 'web' ? 'on Home' : 'through an MCP client',
      when: formatLocal(new Date(r.created_at as string)),
    })),
    reports: rows(reportRows).map((r) => ({
      id: n(r.id),
      label: String(r.label),
      helper: r.helper ? String(r.helper) : null,
      status: String(r.status) as 'ready' | 'held' | 'problem',
      body: String(r.body),
      detail: r.detail ? String(r.detail) : null,
      when: formatLocal(new Date(r.created_at as string)),
    })),
    keys: rows(keyRows).map((r) => ({
      id: n(r.id),
      label: String(r.label),
      created: formatLocalDate(new Date(r.created_at as string)),
      lastUsed: r.last_used_at ? formatLocal(new Date(r.last_used_at as string)) : null,
    })),
  }
}

/**
 * The first line of a description a person can read. A bare message id, a
 * token or a lone link says where something came from, not what it is, and
 * at a hundred characters with no space in it also breaks the layout, so a
 * line that is only that is passed over for the next.
 */
export function readableLine(description: unknown): string | null {
  // One unbroken token that is long, or shaped like scheme:rest (an id, a link).
  const isReference = (s: string) => !/\s/.test(s) && (s.length > 32 || /^[a-z][a-z0-9+.-]*:\S+$/i.test(s))
  for (const raw of String(description ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // A "Source:" style label in front does not make the id behind it readable.
    if (isReference(line) || isReference(line.replace(/^[a-z][a-z ]{0,20}:\s*/i, ''))) continue
    return line.slice(0, 140)
  }
  return null
}

/* ------------------------------------------------------------- calendar -- */

const DAY_MS = 86_400_000

function ctxNow(): Date {
  return new Date()
}

/** The month being shown, as a UTC range wide enough to catch overlaps. */
function monthView(month: string | undefined, now: Date) {
  const key = /^\d{4}-\d{2}$/.test(month ?? '') ? month! : localDateKey(now).slice(0, 7)
  const [y, m] = key.split('-').map(Number)
  // Melbourne is ahead of UTC, so pad a day either side rather than guess.
  const from = new Date(Date.UTC(y, m - 1, 1) - DAY_MS)
  const to = new Date(Date.UTC(y, m, 1) + DAY_MS)
  return { key, year: y, month: m, from, to }
}

/** The family events on any day of the month being shown, for its grid. */
function eventsInView(view: ReturnType<typeof monthView>) {
  return db().execute(
    sql`
      select title, starts_at, ends_at, all_day from family_events
      where not cancelled and ends_at >= ${view.from} and starts_at <= ${view.to}
      order by starts_at
    `,
  )
}

function shiftMonth(key: string, by: number): string {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + by, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export type CalendarDay = {
  date: string
  day: number
  inMonth: boolean
  isToday: boolean
  events: { title: string; time: string | null }[]
}

function buildMonth(view: ReturnType<typeof monthView>, evented: Row[]) {
  const byDate = new Map<string, { title: string; time: string | null }[]>()
  for (const r of evented) {
    const starts = new Date(r.starts_at as string)
    const ends = new Date(r.ends_at as string)
    const allDay = Boolean(r.all_day)
    // An event spanning days appears on each of them, stepped by the
    // calendar: 24-hour steps from the start instant miss the last day of a
    // timed trip and land an all-day event twice on the day the clocks go back.
    const last = localDateKey(new Date(Math.max(starts.getTime(), ends.getTime() - 1)))
    const monthStart = `${view.key}-01`
    for (let key = localDateKey(starts) < monthStart ? monthStart : localDateKey(starts); key <= last; key = dayAfter(key)) {
      if (!key.startsWith(view.key)) break
      const list = byDate.get(key) ?? []
      list.push({
        title: String(r.title),
        time: allDay ? null : timeOnly(starts),
      })
      byDate.set(key, list)
    }
  }

  // Monday-first, which is how an Australian wall calendar reads. Always six
  // weeks, so flicking between months never changes the grid's height.
  const first = new Date(Date.UTC(view.year, view.month - 1, 1))
  const lead = (first.getUTCDay() + 6) % 7
  const total = 42
  const today = localDateKey(ctxNow())

  const days: CalendarDay[] = []
  for (let i = 0; i < total; i++) {
    const at = new Date(Date.UTC(view.year, view.month - 1, 1 - lead + i))
    const date = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`
    days.push({
      date,
      day: at.getUTCDate(),
      inMonth: at.getUTCMonth() + 1 === view.month,
      isToday: date === today,
      events: byDate.get(date) ?? [],
    })
  }

  return {
    key: view.key,
    label: new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first),
    prev: shiftMonth(view.key, -1),
    next: shiftMonth(view.key, 1),
    isCurrent: view.key === today.slice(0, 7),
    // Where Today goes and what the bare address shows, whichever month this is.
    thisMonth: today.slice(0, 7),
    days,
  }
}

function timeOnly(d: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: timezone(), hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d).replace(':00', '').replace(' ', '')
}

/** Just what the calendar page needs. */
export async function gatherCalendar(month?: string) {
  const view = monthView(month, ctxNow())
  const [monthEvents, upcoming] = await Promise.all([
    eventsInView(view),
    db().execute(sql`
      select title, starts_at, all_day from family_events
      where not cancelled and ends_at > now() order by starts_at limit 5
    `),
  ])
  return {
    timezone: timezone(),
    calendar: buildMonth(view, rows(monthEvents)),
    upcoming: rows(upcoming).map((r) => ({
      title: String(r.title),
      when: whenText(r),
    })),
  }
}

/** All-day entries get a date; timed ones get a time as well. */
function whenText(r: Row): string {
  const at = new Date(r.starts_at as string)
  return r.all_day ? formatLocalDate(at) : formatLocal(at)
}
