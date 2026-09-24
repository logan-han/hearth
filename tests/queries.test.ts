import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

let client: PGlite

beforeEach(async () => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

/** Push messages back in time, as the days a real chat has behind it would. */
const age = (days: number, where = 'true') =>
  client.query(`update messages set created_at = now() - make_interval(days => ${days}) where ${where}`)

describe('members', () => {
  it('creates on first sight and refreshes the name after', async () => {
    const first = await q.upsertMember('111', 'Rowan')
    const second = await q.upsertMember('111', 'Rowan Hale')
    expect(second.id).toBe(first.id)
    expect(second.name).toBe('Rowan Hale')
  })

  it('only ever raises privileges, never lowers them', async () => {
    await q.upsertMember('111', 'Rowan', { allowed: true, isAdmin: true })
    const plain = await q.upsertMember('111', 'Rowan')
    expect(plain.allowed).toBe(true)
    expect(plain.isAdmin).toBe(true)
  })

  it('starts a new member with no access at all', async () => {
    const m = await q.upsertMember('222', 'Guest')
    expect(m.allowed).toBe(false)
    expect(m.isAdmin).toBe(false)
  })

  it('revoking access also drops admin', async () => {
    await q.upsertMember('111', 'Rowan', { allowed: true, isAdmin: true })
    const revoked = await q.setMemberAllowed('111', false)
    expect(revoked?.allowed).toBe(false)
    expect(revoked?.isAdmin).toBe(false)
  })

  it('grants access when set to true', async () => {
    await q.upsertMember('222', 'Guest')
    const granted = await q.setMemberAllowed('222', true)
    expect(granted?.allowed).toBe(true)
  })

  it('lists only allowed members', async () => {
    await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.upsertMember('222', 'Guest')
    expect((await q.allowedMembers()).map((m) => m.name)).toEqual(['Rowan'])
  })

  it('returns undefined for someone unknown', async () => {
    expect(await q.memberByTelegramId('nope')).toBeUndefined()
  })
})

describe('chats and strangers', () => {
  beforeEach(async () => q.rememberChat('-100', 'group', 'Family'))

  it('records a stranger once', async () => {
    expect(await q.noteStranger('-100', { id: '9', name: 'Guest' })).toBe(true)
    expect(await q.noteStranger('-100', { id: '9', name: 'Guest' })).toBe(false)
    expect(await q.strangersIn('-100')).toHaveLength(1)
  })

  it('accumulates several and clears them individually', async () => {
    await q.noteStranger('-100', { id: '9', name: 'A' })
    await q.noteStranger('-100', { id: '8', name: 'B' })
    await q.clearStranger('-100', '9')
    expect((await q.strangersIn('-100')).map((s) => s.id)).toEqual(['8'])
  })

  it('is empty for a room never seen', async () => {
    expect(await q.strangersIn('-999')).toEqual([])
  })

  it('does not claim to have flagged a stranger in a room it has no row for', async () => {
    expect(await q.noteStranger('-999', { id: '9', name: 'Guest' })).toBe(false)
    expect(await q.strangersIn('-999')).toEqual([])
  })

  it('updates the title without losing strangers', async () => {
    await q.noteStranger('-100', { id: '9', name: 'A' })
    await q.rememberChat('-100', 'group', 'Renamed')
    expect(await q.strangersIn('-100')).toHaveLength(1)
  })

  it('treats a non-array strangers value as nobody, rather than throwing', async () => {
    const { db } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    await db().execute(sql`update chats set strangers = '{"not":"an array"}' where chat_id = '-100'`)
    expect(await q.strangersIn('-100')).toEqual([])
  })

  it('treats unparseable strangers text as nobody, rather than throwing', async () => {
    const { db } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    await db().execute(sql`update chats set strangers = 'not json at all' where chat_id = '-100'`)
    expect(await q.strangersIn('-100')).toEqual([])
  })

  it('keeps both of two strangers noted at the same moment', async () => {
    expect(await Promise.all([
      q.noteStranger('-100', { id: '9', name: 'A' }),
      q.noteStranger('-100', { id: '8', name: 'B' }),
    ])).toEqual([true, true])
    expect((await q.strangersIn('-100')).map((s) => s.id).sort()).toEqual(['8', '9'])
  })

  it('loses nobody when one stranger leaves as another arrives', async () => {
    await q.noteStranger('-100', { id: '9', name: 'A' })
    await Promise.all([q.clearStranger('-100', '9'), q.noteStranger('-100', { id: '8', name: 'B' })])
    expect(await q.strangersIn('-100')).toEqual([{ id: '8', name: 'B' }])
  })

  it('unflags someone vouched for in every room at once, and nobody else', async () => {
    await q.rememberChat('-200', 'supergroup', 'Cousins')
    await q.noteStranger('-100', { id: '9', name: 'Nan' })
    await q.noteStranger('-200', { id: '9', name: 'Nan' })
    await q.noteStranger('-200', { id: '8', name: 'Guest' })
    await q.clearStrangerEverywhere('9')
    expect(await q.strangersIn('-100')).toEqual([])
    expect(await q.strangersIn('-200')).toEqual([{ id: '8', name: 'Guest' }])
  })

  it("stops counting a room the bot was removed from as the household's, until it hears from it again", async () => {
    await q.rememberChat('-200', 'supergroup', 'Cousins')
    await q.rememberChat('111', 'private', null)
    await q.setChatLeft('-100', true)
    expect((await q.groupChats()).map((r) => r.chatId)).toEqual(['-200'])
    await q.rememberChat('-100', 'group', 'Family')
    expect((await q.groupChats()).map((r) => r.chatId)).toEqual(['-100', '-200'])
    await q.setChatLeft('-200', true)
    await q.setChatLeft('-200', false)
    expect((await q.groupChats()).map((r) => r.chatId)).toEqual(['-100', '-200'])
  })

  it("lists a member's groups by where they spoke last, leaving out DMs, rooms the bot left and others' rooms", async () => {
    const rowan = await q.upsertMember('111', 'Rowan', { allowed: true })
    const sam = await q.upsertMember('222', 'Sam', { allowed: true })
    await q.rememberChat('-200', 'supergroup', 'Cousins')
    await q.rememberChat('-300', 'group', 'Old test room')
    await q.rememberChat('-400', 'group', 'Parents')
    await q.rememberChat('111', 'private', null)
    const say = (chatId: string, memberId: number) => q.recordMessage({ chatId, memberId, role: 'user', content: 'hi' })
    await say('-100', rowan.id)
    await say('-200', rowan.id)
    await say('-300', rowan.id)
    await say('111', rowan.id)
    await say('-400', sam.id)
    await say('-100', rowan.id)
    await q.setChatLeft('-300', true)
    expect((await q.roomsOf(rowan.id)).map((r) => r.chatId)).toEqual(['-100', '-200'])
    expect((await q.roomsOf(sam.id)).map((r) => r.title)).toEqual(['Parents'])
  })
})

describe('a group made a supergroup', () => {
  const at = new Date('2026-09-20T00:00:00Z')

  it('carries everything kept under the old id across to the new one', async () => {
    await q.rememberChat('-5', 'group', 'Family')
    await q.noteStranger('-5', { id: '9', name: 'Eve' })
    const said = await q.recordMessage({ chatId: '-5', role: 'user', content: 'bins tonight' })
    await q.setChatSummary('-5', 'Talked about bins.', said)
    const brief = await q.addAutomation({ chatId: '-5', label: 'Morning brief', cronExpr: '0 7 * * *', instruction: 'x', kind: 'morning', nextRunAt: at })
    await q.setAutomationEnabled(brief.id, false)
    await q.addAutomation({ chatId: '-5', label: 'bins', cronExpr: '0 19 * * 1', instruction: 'remind', nextRunAt: at })
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.createDraft({ chatId: '-5', memberId: m.id, provider: 'google', to: ['a@b.com'], subject: 'S', body: 'B' })
    await q.addProposal({ chatId: '-5', title: 'Fete', startsAt: at, endsAt: at })
    await q.setSetting('mail_cursor:-5:1:google', 'seen')
    await q.setSetting('proactive_posts:-5', '[1]')
    await q.setSetting('mail_cursor:-55:1:google', 'another room')

    await q.moveChat('-5', '-1005')

    expect(await q.strangersIn('-1005')).toEqual([{ id: '9', name: 'Eve' }])
    expect(await q.chatSummary('-1005')).toEqual({ summary: 'Talked about bins.', through: said })
    expect((await q.groupChats()).map((r) => [r.chatId, r.title])).toEqual([['-1005', 'Family']])
    expect((await q.recentMessages('-1005')).map((r) => r.content)).toEqual(['bins tonight'])
    expect(await q.recentMessages('-5')).toEqual([])
    const rows = await q.listAutomations('-1005')
    expect(rows.map((a) => [a.kind, a.enabled]).sort()).toEqual([[null, true], ['morning', false]])
    expect(await q.pendingDrafts('-1005')).toHaveLength(1)
    expect(await q.pendingProposals('-1005', new Date('2026-01-01'))).toHaveLength(1)
    expect(await q.getSetting('mail_cursor:-1005:1:google')).toBe('seen')
    expect(await q.getSetting('proactive_posts:-1005')).toBe('[1]')
    expect(await q.getSetting('mail_cursor:-5:1:google')).toBeNull()
    expect(await q.getSetting('mail_cursor:-55:1:google')).toBe('another room')

    // The other end of the upgrade says the same; there is nothing left to move.
    await q.moveChat('-5', '-1005')
    await q.moveChat('-1005', '-1005')
    expect(await q.listAutomations('-1005')).toHaveLength(2)
    expect(await q.strangersIn('-1005')).toHaveLength(1)
  })

  it('merges into a new room someone already spoke in, the household keeping its own watchers', async () => {
    await q.rememberChat('-5', 'group', 'Family')
    await q.noteStranger('-5', { id: '9', name: 'Eve' })
    await q.noteStranger('-5', { id: '7', name: 'Ted' })
    await q.setChatSummary('-5', 'The long story.', 40)
    const old = await q.addAutomation({ chatId: '-5', label: 'Morning brief', cronExpr: '0 7 * * *', instruction: 'x', kind: 'morning', nextRunAt: at })
    await q.setSetting('mail_cursor:-1005:1:google', 'newer')
    await q.setSetting('mail_cursor:-5:1:google', 'older')

    await q.rememberChat('-1005', 'supergroup', 'Family')
    await q.noteStranger('-1005', { id: '9', name: 'Eve' })
    await q.noteStranger('-1005', { id: '6', name: 'Val' })
    await q.addAutomation({ chatId: '-1005', label: 'Morning brief', cronExpr: '0 7 * * *', instruction: 'x', kind: 'morning', nextRunAt: at })
    await q.addAutomation({ chatId: '-1005', label: 'Money snapshot', cronExpr: '0 18 * * 0', instruction: 'y', kind: 'snapshot', nextRunAt: at })

    await q.moveChat('-5', '-1005')

    expect((await q.strangersIn('-1005')).map((s) => s.id).sort()).toEqual(['6', '7', '9'])
    expect(await q.chatSummary('-1005')).toEqual({ summary: 'The long story.', through: 40 })
    const rows = await q.listAutomations('-1005')
    expect(rows.map((a) => a.kind).sort()).toEqual(['morning', 'snapshot'])
    expect(rows.find((a) => a.kind === 'morning')!.id).toBe(old.id)
    expect(await q.getSetting('mail_cursor:-1005:1:google')).toBe('newer')
    expect(await q.getSetting('mail_cursor:-5:1:google')).toBeNull()
  })

  it("keeps the new room's own summary when the old one had none", async () => {
    await q.rememberChat('-5', 'group', 'Family')
    await q.rememberChat('-1005', 'supergroup', 'Family')
    await q.setChatSummary('-1005', 'Since the upgrade.', 12)
    await q.moveChat('-5', '-1005')
    expect(await q.chatSummary('-1005')).toEqual({ summary: 'Since the upgrade.', through: 12 })
  })
})

describe('messages', () => {
  it('excludes the message being answered from its own history', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.recordMessage({ chatId: 'c', memberId: m.id, authorName: 'Rowan', role: 'user', content: 'first' })
    const id = await q.recordMessage({ chatId: 'c', memberId: m.id, authorName: 'Rowan', role: 'user', content: 'second' })
    const history = await q.recentMessages('c', 30, id)
    expect(history.map((h) => h.content)).toEqual(['first'])
  })

  it('leaves out what members said after the message being answered, but keeps the replies since', async () => {
    await q.recordMessage({ chatId: 'c', authorName: 'Rowan', role: 'user', content: 'add milk' })
    const id = await q.recordMessage({ chatId: 'c', authorName: 'Rowan', role: 'user', content: 'actually, oat milk' })
    await q.recordMessage({ chatId: 'c', role: 'assistant', content: 'Added milk.' })
    await q.recordMessage({ chatId: 'c', authorName: 'Sam', role: 'user', content: 'and bread' })
    const history = await q.recentMessages('c', 30, id)
    expect(history.map((h) => h.content)).toEqual(['add milk', 'Added milk.'])
  })

  it('returns oldest first', async () => {
    for (const t of ['a', 'b', 'c']) {
      await q.recordMessage({ chatId: 'c', role: 'user', content: t })
    }
    expect((await q.recentMessages('c')).map((m) => m.content)).toEqual(['a', 'b', 'c'])
  })

  it('truncates very long content rather than failing', async () => {
    const id = await q.recordMessage({ chatId: 'c', role: 'user', content: 'x'.repeat(20000) })
    expect(id).toBeGreaterThan(0)
    expect((await q.recentMessages('c'))[0].content).toHaveLength(8000)
  })

  it('prunes down to the most recent N once they are older than the fortnight kept', async () => {
    for (let i = 0; i < 12; i++) {
      await q.recordMessage({ chatId: 'c', role: 'user', content: `m${i}` })
    }
    await age(15)
    await q.pruneMessages('c', 5)
    const left = await q.recentMessages('c', 50)
    expect(left).toHaveLength(5)
    expect(left.map((m) => m.content)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11'])
  })

  it('keeps a fortnight of talk however many rows it runs to, so System can chart it', async () => {
    for (let i = 0; i < 12; i++) {
      await q.recordMessage({ chatId: 'c', role: 'user', content: `m${i}` })
    }
    await age(15, `content in ('m0', 'm1', 'm2')`)
    await q.pruneMessages('c', 5)
    expect((await q.recentMessages('c', 50)).map((m) => m.content)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'])
  })

  it('prunes one chat without touching another', async () => {
    for (let i = 0; i < 4; i++) await q.recordMessage({ chatId: 'a', role: 'user', content: `${i}` })
    await q.recordMessage({ chatId: 'b', role: 'user', content: 'keep' })
    await age(15)
    await q.pruneMessages('a', 1)
    expect(await q.recentMessages('a')).toHaveLength(1)
    expect(await q.recentMessages('b')).toHaveLength(1)
  })
})

describe('messagesSince', () => {
  it('returns recent talk across every chat, oldest first, with a default limit', async () => {
    await q.recordMessage({ chatId: 'a', authorName: 'Rowan', role: 'user', content: 'one' })
    await q.recordMessage({ chatId: 'b', authorName: 'Ada', role: 'user', content: 'two' })
    const rows = await q.messagesSince(24)
    expect(rows.map((r) => r.content)).toEqual(['one', 'two'])
    expect(rows[0]).toMatchObject({ chatId: 'a', authorName: 'Rowan', role: 'user' })
  })

  it('keeps the newest talk when a busy day runs past the limit', async () => {
    for (let i = 0; i < 5; i++) await q.recordMessage({ chatId: 'a', role: 'user', content: `m${i}` })
    expect((await q.messagesSince(24, 3)).map((r) => r.content)).toEqual(['m2', 'm3', 'm4'])
  })

  it('excludes talk from before the window', async () => {
    const id = await q.recordMessage({ chatId: 'a', role: 'user', content: 'old' })
    const { db } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    await db().execute(sql`update messages set created_at = now() - interval '2 hours' where id = ${id}`)
    await q.recordMessage({ chatId: 'a', role: 'user', content: 'new' })
    expect((await q.messagesSince(1)).map((r) => r.content)).toEqual(['new'])
  })
})

describe('connections', () => {
  it('encrypts the refresh token at rest and decrypts it back', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'r3fr3sh', scopes: 's' })
    const conn = await q.connectionFor(m.id, 'google')
    expect(conn!.refreshToken).not.toContain('r3fr3sh')
    expect(await q.decryptRefreshToken(conn!)).toBe('r3fr3sh')
  })

  it('replaces the token when the same provider is relinked', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'old', scopes: null })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'new', scopes: null })
    expect(await q.connectionsFor(m.id)).toHaveLength(1)
    expect(await q.decryptRefreshToken((await q.connectionFor(m.id, 'google'))!)).toBe('new')
  })

  it('keeps the two providers separate', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'g', scopes: null })
    await q.saveConnection({ memberId: m.id, provider: 'microsoft', email: null, refreshToken: 'm', scopes: null })
    expect(await q.connectionsFor(m.id)).toHaveLength(2)
    await q.deleteConnection(m.id, 'google')
    expect((await q.connectionsFor(m.id)).map((c) => c.provider)).toEqual(['microsoft'])
  })

  it('disappears with the member', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'g', scopes: null })
    const { db } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    await db().execute(sql`delete from members where id = ${m.id}`)
    expect(await q.connectionsFor(m.id)).toHaveLength(0)
  })
})

describe('family events and the ICS feed', () => {
  const at = (iso: string) => new Date(iso)

  it('gives every event a unique uid', async () => {
    const a = await q.addFamilyEvent({ title: 'A', startsAt: at('2026-09-01T00:00:00Z'), endsAt: at('2026-09-01T01:00:00Z') })
    const b = await q.addFamilyEvent({ title: 'B', startsAt: at('2026-09-01T00:00:00Z'), endsAt: at('2026-09-01T01:00:00Z') })
    expect(a.uid).not.toBe(b.uid)
    expect(a.uid).toMatch(/@hearth$/)
  })

  it('lists a window by start time, in order', async () => {
    await q.addFamilyEvent({ title: 'later', startsAt: at('2026-09-10T00:00:00Z'), endsAt: at('2026-09-10T01:00:00Z') })
    await q.addFamilyEvent({ title: 'sooner', startsAt: at('2026-09-02T00:00:00Z'), endsAt: at('2026-09-02T01:00:00Z') })
    const rows = await q.listFamilyEvents(at('2026-09-01T00:00:00Z'), at('2026-09-30T00:00:00Z'))
    expect(rows.map((r) => r.title)).toEqual(['sooner', 'later'])
  })

  it('excludes events outside the window', async () => {
    await q.addFamilyEvent({ title: 'old', startsAt: at('2025-01-01T00:00:00Z'), endsAt: at('2025-01-01T01:00:00Z') })
    expect(await q.listFamilyEvents(at('2026-01-01T00:00:00Z'), at('2026-12-31T00:00:00Z'))).toHaveLength(0)
  })

  it('lists what is on during a range, not only what starts in it', async () => {
    // Melbourne, September (UTC+10). Camp Fri to Mon all day; a weekend away Fri 6pm to Sun 10am.
    await q.addFamilyEvent({ title: 'Camp', allDay: true, startsAt: at('2026-09-24T14:00:00Z'), endsAt: at('2026-09-28T14:00:00Z') })
    await q.addFamilyEvent({ title: 'Weekend away', startsAt: at('2026-09-25T08:00:00Z'), endsAt: at('2026-09-27T00:00:00Z') })
    // Thursday all day, which ends exactly at Friday's midnight.
    await q.addFamilyEvent({ title: 'Thursday', allDay: true, startsAt: at('2026-09-23T14:00:00Z'), endsAt: at('2026-09-24T14:00:00Z') })
    // Monday at midnight, exactly where a Sunday range ends.
    await q.addFamilyEvent({ title: 'Monday', startsAt: at('2026-09-27T14:00:00Z'), endsAt: at('2026-09-27T15:00:00Z') })
    // A zero-length entry at Sunday's midnight.
    await q.addFamilyEvent({ title: 'Marker', startsAt: at('2026-09-26T14:00:00Z'), endsAt: at('2026-09-26T14:00:00Z') })

    // Sunday 27 September, midnight to midnight.
    const sunday = await q.listFamilyEvents(at('2026-09-26T14:00:00Z'), at('2026-09-27T14:00:00Z'))
    expect(sunday.map((e) => e.title)).toEqual(['Camp', 'Weekend away', 'Marker'])
  })

  it('drops cancelled events from the feed, since subscribers mirror what they see', async () => {
    // Outlook renders a STATUS:CANCELLED event rather than hiding it; clients
    // reliably remove an event only when it stops appearing in the feed.
    const keep = await q.addFamilyEvent({ title: 'Stays', startsAt: at('2026-09-01T00:00:00Z'), endsAt: at('2026-09-01T01:00:00Z') })
    const gone = await q.addFamilyEvent({ title: 'Gone', startsAt: at('2026-09-02T00:00:00Z'), endsAt: at('2026-09-02T01:00:00Z') })
    await q.cancelFamilyEvent(gone.id)
    const feed = await q.allFamilyEventsForFeed(at('2026-01-01T00:00:00Z'))
    expect(feed.map((e) => e.id)).toEqual([keep.id])
  })

  it('drops events that finished before the feed window', async () => {
    await q.addFamilyEvent({ title: 'ancient', startsAt: at('2020-01-01T00:00:00Z'), endsAt: at('2020-01-01T01:00:00Z') })
    expect(await q.allFamilyEventsForFeed(at('2026-01-01T00:00:00Z'))).toHaveLength(0)
  })

  it('reports nothing for a cancel of an unknown id', async () => {
    expect(await q.cancelFamilyEvent(999)).toBeUndefined()
  })

  it('updates an event in place, keeping its uid and moving updated_at so the feed bumps SEQUENCE', async () => {
    const e = await q.addFamilyEvent({ title: 'Vacation care', startsAt: at('2026-09-29T14:00:00Z'), endsAt: at('2026-09-30T14:00:00Z'), allDay: true })
    await new Promise((r) => setTimeout(r, 5))
    const row = (await q.updateFamilyEvent(e.id, { title: 'Scouts Cuboree' }))!
    expect(row.uid).toBe(e.uid)
    expect(row.title).toBe('Scouts Cuboree')
    expect(row.startsAt.getTime()).toBe(e.startsAt.getTime())
    expect(row.updatedAt.getTime()).toBeGreaterThan(e.updatedAt.getTime())
    expect((await q.getFamilyEvent(e.id))!.title).toBe('Scouts Cuboree')
  })

  it('will not update a cancelled event, which subscribers no longer see', async () => {
    const e = await q.addFamilyEvent({ title: 'Gone', startsAt: at('2026-09-01T00:00:00Z'), endsAt: at('2026-09-01T01:00:00Z') })
    await q.cancelFamilyEvent(e.id)
    expect(await q.updateFamilyEvent(e.id, { title: 'Back?' })).toBeUndefined()
    expect(await q.getFamilyEvent(999)).toBeUndefined()
  })
})

describe('memories', () => {
  it('stores, lists newest first, and forgets', async () => {
    const a = await q.addMemory('bin night is Monday')
    await q.addMemory('milk allergy')
    const rows = await q.listMemories()
    expect(rows.map((r) => r.content)).toEqual(['milk allergy', 'bin night is Monday'])
    await q.deleteMemory(a.id)
    expect(await q.listMemories()).toHaveLength(1)
  })

  it('keeps a forgotten fact as history rather than deleting the row', async () => {
    const a = await q.addMemory('bin night is Monday')
    await q.deleteMemory(a.id)
    const { db, schema } = await import('@/lib/db')
    const [row] = await db().select().from(schema.memories)
    expect(row.id).toBe(a.id)
    expect(row.invalidatedAt).not.toBeNull()
    expect(row.supersededBy).toBeNull()
  })

  it('supersedes the old fact in the same step as storing the correction', async () => {
    const old = await q.addMemory('bin night is Tuesday')
    const fresh = await q.addMemory('bin night is Monday', null, old.id)
    expect((await q.listMemories()).map((m) => m.id)).toEqual([fresh.id])
    const { db, schema } = await import('@/lib/db')
    const rows = await db().select().from(schema.memories)
    expect(rows.find((r) => r.id === old.id)?.supersededBy).toBe(fresh.id)
  })
})

describe('memory questions', () => {
  it('asks once, lists open and unasked, marks asked, and settles claim-first', async () => {
    const first = await q.askQuestion({ question: 'Who attends Hillside Grammar?', candidate: 'Juno attends Hillside Grammar' })
    const again = await q.askQuestion({ question: 'who attends hillside grammar?', candidate: 'someone else' })
    expect(first.fresh).toBe(true)
    expect(again.fresh).toBe(false)
    expect(again.row.id).toBe(first.row.id)
    const second = await q.askQuestion({ question: 'Whose uniform is the order for?', candidate: 'Ada attends Riverbend Primary' })
    expect((await q.openQuestions()).map((r) => r.id)).toEqual([first.row.id, second.row.id])

    await q.markQuestionsAsked([first.row.id])
    await q.markQuestionsAsked([])
    expect((await q.unaskedQuestions()).map((r) => r.id)).toEqual([second.row.id])

    const yes = await q.answerQuestion(first.row.id, 'Juno attends Hillside Grammar', null)
    expect(yes!.memory!.content).toBe('Juno attends Hillside Grammar')
    expect(yes!.question.outcome).toBe('confirmed')
    expect(yes!.question.memoryId).toBe(yes!.memory!.id)
    expect(await q.answerQuestion(first.row.id, 'Juno attends Hillside Grammar', null)).toBeUndefined()

    const no = await q.answerQuestion(second.row.id, null)
    expect(no!.memory).toBeNull()
    expect(no!.question.outcome).toBe('dismissed')
    expect(await q.openQuestions()).toHaveLength(0)
    expect((await q.listMemories()).map((m) => m.content)).toEqual(['Juno attends Hillside Grammar'])
  })

  it('points a yes at a fact already known in other words rather than filing it twice', async () => {
    const known = await q.addMemory('Juno attends Hillside Grammar')
    const { row } = await q.askQuestion({ question: 'Who attends Hillside Grammar?', candidate: 'Juno attends Hillside Grammar' })
    const yes = await q.answerQuestion(row.id, 'Juno attends Hillside Grammar by the way', null)
    expect(yes!.memory!.id).toBe(known.id)
    expect(await q.listMemories()).toHaveLength(1)
  })
})

describe('chat summaries', () => {
  it('starts empty and remembers what it has covered', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    expect(await q.chatSummary('-100')).toEqual({ summary: null, through: 0 })
    await q.setChatSummary('-100', 'Talked about bins.', 42)
    expect(await q.chatSummary('-100')).toEqual({ summary: 'Talked about bins.', through: 42 })
  })

  it('lists messages after an id, oldest first', async () => {
    const a = await q.recordMessage({ chatId: '-100', authorName: 'Rowan', role: 'user', content: 'one' })
    await q.recordMessage({ chatId: '-100', authorName: 'Rowan', role: 'user', content: 'two' })
    await q.recordMessage({ chatId: '-200', authorName: 'Rowan', role: 'user', content: 'elsewhere' })
    expect((await q.messagesAfter('-100', a)).map((m) => m.content)).toEqual(['two'])
    expect((await q.messagesAfter('-100', 0)).map((m) => m.content)).toEqual(['one', 'two'])
  })
})

describe('automations', () => {
  const soon = new Date('2026-09-01T00:00:00Z')

  const make = () =>
    q.addAutomation({ chatId: 'c', label: 'bins', cronExpr: '0 19 * * 1', instruction: 'remind', nextRunAt: soon })

  it('is due once its time has passed', async () => {
    await make()
    expect(await q.dueAutomations(new Date('2026-09-02T00:00:00Z'))).toHaveLength(1)
    expect(await q.dueAutomations(new Date('2026-08-01T00:00:00Z'))).toHaveLength(0)
  })

  it('claims exactly once, so two ticks cannot double-run it', async () => {
    const a = await make()
    const next = new Date('2026-09-08T00:00:00Z')
    expect(await q.claimAutomation(a.id, soon, next)).toBe(true)
    expect(await q.claimAutomation(a.id, soon, next)).toBe(false)
  })

  it('claims a row whose time carries microseconds, as one nudged by hand in SQL does', async () => {
    const a = await make()
    await client.query(`update automations set next_run_at = next_run_at + interval '861 microseconds' where id = $1`, [a.id])
    expect(await q.claimAutomation(a.id, new Date(soon.getTime() + 1000), new Date('2026-09-08T00:00:00Z'))).toBe(true)
    expect((await q.getAutomation(a.id))!.nextRunAt).toEqual(new Date('2026-09-08T00:00:00Z'))
  })

  it('does not claim a row that is not yet due, nor a paused one', async () => {
    const a = await make()
    expect(await q.claimAutomation(a.id, new Date(soon.getTime() - 1000), new Date('2026-09-08T00:00:00Z'))).toBe(false)
    await q.setAutomationEnabled(a.id, false)
    expect(await q.claimAutomation(a.id, new Date(soon.getTime() + 1000), new Date('2026-09-08T00:00:00Z'))).toBe(false)
  })

  it('disables itself when there is no next run', async () => {
    const a = await make()
    await q.claimAutomation(a.id, soon, null)
    expect((await q.getAutomation(a.id))!.enabled).toBe(false)
  })

  it('skips disabled automations even when overdue', async () => {
    const a = await make()
    await q.setAutomationEnabled(a.id, false)
    expect(await q.dueAutomations(new Date('2026-12-01T00:00:00Z'))).toHaveLength(0)
  })

  it('resuming can reset the next run', async () => {
    const a = await make()
    await q.setAutomationEnabled(a.id, false)
    const later = new Date('2027-01-01T00:00:00Z')
    const row = await q.setAutomationEnabled(a.id, true, later)
    expect(row!.enabled).toBe(true)
    expect(row!.nextRunAt.toISOString()).toBe(later.toISOString())
  })

  it('holds a chat to one of each ready-made watcher, however many ticks install it at once', async () => {
    const brief = () =>
      q.addAutomation({ chatId: '-100', label: 'Morning brief', cronExpr: '0 7 * * *', instruction: 'x', kind: 'morning', nextRunAt: soon })
    const [a, b] = await Promise.all([brief(), brief()])
    expect(b.id).toBe(a.id)
    expect((await brief()).id).toBe(a.id)
    // Another chat, or a custom instruction, is its own row.
    await q.addAutomation({ chatId: '-200', label: 'Morning brief', cronExpr: '0 7 * * *', instruction: 'x', kind: 'morning', nextRunAt: soon })
    await make()
    await make()
    expect((await q.listAutomations()).map((r) => r.chatId).sort()).toEqual(['-100', '-200', 'c', 'c'])
  })

  it('lists per chat and deletes', async () => {
    const a = await make()
    await q.addAutomation({ chatId: 'other', label: 'x', cronExpr: '0 8 * * *', instruction: 'i', nextRunAt: soon })
    expect(await q.listAutomations('c')).toHaveLength(1)
    expect(await q.listAutomations()).toHaveLength(2)
    expect(await q.deleteAutomation(a.id)).toBe(true)
    expect(await q.deleteAutomation(a.id)).toBe(false)
  })
})

describe('email drafts', () => {
  const draft = async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    return q.createDraft({ chatId: 'c', memberId: m.id, provider: 'google', to: ['a@b.com'], subject: 's', body: 'b' })
  }

  it('joins recipients and starts pending', async () => {
    const d = await draft()
    expect(d.recipients).toBe('a@b.com')
    expect(d.status).toBe('pending')
  })

  it('joins several cc addresses', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    const d = await q.createDraft({ chatId: 'c', memberId: m.id, provider: 'google', to: ['a@b.com'], cc: ['c@d.com', 'e@f.com'], subject: 's', body: 'b' })
    expect(d.cc).toBe('c@d.com, e@f.com')
  })

  it('can only be sent once', async () => {
    const d = await draft()
    expect(await q.markDraft(d.id, 'sent')).toBe(true)
    expect(await q.markDraft(d.id, 'sent')).toBe(false)
  })

  it('can be handed back to pending after a failed send', async () => {
    const d = await draft()
    await q.markDraft(d.id, 'sent')
    expect(await q.markDraft(d.id, 'pending', 'sent')).toBe(true)
    expect((await q.getDraft(d.id))!.status).toBe('pending')
  })

  it('lists only pending ones for the chat', async () => {
    const d = await draft()
    await draft()
    await q.markDraft(d.id, 'cancelled')
    expect(await q.pendingDrafts('c')).toHaveLength(1)
  })
})

describe('shared lists', () => {
  it('creates on first use and matches case-insensitively', async () => {
    const a = await q.findOrCreateList('Shopping')
    const b = await q.findOrCreateList('  shopping ')
    expect(b.id).toBe(a.id)
    expect(await q.findList('SHOPPING')).toBeDefined()
  })

  it('gives two people starting the same new list at once the one list', async () => {
    const [a, b] = await Promise.all([q.findOrCreateList('Groceries'), q.findOrCreateList('groceries')])
    expect(b.id).toBe(a.id)
    expect(await q.allLists()).toEqual([{ name: 'groceries', open: 0 }])
  })

  it('ticks off by substring and counts what is open', async () => {
    const l = await q.findOrCreateList('shopping')
    await q.addListItems(l.id, ['2L milk', 'eggs'])
    const done = await q.markListItems(l.id, ['milk'], true)
    expect(done.map((d) => d.content)).toEqual(['2L milk'])
    expect((await q.listContents(l.id)).filter((i) => !i.done)).toHaveLength(1)
  })

  it('sorts open items ahead of done ones', async () => {
    const l = await q.findOrCreateList('shopping')
    await q.addListItems(l.id, ['a', 'b'])
    await q.markListItems(l.id, ['a'], true)
    expect((await q.listContents(l.id)).map((i) => i.content)).toEqual(['b', 'a'])
  })

  it('matches a needle longer than the item against the item it contains, and skips a blank needle', async () => {
    const l = await q.findOrCreateList('shopping')
    await q.addListItems(l.id, ['2L milk', 'eggs'])
    const done = await q.markListItems(l.id, ['  ', '2L milk please'], true)
    expect(done.map((d) => d.content)).toEqual(['2L milk'])
  })

  it('marks nothing when no needle matches anything', async () => {
    const l = await q.findOrCreateList('shopping')
    await q.addListItems(l.id, ['eggs'])
    expect(await q.markListItems(l.id, ['bacon'], true)).toEqual([])
  })

  it('clears only ticked items by default', async () => {
    const l = await q.findOrCreateList('shopping')
    await q.addListItems(l.id, ['a', 'b'])
    await q.markListItems(l.id, ['a'], true)
    expect(await q.clearList(l.id, true)).toHaveLength(1)
    expect(await q.listContents(l.id)).toHaveLength(1)
    expect(await q.clearList(l.id, false)).toHaveLength(1)
  })

  it('removes named ids and reports open counts per list', async () => {
    const l = await q.findOrCreateList('shopping')
    const [first] = await q.addListItems(l.id, ['a', 'b'])
    expect(await q.removeListItems(l.id, [first.id])).toHaveLength(1)
    expect(await q.allLists()).toEqual([{ name: 'shopping', open: 1 }])
  })

  it('counts an empty list as zero rather than omitting it', async () => {
    await q.findOrCreateList('packing')
    expect(await q.allLists()).toEqual([{ name: 'packing', open: 0 }])
  })

  it('sorts several lists alphabetically by name', async () => {
    await q.findOrCreateList('zzz list')
    await q.findOrCreateList('shopping')
    expect((await q.allLists()).map((l) => l.name)).toEqual(['shopping', 'zzz list'])
  })

  it('adding nothing is a no-op', async () => {
    const l = await q.findOrCreateList('shopping')
    expect(await q.addListItems(l.id, [])).toEqual([])
    expect(await q.removeListItems(l.id, [])).toEqual([])
  })
})

describe('event proposals', () => {
  // Far enough ahead that these stay in the future for the life of the test.
  const make = (source?: string) =>
    q.addProposal({
      chatId: 'c', title: 'Photo day',
      startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T00:00:00Z'),
      source: source ?? null,
    })

  it('finds an existing proposal by source', async () => {
    await make('google:abc')
    expect((await q.proposalForSource('google:abc'))!.title).toBe('Photo day')
    expect(await q.proposalForSource('google:other')).toBeUndefined()
  })

  it('refuses a duplicate source at the database level', async () => {
    await make('google:abc')
    await expect(make('google:abc')).rejects.toThrow()
  })

  it('allows many proposals with no source', async () => {
    await make()
    await make()
    expect(await q.pendingProposals('c')).toHaveLength(2)
  })

  it('lists proposals across every chat when none is named', async () => {
    await make('s1')
    await q.addProposal({
      chatId: 'other', title: 'Assembly',
      startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T00:00:00Z'),
    })
    expect(await q.pendingProposals(undefined, new Date('2030-01-01T00:00:00Z'))).toHaveLength(2)
  })

  it('settles exactly once', async () => {
    const p = await make('s1')
    expect(await q.settleProposal(p.id, 'accepted')).toBeDefined()
    expect(await q.settleProposal(p.id, 'accepted')).toBeUndefined()
  })

  it('drops out of the pending list once settled', async () => {
    const p = await make('s1')
    await q.settleProposal(p.id, 'rejected')
    expect(await q.pendingProposals('c')).toHaveLength(0)
  })

  it('hides a proposal whose occasion has passed, before anything has retired it', async () => {
    const past = await q.addProposal({
      chatId: 'c', title: 'Pharmacist call',
      startsAt: new Date('2030-08-31T14:00:00Z'), endsAt: new Date('2030-09-01T14:00:00Z'), allDay: true,
    })
    const future = await make('later')
    expect((await q.pendingProposals('c', new Date('2030-08-01T00:00:00Z'))).map((p) => p.id)).toEqual([past.id, future.id])
    expect((await q.pendingProposals('c', new Date('2030-09-05T00:00:00Z'))).map((p) => p.id)).toEqual([future.id])
    // The row itself is still pending until the tick retires it.
    expect((await q.proposalForSource('later'))!.status).toBe('pending')
  })

  it('hides a proposal once the same occasion is on the calendar by another route', async () => {
    const p = await make('s1')
    expect(await q.pendingProposals('c', new Date('2030-01-01T00:00:00Z'))).toHaveLength(1)
    const e = await q.addFamilyEvent({ title: ' photo DAY ', startsAt: p.startsAt, endsAt: p.endsAt })
    expect(await q.pendingProposals('c', new Date('2030-01-01T00:00:00Z'))).toHaveLength(0)
    // A cancelled event does not count as already there.
    await q.cancelFamilyEvent(e.id)
    expect(await q.pendingProposals('c', new Date('2030-01-01T00:00:00Z'))).toHaveLength(1)
    // A different occasion on the same day is not the same one.
    await q.addFamilyEvent({ title: 'Photo day', startsAt: new Date(p.startsAt.getTime() + 3_600_000), endsAt: p.endsAt })
    expect(await q.pendingProposals('c', new Date('2030-01-01T00:00:00Z'))).toHaveLength(1)
  })

  it('retires stale proposals with a status that says why, and leaves the live ones', async () => {
    const past = await q.addProposal({
      chatId: 'c', title: 'Pharmacist call',
      startsAt: new Date('2030-08-31T14:00:00Z'), endsAt: new Date('2030-09-01T14:00:00Z'), allDay: true,
    })
    const covered = await make('covered')
    await q.addFamilyEvent({ title: 'Photo day', startsAt: covered.startsAt, endsAt: covered.endsAt })
    const live = await q.addProposal({
      chatId: 'c', title: 'Concert',
      startsAt: new Date('2030-10-01T09:00:00Z'), endsAt: new Date('2030-10-01T10:00:00Z'),
    })
    const answered = await q.addProposal({
      chatId: 'c', title: 'Old but answered',
      startsAt: new Date('2030-08-01T00:00:00Z'), endsAt: new Date('2030-08-01T01:00:00Z'),
    })
    await q.settleProposal(answered.id, 'accepted')

    expect(await q.retireStaleProposals(new Date('2030-09-05T00:00:00Z'))).toEqual({ expired: 1, superseded: 1 })
    expect((await q.pendingProposals('c', new Date('2030-09-05T00:00:00Z'))).map((p) => p.id)).toEqual([live.id])
    expect((await q.proposalForSource('covered'))!.status).toBe('superseded')
    // Retired is settled: a late yes finds nothing to accept.
    expect(await q.settleProposal(past.id, 'accepted')).toBeUndefined()
    // Nothing left to do on a second pass.
    expect(await q.retireStaleProposals(new Date('2030-09-05T00:00:00Z'))).toEqual({ expired: 0, superseded: 0 })
  })
})

describe('settings and the calendar token', () => {
  it('round-trips a setting and overwrites it', async () => {
    await q.setSetting('k', 'v1')
    await q.setSetting('k', 'v2')
    expect(await q.getSetting('k')).toBe('v2')
    expect(await q.getSetting('missing')).toBeNull()
  })

  it('mints the calendar token once and keeps it', async () => {
    const first = await q.calendarToken()
    expect(first).toHaveLength(32)
    expect(await q.calendarToken()).toBe(first)
  })

  it('hands two first uses at once the same, stored, token', async () => {
    const [a, b] = await Promise.all([q.calendarToken(), q.calendarToken()])
    expect(b).toBe(a)
    expect(await q.getSetting('calendar_token')).toBe(a)
  })

  it('pauses a deleted member\'s own automations before the row that says whose they were goes', async () => {
    const m = await q.upsertMember('222', 'Nanny', { allowed: true })
    const at = new Date('2026-09-20T00:00:00Z')
    const own = await q.addAutomation({ chatId: '-100', memberId: m.id, label: 'mine', cronExpr: '0 9 * * *', instruction: 'x', nextRunAt: at })
    const watcher = await q.addAutomation({ chatId: '222', memberId: m.id, label: '2Up', cronExpr: '0 9 * * *', instruction: 'y', kind: 'money', nextRunAt: at })
    const theirs = await q.addAutomation({ chatId: '-100', memberId: null, label: 'household', cronExpr: '0 9 * * *', instruction: 'z', nextRunAt: at })
    expect(await q.deleteMember('222')).toBe(true)
    const rows = await q.listAutomations()
    expect(rows.find((a) => a.id === own.id)).toMatchObject({ enabled: false, memberId: null })
    // A ready-made watcher's words are the code's, and the household's own automations are untouched.
    expect(rows.find((a) => a.id === watcher.id)!.enabled).toBe(true)
    expect(rows.find((a) => a.id === theirs.id)!.enabled).toBe(true)
    expect(await q.deleteMember('222')).toBe(false)
  })

  it('replaces the calendar token when rotated, and keeps the new one', async () => {
    const first = await q.calendarToken()
    const second = await q.rotateCalendarToken()
    expect(second).toHaveLength(32)
    expect(second).not.toBe(first)
    expect(await q.calendarToken()).toBe(second)
  })

  it('keeps the previous tick beside the latest, so the cadence can be read off the pair', async () => {
    const first = new Date('2026-09-14T09:00:01Z')
    const second = new Date('2026-09-14T10:00:00Z')
    await q.recordTick(first)
    expect(await q.getSetting('last_tick_at')).toBe(first.toISOString())
    expect(await q.getSetting('prev_tick_at')).toBeNull()
    await q.recordTick(second)
    expect(await q.getSetting('last_tick_at')).toBe(second.toISOString())
    expect(await q.getSetting('prev_tick_at')).toBe(first.toISOString())
  })
})

describe('the migration that holds a chat to one of each watcher', () => {
  it('keeps the copy still running of a watcher two ticks had doubled, and nothing else changes', async () => {
    const { PGlite } = await import('@electric-sql/pglite')
    const { readFileSync } = await import('node:fs')
    const read = (path: string) => readFileSync(new URL(`../drizzle/${path}`, import.meta.url), 'utf8')
    const pg = new PGlite()
    const apply = async (tag: string) => {
      for (const statement of read(`${tag}.sql`).split('--> statement-breakpoint')) {
        if (statement.trim()) await pg.exec(statement)
      }
    }
    const tags = (JSON.parse(read('meta/_journal.json')) as { entries: { tag: string }[] }).entries.map((e) => e.tag)
    const at = tags.indexOf('0007_chat_lifecycle')
    for (const tag of tags.slice(0, at)) await apply(tag)
    await pg.exec(`
      insert into automations (chat_id, label, cron_expr, instruction, kind, next_run_at, enabled) values
        ('-100', 'Morning brief', '0 7 * * *', 'x', 'morning', now(), false),
        ('-100', 'Morning brief', '0 7 * * *', 'x', 'morning', now(), true),
        ('-100', 'Morning brief', '0 7 * * *', 'x', 'morning', now(), true),
        ('-100', 'bins', '0 19 * * 1', 'remind', null, now(), true),
        ('-100', 'bins', '0 19 * * 1', 'remind', null, now(), true),
        ('-200', 'Morning brief', '0 7 * * *', 'x', 'morning', now(), false)
    `)
    await apply('0007_chat_lifecycle')
    const { rows } = await pg.query(`select id, chat_id, kind, enabled from automations order by id`)
    expect(rows).toEqual([
      { id: 2, chat_id: '-100', kind: 'morning', enabled: true },
      { id: 4, chat_id: '-100', kind: null, enabled: true },
      { id: 5, chat_id: '-100', kind: null, enabled: true },
      { id: 6, chat_id: '-200', kind: 'morning', enabled: false },
    ])
    await pg.close()
  })
})

describe('the real driver', () => {
  it('is constructed lazily from DATABASE_URL and memoised', async () => {
    const { db, __setDb } = await import('@/lib/db')
    __setDb(null)
    process.env.DATABASE_URL = 'postgresql://user:pass@ep.example.neon.tech/hearth'
    const first = db()
    expect(first).toBeTruthy()
    expect(db()).toBe(first)
  })
})
