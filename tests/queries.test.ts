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

describe('members', () => {
  it('creates on first sight and refreshes the name after', async () => {
    const first = await q.upsertMember('111', 'Logan')
    const second = await q.upsertMember('111', 'Logan Han')
    expect(second.id).toBe(first.id)
    expect(second.name).toBe('Logan Han')
  })

  it('only ever raises privileges, never lowers them', async () => {
    await q.upsertMember('111', 'Logan', { allowed: true, isAdmin: true })
    const plain = await q.upsertMember('111', 'Logan')
    expect(plain.allowed).toBe(true)
    expect(plain.isAdmin).toBe(true)
  })

  it('starts a new member with no access at all', async () => {
    const m = await q.upsertMember('222', 'Guest')
    expect(m.allowed).toBe(false)
    expect(m.isAdmin).toBe(false)
  })

  it('revoking access also drops admin', async () => {
    await q.upsertMember('111', 'Logan', { allowed: true, isAdmin: true })
    const revoked = await q.setMemberAllowed('111', false)
    expect(revoked?.allowed).toBe(false)
    expect(revoked?.isAdmin).toBe(false)
  })

  it('lists only allowed members', async () => {
    await q.upsertMember('111', 'Logan', { allowed: true })
    await q.upsertMember('222', 'Guest')
    expect((await q.allowedMembers()).map((m) => m.name)).toEqual(['Logan'])
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

  it('updates the title without losing strangers', async () => {
    await q.noteStranger('-100', { id: '9', name: 'A' })
    await q.rememberChat('-100', 'group', 'Renamed')
    expect(await q.strangersIn('-100')).toHaveLength(1)
  })
})

describe('messages', () => {
  it('excludes the message being answered from its own history', async () => {
    const m = await q.upsertMember('111', 'Logan', { allowed: true })
    await q.recordMessage({ chatId: 'c', memberId: m.id, authorName: 'Logan', role: 'user', content: 'first' })
    const id = await q.recordMessage({ chatId: 'c', memberId: m.id, authorName: 'Logan', role: 'user', content: 'second' })
    const history = await q.recentMessages('c', 30, id)
    expect(history.map((h) => h.content)).toEqual(['first'])
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

  it('prunes down to the most recent N', async () => {
    for (let i = 0; i < 12; i++) {
      await q.recordMessage({ chatId: 'c', role: 'user', content: `m${i}` })
    }
    await q.pruneMessages('c', 5)
    const left = await q.recentMessages('c', 50)
    expect(left).toHaveLength(5)
    expect(left.map((m) => m.content)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11'])
  })

  it('prunes one chat without touching another', async () => {
    for (let i = 0; i < 4; i++) await q.recordMessage({ chatId: 'a', role: 'user', content: `${i}` })
    await q.recordMessage({ chatId: 'b', role: 'user', content: 'keep' })
    await q.pruneMessages('a', 1)
    expect(await q.recentMessages('b')).toHaveLength(1)
  })
})

describe('connections', () => {
  it('encrypts the refresh token at rest and decrypts it back', async () => {
    const m = await q.upsertMember('111', 'Logan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'r3fr3sh', scopes: 's' })
    const conn = await q.connectionFor(m.id, 'google')
    expect(conn!.refreshToken).not.toContain('r3fr3sh')
    expect(await q.decryptRefreshToken(conn!)).toBe('r3fr3sh')
  })

  it('replaces the token when the same provider is relinked', async () => {
    const m = await q.upsertMember('111', 'Logan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'old', scopes: null })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'new', scopes: null })
    expect(await q.connectionsFor(m.id)).toHaveLength(1)
    expect(await q.decryptRefreshToken((await q.connectionFor(m.id, 'google'))!)).toBe('new')
  })

  it('keeps the two providers separate', async () => {
    const m = await q.upsertMember('111', 'Logan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'g', scopes: null })
    await q.saveConnection({ memberId: m.id, provider: 'microsoft', email: null, refreshToken: 'm', scopes: null })
    expect(await q.connectionsFor(m.id)).toHaveLength(2)
    await q.deleteConnection(m.id, 'google')
    expect((await q.connectionsFor(m.id)).map((c) => c.provider)).toEqual(['microsoft'])
  })

  it('disappears with the member', async () => {
    const m = await q.upsertMember('111', 'Logan', { allowed: true })
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
})

describe('memories', () => {
  it('stores, lists newest first, and deletes', async () => {
    const a = await q.addMemory('bin night is Monday')
    await q.addMemory('milk allergy')
    const rows = await q.listMemories()
    expect(rows.map((r) => r.content)).toEqual(['milk allergy', 'bin night is Monday'])
    await q.deleteMemory(a.id)
    expect(await q.listMemories()).toHaveLength(1)
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
    const m = await q.upsertMember('111', 'Logan', { allowed: true })
    return q.createDraft({ chatId: 'c', memberId: m.id, provider: 'google', to: ['a@b.com'], subject: 's', body: 'b' })
  }

  it('joins recipients and starts pending', async () => {
    const d = await draft()
    expect(d.recipients).toBe('a@b.com')
    expect(d.status).toBe('pending')
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

  it('adding nothing is a no-op', async () => {
    const l = await q.findOrCreateList('shopping')
    expect(await q.addListItems(l.id, [])).toEqual([])
    expect(await q.removeListItems(l.id, [])).toEqual([])
  })
})

describe('event proposals', () => {
  const make = (source?: string) =>
    q.addProposal({
      chatId: 'c', title: 'Photo day',
      startsAt: new Date('2026-09-09T23:00:00Z'), endsAt: new Date('2026-09-10T00:00:00Z'),
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
