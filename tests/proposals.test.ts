import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'
import { buildTools } from '@/lib/tools'
import { proposalTools, acceptProposal, standingProposal, sameTitle, type AcceptResult } from '@/lib/tools/proposals'
import { localToUtc } from '@/lib/cron'

let client: PGlite
let ctx: ToolContext

/**
 * Fixed dates well ahead of the clock, so nothing here is ever an occasion
 * that has passed. The tools read "now" from the context; the queries that
 * hide a past proposal read the real clock, which these are ahead of too.
 */
const NOW = new Date('2030-01-15T00:00:00Z')

type Run = (name: string, args: unknown) => Promise<Record<string, unknown>>
const runWith = (c: ToolContext): Run => (name, args) =>
  ((proposalTools(c) as Record<string, { execute: unknown }>)[name].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})
const run: Run = (name, args) => runWith(ctx)(name, args)
/** As an MCP client's call is run: through the household's instrumented tools, so what changed is on the record. */
const viaClient: Run = (name, args) =>
  ((buildTools(ctx) as unknown as Record<string, { execute: unknown }>)[name].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})

const NOTICE = {
  title: 'School photo day',
  start: '2030-09-09T09:00',
  all_day: false,
  location: 'Brighton Primary',
  source: 'google:18f2ab',
}

const proposals = () => client.query<{ id: number; title: string; status: string; source: string | null }>('select id, title, status, source from event_proposals order by id').then((r) => r.rows)
const familyEvents = () => q.listFamilyEvents(new Date('2030-01-01'), new Date('2031-01-01'))

beforeEach(async () => {
  client = (await freshDb()).client
  const member = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
  ctx = { member, memberName: 'Rowan', now: NOW, via: 'mcp', cursorScope: 'key:1' }
})
afterEach(async () => closeDb(client))

describe('propose_family_event', () => {
  it('stores a proposal rather than adding the event', async () => {
    const r = await run('propose_family_event', NOTICE)
    expect(r).toMatchObject({ proposal_id: 1, title: 'School photo day', location: 'Brighton Primary' })
    expect(await familyEvents()).toEqual([])
    expect(String(r.next_step)).toContain('Do not add it yourself')
    expect(await q.getProposal(1)).toMatchObject({ memberId: ctx.member!.id, source: 'google:18f2ab', status: 'pending' })
  })

  it('reads a date alone as all day, a whole local day long even on the day the clocks go back', async () => {
    const r = await run('propose_family_event', { title: 'Swap day', start: '2030-04-07', all_day: false, source: 'google:swap' })
    const row = (await q.getProposal(Number(r.proposal_id)))!
    expect(row.allDay).toBe(true)
    // Melbourne midnight on 7 April 2030 is 13:00 UTC the day before, and the day is 25 hours long.
    expect(row.startsAt.toISOString()).toBe('2030-04-06T13:00:00.000Z')
    expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(25 * 3_600_000)
    expect(r.all_day).toBe(true)
    expect(String(r.start_local)).toMatch(/^Sun,? 7 Apr 2030$/)
  })

  it('checks the whole local day for what is already on, by the calendar and by overlap', async () => {
    await q.addProposal({ memberId: null, title: 'Camp', startsAt: new Date('2030-04-05T13:00:00Z'), endsAt: new Date('2030-04-08T14:00:00Z'), allDay: true, source: 'x' })
    const r = await run('propose_family_event', { title: 'Swap day', start: '2030-04-07', all_day: true, source: 'google:swap2' })
    // A proposal that began two days earlier is on that day too.
    expect(r.not_proposed_yet).toBe(true)
    expect((r.that_day_already_has as { awaiting_yes: { title: string }[] }).awaiting_yes.map((p) => p.title)).toEqual(['Camp'])
    expect(await proposals()).toHaveLength(1)
  })

  it('reads the local time as Melbourne, not UTC, and defaults the end to an hour after the start', async () => {
    const r = await run('propose_family_event', NOTICE)
    const row = (await q.getProposal(Number(r.proposal_id)))!
    // 9am on 9 Sep in Melbourne is 23:00 UTC the day before (AEST, UTC+10).
    expect(row.startsAt.toISOString()).toBe('2030-09-08T23:00:00.000Z')
    expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(3_600_000)
  })

  it('gives an all-day event a full day, and reads an all-day end as the last day the event covers', async () => {
    const day = await run('propose_family_event', { ...NOTICE, start: '2030-09-09', all_day: true })
    const one = (await q.getProposal(Number(day.proposal_id)))!
    expect(one.endsAt.getTime() - one.startsAt.getTime()).toBe(86_400_000)
    // A notice's "Fri 11 to Sun 13 October" includes the Sunday.
    const camp = await run('propose_family_event', { title: 'Camp', start: '2030-10-11', end: '2030-10-13', all_day: true, source: 'google:camp' })
    expect(await q.getProposal(Number(camp.proposal_id))).toMatchObject({ allDay: true, startsAt: new Date('2030-10-10T13:00:00Z'), endsAt: new Date('2030-10-13T13:00:00Z') })
  })

  it('honours an explicit end time instead of defaulting the duration', async () => {
    const r = await run('propose_family_event', { ...NOTICE, end: '2030-09-09T11:00', source: 'google:with-end' })
    expect((await q.getProposal(Number(r.proposal_id)))!.endsAt.toISOString()).toBe('2030-09-09T01:00:00.000Z')
  })

  it('holds a same-day find under another name for judgement instead of proposing blind', async () => {
    await run('propose_family_event', { ...NOTICE, source: undefined })
    const again = await run('propose_family_event', { ...NOTICE, title: 'Photo day (school notice)', source: undefined })
    expect(again.not_proposed_yet).toBe(true)
    const listed = (again.that_day_already_has as { awaiting_yes: { title: string }[] }).awaiting_yes
    expect(listed.map((p) => p.title)).toEqual(['School photo day'])
    expect(await proposals()).toHaveLength(1)
  })

  it('proposes a judged-distinct event on a busy day', async () => {
    await run('propose_family_event', { ...NOTICE, source: undefined })
    const r = await run('propose_family_event', { ...NOTICE, title: 'Swimming carnival', source: undefined, confirmed_distinct: true })
    expect(r.proposal_id).toBe(2)
    expect(await proposals()).toHaveLength(2)
  })

  it('hands the model whatever the calendar already holds that day', async () => {
    await q.addFamilyEvent({ title: "Junior School Father's Day Breakfast", startsAt: new Date('2030-09-08T21:30:00Z'), endsAt: new Date('2030-09-08T22:30:00Z'), allDay: false, location: 'Junior Schools', createdBy: null })
    const r = await run('propose_family_event', { ...NOTICE, title: "Riverbend Junior School Fathers' Day Brekky" })
    expect(r.not_proposed_yet).toBe(true)
    const cal = (r.that_day_already_has as { on_calendar: { title: string; location: string }[] }).on_calendar
    expect(cal[0]).toMatchObject({ title: "Junior School Father's Day Breakfast", location: 'Junior Schools' })
    expect(await proposals()).toHaveLength(0)
  })

  it('records no member when nobody is attributed, proposing or accepting', async () => {
    const guest = runWith({ ...ctx, member: null })
    const r = await guest('propose_family_event', { ...NOTICE, source: 'google:guest' })
    expect((await q.getProposal(Number(r.proposal_id)))!.memberId).toBeNull()
    expect((await guest('accept_event_proposal', { proposal_id: r.proposal_id })).status).toBe('added')
    expect((await familyEvents())[0].createdBy).toBeNull()
  })
})

describe('the same mail swept twice makes one proposal', () => {
  type Mail = { id: string; provider: 'google' | 'microsoft'; subject: string; events: { title: string; start: string; end?: string; all_day?: boolean }[] }

  /**
   * One sweep over the mail, as an MCP client reading the morning brief or a
   * scheduled job told to put the mail's dates to the family would run it:
   * every calendar-worthy date proposed, tagged with the message it came from,
   * and a message holding several dates tagged with each date as well.
   */
  async function sweep(mail: Mail[], opts: { tag?: 'message' | 'dated' | 'none'; title?: (t: string) => string } = {}) {
    const results: Record<string, unknown>[] = []
    for (const m of mail) {
      for (const e of m.events) {
        const tag = opts.tag ?? 'message'
        const source = tag === 'none' ? undefined : tag === 'dated' ? `${m.provider}:${m.id}/${e.start.slice(0, 10)}` : `${m.provider}:${m.id}`
        results.push(await run('propose_family_event', {
          title: opts.title ? opts.title(e.title) : e.title,
          start: e.start,
          ...(e.end ? { end: e.end } : {}),
          all_day: e.all_day ?? false,
          description: `From the school office, "${m.subject}".`,
          ...(source ? { source } : {}),
        }))
      }
    }
    return results
  }

  const carnival: Mail = { id: '18f2ab', provider: 'google', subject: 'Athletics carnival', events: [{ title: 'Athletics carnival', start: '2030-10-15', all_day: true }] }

  it('hands the second sweep the proposal the first one made, by its source', async () => {
    const [first] = await sweep([carnival])
    const [second] = await sweep([carnival])
    expect(first.proposal_id).toBe(1)
    expect(second).toMatchObject({ already_proposed: true, proposal_id: first.proposal_id, title: 'Athletics carnival' })
    expect(String(second.next_step)).toContain('already waiting on a yes')
    expect(await proposals()).toEqual([expect.objectContaining({ id: 1, title: 'Athletics carnival', status: 'pending' })])
  })

  it('knows the message whether or not the date was added after a slash', async () => {
    const [first] = await sweep([carnival], { tag: 'message' })
    const [second] = await sweep([carnival], { tag: 'dated' })
    expect(second).toMatchObject({ already_proposed: true, proposal_id: first.proposal_id })
    // And the other way round, on another message.
    const notice: Mail = { id: 'ab12', provider: 'microsoft', subject: 'Excursion', events: [{ title: 'Zoo excursion', start: '2030-11-03T09:00' }] }
    const [dated] = await sweep([notice], { tag: 'dated' })
    const [plain] = await sweep([notice], { tag: 'message' })
    expect(plain).toMatchObject({ already_proposed: true, proposal_id: dated.proposal_id })
    expect(await proposals()).toHaveLength(2)
  })

  it('knows the occasion with no source at all, by its title and day, case and punctuation aside', async () => {
    const [first] = await sweep([carnival], { tag: 'none' })
    const [second] = await sweep([carnival], { tag: 'none', title: (t) => `${t.toUpperCase()}!` })
    expect(second).toMatchObject({ already_proposed: true, proposal_id: first.proposal_id })
    expect(await proposals()).toHaveLength(1)
  })

  it('does not put a notice the family turned down to them again', async () => {
    const [first] = await sweep([carnival])
    await run('reject_event_proposal', { proposal_id: first.proposal_id })
    const [again] = await sweep([carnival])
    expect(again.skipped).toBe(true)
    expect(again.proposal_id).toBe(first.proposal_id)
    expect(String(again.reason)).toContain('(rejected)')
    expect(String(again.reason)).toContain('turned down')
    // Nor under a reworded title with no source.
    const [reworded] = await sweep([carnival], { tag: 'none', title: (t) => t.toLowerCase() })
    expect(reworded.skipped).toBe(true)
    expect(await proposals()).toEqual([expect.objectContaining({ status: 'rejected' })])
  })

  it('does not put an accepted notice to them again either', async () => {
    const [first] = await sweep([carnival])
    await run('accept_event_proposal', { proposal_id: first.proposal_id })
    const [again] = await sweep([carnival])
    expect(again).toMatchObject({ skipped: true, proposal_id: first.proposal_id })
    expect(String(again.reason)).toContain('already accepted')
    expect(await familyEvents()).toHaveLength(1)
  })

  it('still proposes each date a message holds, and the same title on another day', async () => {
    const term: Mail = {
      id: 'term4', provider: 'google', subject: 'Term 4 dates',
      events: [{ title: 'Swimming', start: '2030-10-21T09:00' }, { title: 'Swimming', start: '2030-10-28T09:00' }],
    }
    const first = await sweep([term], { tag: 'dated' })
    expect(first.map((r) => r.proposal_id)).toEqual([1, 2])
    const second = await sweep([term], { tag: 'dated' })
    expect(second.map((r) => [r.already_proposed, r.proposal_id])).toEqual([[true, 1], [true, 2]])
    expect(await proposals()).toHaveLength(2)
  })

  it('makes one proposal when two sweeps of the same message land at once', async () => {
    const [a, b] = await Promise.all([sweep([carnival]), sweep([carnival])])
    expect([a[0], b[0]].map((r) => r.proposal_id)).toEqual([1, 1])
    expect(await proposals()).toHaveLength(1)
  })

  it('finds what stands in code, and passes over an expired or superseded one', async () => {
    const startsAt = localToUtc('2030-10-15')
    expect(await standingProposal({ title: 'Athletics carnival', startsAt, source: 'google:18f2ab' }, NOW)).toBeUndefined()
    const row = await q.addProposal({ memberId: null, title: 'Athletics Carnival', startsAt, endsAt: localToUtc('2030-10-16'), allDay: true, source: null })
    expect((await standingProposal({ title: 'athletics carnival', startsAt }, NOW))?.id).toBe(row.id)
    // Past its day, it is no longer standing by title.
    expect(await standingProposal({ title: 'athletics carnival', startsAt }, new Date('2030-10-17T00:00:00Z'))).toBeUndefined()
    await client.query(`update event_proposals set status = 'superseded' where id = $1`, [row.id])
    expect(await standingProposal({ title: 'athletics carnival', startsAt }, NOW)).toBeUndefined()
    expect(sameTitle('  School Photo Day!! ', 'school photo-day')).toBe(true)
    expect(sameTitle('School photo day', 'School photo night')).toBe(false)
  })

  it('keeps nothing on the record for a proposal that already stood', async () => {
    await viaClient('propose_family_event', { title: 'Athletics carnival', start: '2030-10-15', all_day: true, source: 'google:18f2ab' })
    await viaClient('propose_family_event', { title: 'Athletics carnival', start: '2030-10-15', all_day: true, source: 'google:18f2ab' })
    expect((await q.recentActivity({ memberId: ctx.member!.id })).map((a) => a.summary)).toEqual(['proposed "Athletics carnival" for the family calendar, waiting on a yes'])
  })
})

describe('accept_event_proposal', () => {
  const propose = async (over: Record<string, unknown> = {}) => Number((await run('propose_family_event', { ...NOTICE, ...over })).proposal_id)

  it('adds the event, and says so in status', async () => {
    const id = await propose({ end: '2030-09-09T10:30' })
    const r = await run('accept_event_proposal', { proposal_id: id }) as AcceptResult
    expect(r).toMatchObject({ status: 'added', proposal_id: id, title: 'School photo day', event_id: expect.any(Number) })
    if (r.status !== 'added') throw new Error('not added')
    expect(r.when).toMatch(/^Mon,? 9 Sept 2030, 9:00 am to 10:30 am$/)
    expect(r.note).toContain('few hours')
    const [event] = await familyEvents()
    expect(event).toMatchObject({ id: r.event_id, title: 'School photo day', createdBy: ctx.member!.id, location: 'Brighton Primary' })
    expect((await q.getProposal(id))!.status).toBe('accepted')
  })

  it('words an accepted all-day event by its dates, never as midnight', async () => {
    const id = await propose({ title: 'Camp', start: '2030-10-11', end: '2030-10-13', all_day: true, source: 'google:camp' })
    expect((await run('list_event_proposals', {})).proposals).toEqual([expect.objectContaining({ title: 'Camp', all_day: true })])
    const r = await run('accept_event_proposal', { proposal_id: id })
    expect(String(r.when)).toMatch(/^Fri,? 11 Oct 2030 to Sun,? 13 Oct 2030$/)
  })

  it('names a same-day clash and asks for a confirmation, and exactly that call adds it', async () => {
    const id = await propose()
    const clash = await q.addFamilyEvent({ title: 'Photo day', startsAt: new Date('2030-09-08T22:00:00Z'), endsAt: new Date('2030-09-08T23:30:00Z'), allDay: false, location: 'Hall', createdBy: null })
    const held = await run('accept_event_proposal', { proposal_id: id }) as AcceptResult
    expect(held.status).toBe('needs_confirmation')
    if (held.status !== 'needs_confirmation') throw new Error('not held')
    expect(held).toMatchObject({ proposal_id: id, title: 'School photo day' })
    expect(held.clashes).toEqual([{ event_id: clash.id, title: 'Photo day', when: expect.stringMatching(/^Mon,? 9 Sept 2030, 8:00 am to 9:30 am$/), location: 'Hall' }])
    expect(held.reason).toContain('"Photo day"')
    expect(held.reason).toMatch(/Mon,? 9 Sept 2030, 8:00 am to 9:30 am/)
    expect(held.reason).toContain('reject this proposal instead')
    expect(held.to_confirm).toEqual({ tool: 'accept_event_proposal', arguments: { proposal_id: id, confirmed_distinct: true } })
    expect(held.if_same).toEqual({ tool: 'reject_event_proposal', arguments: { proposal_id: id } })
    // Nothing happened yet.
    expect((await q.getProposal(id))!.status).toBe('pending')
    expect(await familyEvents()).toHaveLength(1)

    // The call it named, as it named it.
    const done = await run(held.to_confirm.tool, held.to_confirm.arguments)
    expect(done).toMatchObject({ status: 'added', proposal_id: id })
    expect((await familyEvents()).map((e) => e.title).sort()).toEqual(['Photo day', 'School photo day'])
  })

  it('names an all-day entry on that day by its date, not as midnight', async () => {
    const id = await propose()
    await q.addFamilyEvent({ title: 'Pupil-free day', startsAt: localToUtc('2030-09-09'), endsAt: localToUtc('2030-09-10'), allDay: true, createdBy: null })
    const held = await run('accept_event_proposal', { proposal_id: id })
    expect(held.status).toBe('needs_confirmation')
    expect((held.clashes as { when: string }[])[0].when).toMatch(/^Mon,? 9 Sept 2030$/)
  })

  it('fails, with why, for a proposal that is not waiting', async () => {
    expect(await run('accept_event_proposal', { proposal_id: 999 })).toEqual({ status: 'failed', proposal_id: 999, reason: 'There is no proposal 999.', error: 'There is no proposal 999.' })

    const accepted = await propose({ source: 'google:a' })
    await run('accept_event_proposal', { proposal_id: accepted })
    const twice = await run('accept_event_proposal', { proposal_id: accepted })
    expect(twice).toMatchObject({ status: 'failed', reason: '"School photo day" was already accepted and is on the family calendar.' })

    const rejected = await propose({ title: 'Disco', start: '2030-09-20T18:00', source: 'google:r' })
    await run('reject_event_proposal', { proposal_id: rejected })
    expect(await run('accept_event_proposal', { proposal_id: rejected })).toMatchObject({ status: 'failed', reason: '"Disco" was turned down, so it is not waiting for a yes any more.' })

    const superseded = await propose({ title: 'Fete', start: '2030-09-21T10:00', source: 'google:s' })
    await client.query(`update event_proposals set status = 'superseded' where id = $1`, [superseded])
    expect(await run('accept_event_proposal', { proposal_id: superseded })).toMatchObject({ status: 'failed', reason: '"Fete" reached the family calendar another way, so there is nothing to add.' })

    const marked = await propose({ title: 'Odd', start: '2030-09-22T10:00', source: 'google:o' })
    await client.query(`update event_proposals set status = 'mystery' where id = $1`, [marked])
    expect(await run('accept_event_proposal', { proposal_id: marked })).toMatchObject({ status: 'failed', reason: '"Odd" is not waiting for a yes.' })
    expect((await familyEvents()).map((e) => e.title)).toEqual(['School photo day'])
  })

  it('fails for an occasion that has passed, and for one already on the calendar as itself', async () => {
    const past = await propose({ title: 'Swim', start: '2030-02-01T09:00', source: 'google:p' })
    const later = await runWith({ ...ctx, now: new Date('2030-03-01T00:00:00Z') })('accept_event_proposal', { proposal_id: past })
    expect(later).toMatchObject({ status: 'failed' })
    expect(String(later.reason)).toMatch(/^"Swim" was on .*2030, 9:00 am, which has passed\.$/)

    const twin = await propose({ source: 'google:t' })
    const event = await q.addFamilyEvent({ title: 'school photo day', startsAt: new Date('2030-09-08T23:00:00Z'), endsAt: new Date('2030-09-09T00:00:00Z'), allDay: false, createdBy: null })
    const r = await run('accept_event_proposal', { proposal_id: twin })
    expect(r).toMatchObject({ status: 'failed', reason: `"School photo day" is already on the family calendar (event ${event.id}), so there is nothing to add. Reject the proposal to settle it.` })
    expect((await q.getProposal(twin))!.status).toBe('pending')
  })

  it('adds the event once when two yeses land together, and tells the second why', async () => {
    const id = await propose()
    const results = await Promise.all([
      acceptProposal(id, { memberId: ctx.member!.id, now: NOW }),
      acceptProposal(id, { memberId: ctx.member!.id, now: NOW }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['added', 'failed'])
    expect(results.find((r) => r.status === 'failed')).toMatchObject({ reason: '"School photo day" was already accepted and is on the family calendar.' })
    expect(await familyEvents()).toHaveLength(1)
  })

  it('says so when the proposal vanishes between being read and being claimed', async () => {
    const id = await propose()
    // Gone as the claim is tried: nothing left to name.
    await client.query(`create or replace function harness_gone() returns trigger language plpgsql as $$ begin delete from event_proposals where id = old.id; return null; end $$`)
    await client.query(`create trigger harness_gone before update on event_proposals for each row execute function harness_gone()`)
    expect(await acceptProposal(id, { memberId: null, now: NOW })).toMatchObject({ status: 'failed', reason: `There is no proposal ${id}.` })
  })

  it('reads the time from the clock when none is given', async () => {
    const id = await propose()
    expect(await acceptProposal(id, { memberId: null })).toMatchObject({ status: 'added' })
    expect((await familyEvents())[0].createdBy).toBeNull()
  })

  it('keeps on the record only the accept that added something', async () => {
    const id = await propose()
    await q.addFamilyEvent({ title: 'Photo day', startsAt: new Date('2030-09-08T22:00:00Z'), endsAt: new Date('2030-09-08T23:00:00Z'), allDay: false, createdBy: null })
    expect((await viaClient('accept_event_proposal', { proposal_id: id })).status).toBe('needs_confirmation')
    expect((await viaClient('accept_event_proposal', { proposal_id: 999 })).status).toBe('failed')
    expect((await viaClient('accept_event_proposal', { proposal_id: id, confirmed_distinct: true })).status).toBe('added')
    expect((await q.recentActivity({ memberId: ctx.member!.id })).map((a) => [a.tool, a.summary])).toEqual([
      ['accept_event_proposal', 'put "School photo day" on the family calendar'],
    ])
  })
})

describe('rejecting and listing', () => {
  it('says so when rejecting a proposal that is not pending', async () => {
    expect(String((await run('reject_event_proposal', { proposal_id: 999 })).error)).toContain('not pending')
  })

  it('lists only what is still waiting', async () => {
    await run('propose_family_event', NOTICE)
    await run('propose_family_event', { ...NOTICE, title: 'Athletics carnival', start: '2030-09-10T09:00', source: 'google:other' })
    await run('accept_event_proposal', { proposal_id: 1 })
    const r = await run('list_event_proposals', {})
    expect(r.timezone).toBe('Australia/Melbourne')
    expect((r.proposals as { title: string }[]).map((p) => p.title)).toEqual(['Athletics carnival'])
  })
})
