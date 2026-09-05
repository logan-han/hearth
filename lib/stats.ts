import { sql } from 'drizzle-orm'
import { db } from './db'
import { formatLocal, formatLocalDate, localDateKey, timezone } from './cron'
import * as up from './providers/up'
import * as ps from './providers/pocketsmith'
import * as notion from './providers/notion'
import * as jira from './providers/jira'
import * as weather from './providers/weather'
import { describeChain } from './model'

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
  const [counts, byDay, models, chats, upcoming, automations, listRows, monthEvents] = await Promise.all([
    db().execute(sql`
      select
        (select count(*) from members where allowed) as members,
        (select count(*) from members where is_admin and allowed) as admins,
        (select count(*) from connections) as connections,
        (select count(*) from messages) as messages,
        (select count(*) from family_events where not cancelled) as events,
        (select count(*) from memories where invalidated_at is null) as memories,
        (select count(*) from event_proposals p where ${LIVE_PROPOSAL}) as proposals,
        (select count(*) from email_drafts where status = 'pending') as drafts,
        (select count(*) from email_drafts where status = 'sent') as sent
    `),
    db().execute(sql`
      select to_char(created_at at time zone ${timezone()}, 'YYYY-MM-DD') as day,
             count(*) filter (where role = 'user') as asked,
             count(*) filter (where role = 'assistant') as answered
      from messages
      where created_at > now() - interval '14 days'
      group by 1 order by 1
    `),
    // Which model actually answered, which is how the fallback chain is judged.
    // Replies older than model tracking have a null model; they say nothing
    // about the chain, so they stay out of the shares.
    db().execute(sql`
      select model, count(*) as n
      from messages where role = 'assistant' and model is not null
        and created_at > now() - interval '30 days'
      group by 1 order by 2 desc limit 8
    `),
    db().execute(sql`
      select c.chat_id, c.type, c.title, c.strangers,
             (select count(*) from messages m where m.chat_id = c.chat_id) as messages,
             -- A private chat's id is the other person's Telegram id.
             (select name from members where telegram_user_id = c.chat_id) as person
      from chats c order by messages desc limit 10
    `),
    db().execute(sql`
      select title, starts_at, all_day from family_events
      where not cancelled and ends_at > now() order by starts_at limit 6
    `),
    db().execute(sql`
      select label, cron_expr, enabled, next_run_at, last_run_at, chat_id
      from automations order by enabled desc, next_run_at limit 10
    `),
    db().execute(sql`
      select l.name, count(i.id) filter (where not i.done) as open, count(i.id) as total
      from lists l left join list_items i on i.list_id = l.id
      group by l.name order by l.name
    `),
    db().execute(sql`
      select title, starts_at, ends_at, all_day from family_events
      where not cancelled and ends_at >= ${view.from} and starts_at <= ${view.to}
      order by starts_at
    `),
  ])

  const c = one(counts)
  return {
    timezone: timezone(),
    calendar: buildMonth(view, rows(monthEvents)),
    totals: {
      members: n(c.members),
      admins: n(c.admins),
      connections: n(c.connections),
      messages: n(c.messages),
      events: n(c.events),
      memories: n(c.memories),
      proposals: n(c.proposals),
      drafts: n(c.drafts),
      sent: n(c.sent),
    },
    activity: fortnight(
      rows(byDay).map((r) => ({ day: String(r.day), asked: n(r.asked), answered: n(r.answered) })),
    ),
    models: rows(models).map((r) => ({ model: String(r.model), count: n(r.n) })),
    chats: rows(chats).map((r) => ({
      id: String(r.chat_id),
      type: String(r.type),
      title: (r.title as string) ?? null,
      person: (r.person as string) ?? null,
      messages: n(r.messages),
      strangers: safeStrangers(r.strangers),
    })),
    upcoming: rows(upcoming).map((r) => ({
      title: String(r.title),
      when: whenText(r),
      allDay: Boolean(r.all_day),
    })),
    automations: rows(automations).map((r) => ({
      label: String(r.label),
      cron: String(r.cron_expr),
      enabled: Boolean(r.enabled),
      nextRun: r.enabled ? formatLocal(new Date(r.next_run_at as string)) : null,
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
          { name: 'Up Bank', on: up.upConfigured(), note: 'accounts and transactions' },
          { name: 'PocketSmith', on: ps.pocketsmithConfigured(), note: 'categorised spending and budgets' },
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
        items: [{ name: 'QStash', on: Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY), note: 'fires reminders' }],
      },
    ],
    chain: describeChain(),
  }
}

/** Fourteen days, oldest first, with quiet days present as zeroes. */
function fortnight(found: { day: string; asked: number; answered: number }[]) {
  const byDay = new Map(found.map((f) => [f.day, f]))
  const today = new Date()
  const out: { day: string; asked: number; answered: number }[] = []
  for (let i = 13; i >= 0; i--) {
    const at = new Date(today.getTime() - i * 86_400_000)
    const key = localDateKey(at)
    out.push(byDay.get(key) ?? { day: key, asked: 0, answered: 0 })
  }
  return out
}

function safeStrangers(raw: unknown): number {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/**
 * The subset any recognised family member may see: shared household things
 * only. No settings, no per-chat internals, no integration wiring.
 */
export async function gatherFamilyStats(month?: string) {
  const view = monthView(month, ctxNow())
  const [counts, upcoming, automations, listRows, monthEvents, proposalRows] = await Promise.all([
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
    db().execute(sql`
      select id, label, cron_expr, enabled, next_run_at from automations
      order by enabled desc, next_run_at limit 10
    `),
    db().execute(sql`
      select l.name, i.id, i.content, i.done
      from lists l left join list_items i on i.list_id = l.id
      order by l.name, i.done, i.id
    `),
    db().execute(sql`
      select title, starts_at, ends_at, all_day from family_events
      where not cancelled and ends_at >= ${view.from} and starts_at <= ${view.to}
      order by starts_at
    `),
    // What the bot found and is waiting for a yes on, with the chat it was
    // proposed in: a group's title, or the person whose DM it is.
    db().execute(sql`
      select p.id, p.title, p.starts_at, p.all_day, p.location, p.description,
             coalesce(c.title, (select name from members where telegram_user_id = p.chat_id), p.chat_id) as chat
      from event_proposals p left join chats c on c.chat_id = p.chat_id
      where ${LIVE_PROPOSAL} order by p.starts_at
    `),
  ])

  // One row per item, empty lists included; fold into per-list shapes the
  // family can act on, not just count.
  const lists = new Map<string, { name: string; items: { id: number; content: string; done: boolean }[] }>()
  for (const r of rows(listRows)) {
    const name = String(r.name)
    const list = lists.get(name) ?? { name, items: [] }
    if (r.id != null) list.items.push({ id: n(r.id), content: String(r.content), done: Boolean(r.done) })
    lists.set(name, list)
  }

  const c = one(counts)
  return {
    timezone: timezone(),
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
      nextRun: r.enabled ? formatLocal(new Date(r.next_run_at as string)) : null,
    })),
    lists: [...lists.values()].map((l) => ({
      name: l.name,
      open: l.items.filter((i) => !i.done).length,
      total: l.items.length,
      items: l.items,
    })),
    proposals: rows(proposalRows).map((r) => ({
      id: n(r.id),
      title: String(r.title),
      when: whenText(r),
      chat: String(r.chat),
      // The first line of what the bot found, so the family can judge without opening the chat.
      detail: [r.location ? String(r.location) : null, r.description ? String(r.description).split('\n')[0].slice(0, 140) : null]
        .filter(Boolean)
        .join(' · '),
    })),
  }
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
    // An event spanning days should appear on each of them.
    for (let at = starts.getTime(); at <= Math.max(starts.getTime(), ends.getTime() - 1); at += DAY_MS) {
      const key = localDateKey(new Date(at))
      if (!key.startsWith(view.key)) continue
      const list = byDate.get(key) ?? []
      list.push({
        title: String(r.title),
        time: allDay ? null : timeOnly(starts),
      })
      byDate.set(key, list)
      if (allDay && ends.getTime() - starts.getTime() <= DAY_MS) break
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
    db().execute(sql`
      select title, starts_at, ends_at, all_day from family_events
      where not cancelled and ends_at >= ${view.from} and starts_at <= ${view.to}
      order by starts_at
    `),
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
