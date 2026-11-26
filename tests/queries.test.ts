import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

let client: PGlite
let database: Awaited<ReturnType<typeof freshDb>>['db']

beforeEach(async () => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  ;({ client, db: database } = await freshDb())
})
afterEach(async () => closeDb(client))

/** A family member as an admin adds one from the dashboard: a name and the address they sign in with. */
const member = (name: string, extra: Partial<{ email: string | null; allowed: boolean; isAdmin: boolean }> = {}) =>
  q.saveMember({ name, email: extra.email ?? `${name.toLowerCase()}@example.com`, allowed: extra.allowed ?? true, isAdmin: extra.isAdmin ?? false })

/** Push rows back in time, as the days behind a real household would. */
const age = (table: string, days: number, where = 'true') =>
  client.query(`update ${table} set created_at = now() - make_interval(days => ${days}) where ${where}`)

describe('members', () => {
  it('adds someone by name and address, and changes them by id after', async () => {
    const added = await q.saveMember({ name: 'Rowan', email: 'rowan@example.com', allowed: true, isAdmin: false })
    expect(added).toMatchObject({ name: 'Rowan', email: 'rowan@example.com', allowed: true, isAdmin: false })
    const renamed = await q.saveMember({ id: added.id, name: 'Rowan Hale', email: 'rowan@example.com', allowed: true, isAdmin: true })
    expect(renamed.id).toBe(added.id)
    expect(renamed).toMatchObject({ name: 'Rowan Hale', isAdmin: true })
    expect(await q.allMembers()).toHaveLength(1)
  })

  it('changes the member already holding an address rather than adding a second, whatever its case', async () => {
    const first = await member('Rowan', { email: 'Rowan@Example.com' })
    const again = await q.saveMember({ name: 'Rowan H', email: '  rowan@example.COM ', allowed: true, isAdmin: false })
    expect(again.id).toBe(first.id)
    expect(again.name).toBe('Rowan H')
    expect(again.email).toBe('rowan@example.COM')
    expect(await q.allMembers()).toHaveLength(1)
  })

  it('keeps someone with no address as a member of their own, and a blank address as none', async () => {
    const a = await q.saveMember({ name: 'Ada', email: null, allowed: true, isAdmin: false })
    const b = await q.saveMember({ name: 'Juno', email: '   ', allowed: true, isAdmin: false })
    expect(b.id).not.toBe(a.id)
    expect(b.email).toBeNull()
  })

  it('takes admin away with access, so a revoked person cannot sign in as one', async () => {
    const m = await member('Rowan', { isAdmin: true })
    const revoked = await q.saveMember({ id: m.id, name: 'Rowan', email: m.email, allowed: false, isAdmin: true })
    expect(revoked).toMatchObject({ allowed: false, isAdmin: false })
  })

  it('lists only allowed members, and finds one by id', async () => {
    const rowan = await member('Rowan')
    await member('Guest', { allowed: false })
    expect((await q.allowedMembers()).map((m) => m.name)).toEqual(['Rowan'])
    expect((await q.memberById(rowan.id))!.name).toBe('Rowan')
    expect(await q.memberById(999)).toBeUndefined()
  })

  it('lists everyone with the accounts each has linked', async () => {
    const rowan = await member('Rowan')
    await member('Ada')
    await q.saveConnection({ memberId: rowan.id, provider: 'google', email: 'rowan@gmail.example', refreshToken: 'r', scopes: null })
    await q.setConnectionReadOnly(rowan.id, 'google', true)
    expect((await q.allMembersWithLinks()).map((m) => [m.name, m.linked])).toEqual([
      ['Rowan', [{ provider: 'google', email: 'rowan@gmail.example', readOnly: true }]],
      ['Ada', []],
    ])
  })

  it("pauses a removed member's own automations before the row that says whose they were goes", async () => {
    const nanny = await member('Nanny')
    const other = await member('Rowan')
    const at = new Date('2026-09-20T00:00:00Z')
    const own = await q.addAutomation({ memberId: nanny.id, label: 'mine', cronExpr: '0 9 * * *', instruction: 'x', nextRunAt: at })
    const theirs = await q.addAutomation({ memberId: other.id, label: 'theirs', cronExpr: '0 9 * * *', instruction: 'y', nextRunAt: at })
    const nobody = await q.addAutomation({ memberId: null, label: 'nobody', cronExpr: '0 9 * * *', instruction: 'z', nextRunAt: at })
    expect(await q.deleteMember(nanny.id)).toBe(true)
    const rows = await q.listAutomations()
    expect(rows.find((a) => a.id === own.id)).toMatchObject({ enabled: false, memberId: null })
    expect(rows.find((a) => a.id === theirs.id)!.enabled).toBe(true)
    expect(rows.find((a) => a.id === nobody.id)!.enabled).toBe(true)
    expect(await q.memberById(nanny.id)).toBeUndefined()
    expect(await q.deleteMember(nanny.id)).toBe(false)
  })
})

describe('MCP keys', () => {
  it('mints a key in the member\'s name, keeps only its digest, and hands the key back once', async () => {
    const rowan = await member('Rowan')
    const { key, row } = await q.issueMcpKey(rowan.id, '  Claude   Code on the laptop ')
    expect(key).toMatch(new RegExp(`^${rowan.id}\\.[\\w-]+\\.[\\w-]{43}$`))
    expect(row).toMatchObject({ memberId: rowan.id, label: 'Claude Code on the laptop', lastUsedAt: null })
    const { hashToken } = await import('@/lib/crypto')
    expect(row.tokenHash).toBe(await hashToken(key))
    const { rows } = await client.query<Record<string, unknown>>('select * from mcp_keys')
    expect(JSON.stringify(rows)).not.toContain(key)
  })

  it('names a key it was given no name for, and cuts a long one down to size', async () => {
    const rowan = await member('Rowan')
    expect((await q.issueMcpKey(rowan.id, '   ')).row.label).toBe('MCP client')
    expect((await q.issueMcpKey(rowan.id, 'x'.repeat(200))).row.label).toBe('x'.repeat(q.MCP_KEY_LABEL_MAX))
  })

  it('lets one member hold a key per client, each working on its own and listed newest first', async () => {
    const rowan = await member('Rowan')
    const ada = await member('Ada')
    const laptop = await q.issueMcpKey(rowan.id, 'laptop')
    const desktop = await q.issueMcpKey(rowan.id, 'desktop')
    await q.issueMcpKey(ada.id, 'phone')
    expect((await q.mcpKeysFor(rowan.id)).map((k) => k.label)).toEqual(['desktop', 'laptop'])
    expect((await q.mcpKeysFor(ada.id)).map((k) => k.label)).toEqual(['phone'])
    expect(await q.memberByMcpKey(laptop.key)).toEqual({ member: expect.objectContaining({ id: rowan.id }), keyId: laptop.row.id })
    expect(await q.memberByMcpKey(desktop.key)).toEqual({ member: expect.objectContaining({ id: rowan.id }), keyId: desktop.row.id })
  })

  it('turns away a key whose tag does not check before it reads anything at all', async () => {
    const rowan = await member('Rowan')
    const { key } = await q.issueMcpKey(rowan.id, 'laptop')
    const { __setDb } = await import('@/lib/db')
    const reads = vi.fn()
    __setDb(new Proxy({}, { get: () => { reads(); throw new Error('the database was read') } }))
    try {
      // Made up, mangled, shaped wrong, or tagged under another deployment's key.
      expect(await q.memberByMcpKey(`${rowan.id}.abc.${'A'.repeat(43)}`)).toBeNull()
      // The tag's first character carries six whole bits; its last carries only four.
      const [id, random, tag] = key.split('.')
      expect(await q.memberByMcpKey(`${id}.${random}.${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`)).toBeNull()
      expect(await q.memberByMcpKey('not a key')).toBeNull()
      expect(await q.memberByMcpKey(key.replace(/^\d+/, String(rowan.id + 1)))).toBeNull()
      process.env.TOKEN_ENC_KEY = 'b'.repeat(64)
      expect(await q.memberByMcpKey(key)).toBeNull()
    } finally {
      process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
      __setDb(database)
    }
    expect(reads).not.toHaveBeenCalled()
    expect(await q.memberByMcpKey(key)).not.toBeNull()
  })

  it('turns away a key that checks but is not on file, as one minted and never kept', async () => {
    const rowan = await member('Rowan')
    const { mintMcpKey } = await import('@/lib/crypto')
    expect(await q.memberByMcpKey(await mintMcpKey(rowan.id))).toBeNull()
  })

  it("turns away a key whose digest is on file under another member, even though its tag checks", async () => {
    const rowan = await member('Rowan')
    const ada = await member('Ada')
    const { mintMcpKey, hashToken } = await import('@/lib/crypto')
    const key = await mintMcpKey(rowan.id)
    await client.query(`insert into mcp_keys (member_id, label, token_hash) values ($1, 'planted', $2)`, [ada.id, await hashToken(key)])
    expect(await q.memberByMcpKey(key)).toBeNull()
  })

  it('keeps a revoked key dead, leaves the member\'s other keys working, and only its owner can revoke it', async () => {
    const rowan = await member('Rowan')
    const ada = await member('Ada')
    const laptop = await q.issueMcpKey(rowan.id, 'laptop')
    const desktop = await q.issueMcpKey(rowan.id, 'desktop')
    expect(await q.revokeMcpKey(ada.id, laptop.row.id)).toBe(false)
    expect(await q.memberByMcpKey(laptop.key)).not.toBeNull()
    expect(await q.revokeMcpKey(rowan.id, laptop.row.id)).toBe(true)
    expect(await q.memberByMcpKey(laptop.key)).toBeNull()
    expect(await q.revokeMcpKey(rowan.id, laptop.row.id)).toBe(false)
    expect((await q.memberByMcpKey(desktop.key))?.keyId).toBe(desktop.row.id)
    expect((await q.mcpKeysFor(rowan.id)).map((k) => k.label)).toEqual(['desktop'])
  })

  it('lets nothing in for a member who has been denied, and takes their keys with them when removed', async () => {
    const rowan = await member('Rowan')
    const { key } = await q.issueMcpKey(rowan.id, 'laptop')
    await q.saveMember({ id: rowan.id, name: 'Rowan', email: rowan.email, allowed: false, isAdmin: false })
    expect(await q.memberByMcpKey(key)).toBeNull()
    await q.saveMember({ id: rowan.id, name: 'Rowan', email: rowan.email, allowed: true, isAdmin: false })
    expect(await q.memberByMcpKey(key)).not.toBeNull()
    await q.deleteMember(rowan.id)
    expect(await q.memberByMcpKey(key)).toBeNull()
    expect((await client.query('select count(*)::int as n from mcp_keys')).rows).toEqual([{ n: 0 }])
  })

  it('writes down when a key was last used, at most once an hour', async () => {
    const rowan = await member('Rowan')
    const { key, row } = await q.issueMcpKey(rowan.id, 'laptop')
    const usedAt = async () => (await q.mcpKeysFor(rowan.id)).find((k) => k.id === row.id)!.lastUsedAt
    await q.memberByMcpKey(key)
    const first = await usedAt()
    expect(first).toBeInstanceOf(Date)
    expect(Math.abs(first!.getTime() - Date.now())).toBeLessThan(60_000)
    await q.memberByMcpKey(key)
    expect((await usedAt())!.getTime()).toBe(first!.getTime())
    await client.query(`update mcp_keys set last_used_at = now() - interval '61 minutes' where id = $1`, [row.id])
    const stale = await usedAt()
    await q.memberByMcpKey(key)
    expect((await usedAt())!.getTime()).toBeGreaterThan(stale!.getTime())
  })

  it('still lets the key in when its last use cannot be written down', async () => {
    const rowan = await member('Rowan')
    const { key, row } = await q.issueMcpKey(rowan.id, 'laptop')
    await client.query(`alter table mcp_keys add constraint never_used_for_test check (last_used_at is null)`)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await q.memberByMcpKey(key)).toEqual({ member: expect.objectContaining({ id: rowan.id }), keyId: row.id })
      expect(warn).toHaveBeenCalledWith('[mcp] could not note a key as used:', expect.anything())
    } finally {
      warn.mockRestore()
    }
  })
})

describe('connections', () => {
  it('encrypts the refresh token at rest and decrypts it back', async () => {
    const m = await member('Rowan')
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'r3fr3sh', scopes: 's' })
    const conn = await q.connectionFor(m.id, 'google')
    expect(conn!.refreshToken).not.toContain('r3fr3sh')
    expect(await q.decryptRefreshToken(conn!)).toBe('r3fr3sh')
  })

  it('replaces the token when the same provider is relinked', async () => {
    const m = await member('Rowan')
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'old', scopes: null })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'new', scopes: null })
    expect(await q.connectionsFor(m.id)).toHaveLength(1)
    expect(await q.decryptRefreshToken((await q.connectionFor(m.id, 'google'))!)).toBe('new')
  })

  it('stores a refreshed token the same way, and keeps a read-only choice through a relink', async () => {
    const m = await member('Rowan')
    await q.saveConnection({ memberId: m.id, provider: 'microsoft', email: 'r@outlook.example', refreshToken: 'first', scopes: null })
    expect((await q.setConnectionReadOnly(m.id, 'microsoft', true))!.readOnly).toBe(true)
    await q.updateRefreshToken(m.id, 'microsoft', 'second')
    expect(await q.decryptRefreshToken((await q.connectionFor(m.id, 'microsoft'))!)).toBe('second')
    await q.saveConnection({ memberId: m.id, provider: 'microsoft', email: 'r@outlook.example', refreshToken: 'third', scopes: null })
    expect((await q.connectionFor(m.id, 'microsoft'))!.readOnly).toBe(true)
    expect(await q.setConnectionReadOnly(m.id, 'google', true)).toBeUndefined()
  })

  it('keeps the two providers separate', async () => {
    const m = await member('Rowan')
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'g', scopes: null })
    await q.saveConnection({ memberId: m.id, provider: 'microsoft', email: null, refreshToken: 'm', scopes: null })
    expect(await q.connectionsFor(m.id)).toHaveLength(2)
    await q.deleteConnection(m.id, 'google')
    expect((await q.connectionsFor(m.id)).map((c) => c.provider)).toEqual(['microsoft'])
  })

  it('disappears with the member', async () => {
    const m = await member('Rowan')
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'g', scopes: null })
    await q.deleteMember(m.id)
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

  it('finds facts by a plain word, a % or an _ meaning only itself', async () => {
    await q.addMemory('Bin night is Monday')
    await q.addMemory('Ada is 50% of the carpool')
    await q.addMemory('Juno_s locker is 12')
    expect((await q.listMemories(100, 'BIN')).map((m) => m.content)).toEqual(['Bin night is Monday'])
    expect((await q.listMemories(100, '%')).map((m) => m.content)).toEqual(['Ada is 50% of the carpool'])
    expect((await q.listMemories(100, '_s')).map((m) => m.content)).toEqual(['Juno_s locker is 12'])
    expect(await q.listMemories(1)).toHaveLength(1)
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

  it('retires the Known fact a yes corrects by a number or a "not", and no other', async () => {
    const year = await q.addMemory('Ada is in year 3')
    const peanuts = await q.addMemory('Ada is allergic to peanuts')
    const sibling = await q.addMemory('Juno is in year 3')
    const first = await q.askQuestion({ question: 'Is Ada in year 4 now?', candidate: 'Ada is in year 4' })
    const second = await q.askQuestion({ question: 'Has Ada grown out of the peanut allergy?', candidate: 'Ada is no longer allergic to peanuts' })

    const yes = await q.answerQuestion(first.row.id, 'Ada is in year 4', null)
    expect(yes!.replaced).toBe(year.id)
    const also = await q.answerQuestion(second.row.id, 'Ada is no longer allergic to peanuts', null)
    expect(also!.replaced).toBe(peanuts.id)
    expect((await q.listMemories()).map((m) => m.content).sort()).toEqual(
      ['Ada is in year 4', 'Ada is no longer allergic to peanuts', 'Juno is in year 3'],
    )
    const { db, schema } = await import('@/lib/db')
    const rows = await db().select().from(schema.memories)
    expect(rows.find((r) => r.id === year.id)?.supersededBy).toBe(yes!.memory!.id)
    expect(rows.find((r) => r.id === sibling.id)?.invalidatedAt).toBeNull()
  })

  it('keeps a Known fact a yes corrects only in part, and retires one a longer number changes', async () => {
    const allergies = await q.addMemory('Ada is allergic to peanuts and eggs')
    const shoes = await q.addMemory('Ada wears size 10 shoes')
    const eggs = await q.askQuestion({ question: 'Has Ada grown out of the egg allergy?', candidate: 'Ada is not allergic to eggs' })
    const size = await q.askQuestion({ question: 'Is Ada in size 11 shoes now?', candidate: 'Ada wears size 11 shoes' })

    const partial = await q.answerQuestion(eggs.row.id, 'Ada is not allergic to eggs', null)
    expect(partial!.replaced).toBeUndefined()
    const bigger = await q.answerQuestion(size.row.id, 'Ada wears size 11 shoes', null)
    expect(bigger!.replaced).toBe(shoes.id)
    expect((await q.listMemories()).map((m) => m.content).sort()).toEqual(
      ['Ada is allergic to peanuts and eggs', 'Ada is not allergic to eggs', 'Ada wears size 11 shoes'],
    )
    const { db, schema } = await import('@/lib/db')
    const rows = await db().select().from(schema.memories)
    expect(rows.find((r) => r.id === allergies.id)?.invalidatedAt).toBeNull()
    expect(rows.find((r) => r.id === shoes.id)?.supersededBy).toBe(bigger!.memory!.id)
  })
})

describe('automations', () => {
  const soon = new Date('2026-09-01T00:00:00Z')

  const make = (memberId: number | null = null) =>
    q.addAutomation({ memberId, label: 'bins', cronExpr: '0 19 * * 1', instruction: 'remind', nextRunAt: soon })

  it('starts on a schedule that repeats, for nobody in particular until told whose and which helper\'s', async () => {
    const plain = await make()
    expect(plain).toMatchObject({ repeat: 'always', helperId: null, enabled: true, lastRunAt: null })
    const m = await member('Rowan')
    const chef = (await q.addHelper({ name: 'Chef', role: 'Plans meals.', createdBy: m.id }))!
    const once = await q.addAutomation({ memberId: m.id, label: 'Chef: dinners', cronExpr: '0 9 1 10 *', instruction: 'plan', nextRunAt: soon, repeat: 'once', helperId: chef.id })
    expect(once).toMatchObject({ memberId: m.id, repeat: 'once', helperId: chef.id })
  })

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

  it("lists one member's own, soonest first, or everyone's, and deletes", async () => {
    const rowan = await member('Rowan')
    const ada = await member('Ada')
    const late = await q.addAutomation({ memberId: rowan.id, label: 'late', cronExpr: '0 8 * * *', instruction: 'i', nextRunAt: new Date('2026-10-01T00:00:00Z') })
    const early = await q.addAutomation({ memberId: rowan.id, label: 'early', cronExpr: '0 8 * * *', instruction: 'i', nextRunAt: soon })
    await q.addAutomation({ memberId: ada.id, label: 'hers', cronExpr: '0 8 * * *', instruction: 'i', nextRunAt: soon })
    await make()
    expect((await q.listAutomations(rowan.id)).map((a) => a.id)).toEqual([early.id, late.id])
    expect((await q.listAutomations(ada.id)).map((a) => a.label)).toEqual(['hers'])
    expect(await q.listAutomations()).toHaveLength(4)
    expect(await q.deleteAutomation(late.id)).toBe(true)
    expect(await q.deleteAutomation(late.id)).toBe(false)
  })

  it('rewrites what one is called and does, keeping when it runs unless told', async () => {
    const a = await make()
    const kept = await q.syncAutomation(a.id, { label: 'Goal check-in: Bali', cronExpr: '0 19 * * 0', instruction: 'check in' })
    expect(kept).toMatchObject({ label: 'Goal check-in: Bali', cronExpr: '0 19 * * 0', instruction: 'check in' })
    expect(kept!.nextRunAt.getTime()).toBe(soon.getTime())
    const moved = new Date('2026-09-06T09:00:00Z')
    expect((await q.syncAutomation(a.id, { label: 'x', cronExpr: '0 19 * * 0', instruction: 'y', nextRunAt: moved }))!.nextRunAt.getTime()).toBe(moved.getTime())
    expect(await q.syncAutomation(999, { label: 'x', cronExpr: '0 19 * * 0', instruction: 'y' })).toBeUndefined()
  })
})

describe('automation reports', () => {
  const report = (memberId: number, overrides: Partial<Parameters<typeof q.addReport>[0]> = {}) =>
    q.addReport({ memberId, automationId: null, label: 'bins', status: 'ready', body: 'Bins out tonight.', ...overrides })

  it('keeps what a run found for its member, with whose job it was and anything the checks said', async () => {
    const rowan = await member('Rowan')
    const job = await q.addAutomation({ memberId: rowan.id, label: 'Chef: dinners', cronExpr: '0 9 * * *', instruction: 'plan', nextRunAt: new Date() })
    const row = await report(rowan.id, { automationId: job.id, label: 'Chef: dinners', helper: 'Chef', status: 'held', body: 'Draft', detail: 'Held back: a figure was not in the evidence.' })
    expect(row).toMatchObject({ memberId: rowan.id, automationId: job.id, helper: 'Chef', status: 'held', body: 'Draft', detail: 'Held back: a figure was not in the evidence.' })
    const bare = await report(rowan.id)
    expect(bare).toMatchObject({ helper: null, detail: null, automationId: null })
  })

  it('cuts a runaway report and its note down rather than failing', async () => {
    const rowan = await member('Rowan')
    const row = await report(rowan.id, { body: 'x'.repeat(20_000), detail: 'y'.repeat(5_000) })
    expect(row.body).toHaveLength(8000)
    expect(row.detail).toHaveLength(2000)
  })

  it("lists a member's own reports, newest first, since a moment and up to a limit", async () => {
    const rowan = await member('Rowan')
    const ada = await member('Ada')
    const old = await report(rowan.id, { label: 'old' })
    const a = await report(rowan.id, { label: 'a' })
    const b = await report(rowan.id, { label: 'b' })
    await report(ada.id, { label: 'hers' })
    await age('automation_reports', 10, `id = ${old.id}`)
    expect((await q.reportsFor(rowan.id)).map((r) => r.label)).toEqual(['b', 'a', 'old'])
    expect((await q.reportsFor(rowan.id, { since: new Date(Date.now() - 3 * 86_400_000) })).map((r) => r.id)).toEqual([b.id, a.id])
    expect((await q.reportsFor(rowan.id, { limit: 1 })).map((r) => r.id)).toEqual([b.id])
    expect((await q.reportsFor(ada.id)).map((r) => r.label)).toEqual(['hers'])
    expect(await q.reportsFor(999)).toEqual([])
  })

  it('stops at twenty unless asked for more', async () => {
    const rowan = await member('Rowan')
    for (let i = 0; i < 22; i++) await report(rowan.id, { label: `r${i}` })
    expect(await q.reportsFor(rowan.id)).toHaveLength(20)
    expect(await q.reportsFor(rowan.id, { limit: 50 })).toHaveLength(22)
  })

  it('prunes what is older than the days kept, and nothing newer', async () => {
    const rowan = await member('Rowan')
    const stale = await report(rowan.id, { label: 'stale' })
    await report(rowan.id, { label: 'fresh' })
    await age('automation_reports', 31, `id = ${stale.id}`)
    expect(await q.pruneReports()).toBe(1)
    expect((await q.reportsFor(rowan.id)).map((r) => r.label)).toEqual(['fresh'])
    expect(await q.pruneReports(30)).toBe(0)
    await age('automation_reports', 2, `label = 'fresh'`)
    expect(await q.pruneReports(1)).toBe(1)
  })

  it('outlives the automation that wrote it, and goes with its member', async () => {
    const rowan = await member('Rowan')
    const once = await q.addAutomation({ memberId: rowan.id, label: 'once', cronExpr: '0 9 * * *', instruction: 'i', nextRunAt: new Date(), repeat: 'once' })
    await report(rowan.id, { automationId: once.id, label: 'once' })
    await q.deleteAutomation(once.id)
    expect((await q.reportsFor(rowan.id)).map((r) => [r.label, r.automationId])).toEqual([['once', null]])
    await q.deleteMember(rowan.id)
    expect((await client.query('select count(*)::int as n from automation_reports')).rows).toEqual([{ n: 0 }])
  })
})

describe('goals', () => {
  it("lists one member's own goals in a state, in progress unless told, oldest first", async () => {
    const rowan = await member('Rowan')
    const ada = await member('Ada')
    const bali = await q.createGoal({ memberId: rowan.id, title: 'Bali' })
    const party = await q.createGoal({ memberId: rowan.id, title: 'Party', outcome: 'Forty friends fed', targetDate: '2026-12-01' })
    await q.createGoal({ memberId: ada.id, title: 'Hers' })
    await q.createGoal({ memberId: null, title: 'Nobody now' })
    expect((await q.goalsIn({ memberId: rowan.id })).map((g) => g.id)).toEqual([bali.id, party.id])
    expect(party).toMatchObject({ outcome: 'Forty friends fed', targetDate: '2026-12-01', status: 'active' })
    await q.closeGoal(bali.id, 'done')
    expect((await q.goalsIn({ memberId: rowan.id })).map((g) => g.title)).toEqual(['Party'])
    expect((await q.goalsIn({ memberId: rowan.id, status: 'done' })).map((g) => g.title)).toEqual(['Bali'])
    expect((await q.goalsIn({ memberId: ada.id })).map((g) => g.title)).toEqual(['Hers'])
  })
})

describe('goal plans and progress', () => {
  it('keeps steps in planned order, ticks them by what they say, and logs progress with who gave it', async () => {
    const rowan = await member('Rowan')
    const goal = await q.createGoal({ memberId: rowan.id, title: 'Party' })
    const steps = await q.addGoalSteps(goal.id, ['  Book the venue ', '', 'Send invitations'])
    expect(steps.map((st) => st.content)).toEqual(['Book the venue', 'Send invitations'])
    expect(await q.addGoalSteps(goal.id, ['   '])).toEqual([])
    expect((await q.markGoalSteps(goal.id, ['venue'], true)).map((st) => st.content)).toEqual(['Book the venue'])
    expect(await q.markGoalSteps(goal.id, ['balloons'], true)).toEqual([])
    expect((await q.goalStepsOf(goal.id)).map((st) => [st.content, st.done])).toEqual([['Book the venue', true], ['Send invitations', false]])
    expect((await q.setGoalStepDone(steps[1].id, true))!.done).toBe(true)
    expect((await q.getGoalStep(steps[1].id))!.done).toBe(true)
    expect(await q.getGoalStep(999)).toBeUndefined()

    await q.addGoalUpdate(goal.id, ' booked the hall ', rowan.id)
    const latest = await q.addGoalUpdate(goal.id, 'invitations out', null)
    expect((await q.goalUpdatesFor(goal.id)).map((u) => [u.note, u.who])).toEqual([['invitations out', null], ['booked the hall', 'Rowan']])
    expect(await q.goalUpdatesFor(goal.id, 1)).toHaveLength(1)
    expect((await q.getGoal(goal.id))!.updatedAt.getTime()).toBe(latest.createdAt.getTime())
  })

  it('renames, closes once, and reopens a goal', async () => {
    const rowan = await member('Rowan')
    const goal = await q.createGoal({ memberId: rowan.id, title: 'Bali' })
    expect((await q.updateGoal(goal.id, { title: 'Bali in March', targetDate: '2027-03-01' }))).toMatchObject({ title: 'Bali in March', targetDate: '2027-03-01' })
    expect(await q.updateGoal(999, { title: 'x' })).toBeUndefined()
    expect((await q.closeGoal(goal.id, 'dropped'))!.status).toBe('dropped')
    expect(await q.closeGoal(goal.id, 'done')).toBeUndefined()
    expect((await q.reopenGoal(goal.id))).toMatchObject({ status: 'active', closedAt: null })
    expect(await q.reopenGoal(goal.id)).toBeUndefined()
    expect(await q.getGoal(999)).toBeUndefined()
  })
})

describe('helpers and routines', () => {
  it('adds a helper once by name in any case, finds it again and lets it go', async () => {
    const rowan = await member('Rowan')
    const chef = (await q.addHelper({ name: ' Chef ', role: ' Plans meals. ', createdBy: rowan.id }))!
    expect(chef).toMatchObject({ name: 'Chef', role: 'Plans meals.', createdBy: rowan.id })
    expect(await q.addHelper({ name: 'chef', role: 'Another', createdBy: null })).toBeNull()
    const coach = (await q.addHelper({ name: 'Coach', role: 'Goals.', createdBy: null }))!
    expect((await q.listHelpers()).map((h) => h.name)).toEqual(['Chef', 'Coach'])
    expect((await q.getHelper(coach.id))!.name).toBe('Coach')
    expect((await q.helperNamed('  CHEF '))!.id).toBe(chef.id)
    expect(await q.helperNamed('Planner')).toBeUndefined()
    expect(await q.deleteHelper(chef.id)).toBe(true)
    expect(await q.deleteHelper(chef.id)).toBe(false)
    expect(await q.getHelper(chef.id)).toBeUndefined()
  })

  it('leaves a job handed to a helper since removed to Hearth itself', async () => {
    const rowan = await member('Rowan')
    const chef = (await q.addHelper({ name: 'Chef', role: 'Plans meals.', createdBy: rowan.id }))!
    const job = await q.addAutomation({ memberId: rowan.id, label: 'Chef: dinners', cronExpr: '0 9 * * *', instruction: 'plan', nextRunAt: new Date(), helperId: chef.id })
    await q.deleteHelper(chef.id)
    expect((await q.getAutomation(job.id))!.helperId).toBeNull()
  })

  it('keeps a routine under its name, replaces its steps when saved again, and forgets it', async () => {
    const first = await q.saveRoutine({ name: ' Sunday reset ', steps: 'tidy', createdBy: null })
    expect(first).toMatchObject({ replaced: false, row: { name: 'Sunday reset', steps: 'tidy' } })
    const again = await q.saveRoutine({ name: 'sunday RESET', steps: 'tidy\nshop', createdBy: null })
    expect(again.replaced).toBe(true)
    expect(again.row.id).toBe(first.row.id)
    await q.saveRoutine({ name: 'After school', steps: 'snack', createdBy: null })
    expect((await q.listRoutines()).map((r) => [r.name, r.steps])).toEqual([['After school', 'snack'], ['Sunday reset', 'tidy\nshop']])
    expect((await q.routineNamed('SUNDAY reset'))!.id).toBe(first.row.id)
    expect(await q.deleteRoutine(first.row.id)).toBe(true)
    expect(await q.deleteRoutine(first.row.id)).toBe(false)
    expect(await q.routineNamed('Sunday reset')).toBeUndefined()
  })

  it('keeps one routine when two members save the same new one at once, the later steps winning', async () => {
    const [a, b] = await Promise.all([
      q.saveRoutine({ name: 'Term start', steps: 'labels', createdBy: null }),
      q.saveRoutine({ name: 'term start', steps: 'labels\nshoes', createdBy: null }),
    ])
    expect(b.row.id).toBe(a.row.id)
    expect([a.replaced, b.replaced].sort()).toEqual([false, true])
    expect((await q.listRoutines()).map((r) => r.steps)).toEqual(['labels\nshoes'])
  })
})

describe('activity', () => {
  it("lists each member's own changes newest first with whose they were, or everyone's", async () => {
    const rowan = await member('Rowan')
    const ada = await member('Ada')
    await q.recordActivity({ memberId: rowan.id, via: 'mcp', tool: 'add_to_list', summary: 'added milk to the shopping list' })
    await q.recordActivity({ memberId: ada.id, via: 'web', tool: 'clear_list', summary: 'cleared the shopping list' })
    await q.recordActivity({ memberId: rowan.id, via: 'watcher', tool: 'propose_family_event', summary: 'proposed "Fete"' })
    await q.recordActivity({ memberId: null, via: 'watcher', tool: 'add_to_list', summary: 'nobody now' })
    expect((await q.recentActivity({ memberId: rowan.id })).map((a) => [a.summary, a.who, a.via])).toEqual([
      ['proposed "Fete"', 'Rowan', 'watcher'],
      ['added milk to the shopping list', 'Rowan', 'mcp'],
    ])
    const all = await q.recentActivity()
    expect(all.map((a) => a.who)).toEqual([null, 'Rowan', 'Ada', 'Rowan'])
    expect(await q.recentActivity({ limit: 1 })).toHaveLength(1)
  })

  it('prunes what is older than ninety days, and nothing newer', async () => {
    const rowan = await member('Rowan')
    await q.recordActivity({ memberId: rowan.id, via: 'mcp', tool: 't', summary: 'old' })
    await q.recordActivity({ memberId: rowan.id, via: 'mcp', tool: 't', summary: 'new' })
    await age('activity', 91, `summary = 'old'`)
    expect(await q.pruneActivity()).toBe(1)
    expect((await q.recentActivity()).map((a) => a.summary)).toEqual(['new'])
    expect(await q.pruneActivity(90)).toBe(0)
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

  it('ticks or unticks one item by id, and deletes one, from Home', async () => {
    const l = await q.findOrCreateList('shopping')
    const [milk, eggs] = await q.addListItems(l.id, ['milk', 'eggs'])
    expect((await q.setListItemDone(milk.id, true))!.done).toBe(true)
    expect((await q.setListItemDone(milk.id, false))!.done).toBe(false)
    expect(await q.setListItemDone(999, true)).toBeUndefined()
    expect(await q.deleteListItem(eggs.id)).toBe(true)
    expect(await q.deleteListItem(eggs.id)).toBe(false)
    expect((await q.listContents(l.id)).map((i) => i.content)).toEqual(['milk'])
  })
})

describe('event proposals', () => {
  // Far enough ahead that these stay in the future for the life of the test.
  const make = (source?: string | null, overrides: Partial<Parameters<typeof q.addProposal>[0]> = {}) =>
    q.addProposal({
      title: 'Photo day',
      startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T00:00:00Z'),
      source: source ?? null,
      ...overrides,
    })
  const early = new Date('2030-01-01T00:00:00Z')

  it('keeps who found it and what it said, and finds it again by id', async () => {
    const rowan = await member('Rowan')
    const p = await make('google:abc', { memberId: rowan.id, description: 'From the school office', location: 'Hall', allDay: false })
    expect(p).toMatchObject({ memberId: rowan.id, description: 'From the school office', location: 'Hall', status: 'pending', source: 'google:abc' })
    expect((await q.getProposal(p.id))!.title).toBe('Photo day')
    expect(await q.getProposal(999)).toBeUndefined()
  })

  it('hands back the proposal already made from a source rather than failing on a second', async () => {
    const first = await make('google:abc')
    const again = await make(' google:abc ', { title: 'Photo Day (reminder)' })
    expect(again.id).toBe(first.id)
    expect(again.title).toBe('Photo day')
    const [x, y] = await Promise.all([make('google:race'), make('google:race')])
    expect(y.id).toBe(x.id)
    expect((await client.query(`select count(*)::int as n from event_proposals where source = 'google:race'`)).rows).toEqual([{ n: 1 }])
  })

  it('allows many proposals with no source, a blank source counting as none', async () => {
    await make()
    await make()
    const blank = await make('   ')
    expect(blank.source).toBeNull()
    expect(await q.pendingProposals(early)).toHaveLength(3)
  })

  it('gathers the candidates for the same occasion: the same source, the same message, or the same span', async () => {
    const day = (iso: string) => new Date(iso)
    const bySource = await make('google:abc')
    const sameMessage = await make('google:abc/2030-10-05', { startsAt: day('2030-10-04T23:00:00Z'), endsAt: day('2030-10-05T00:00:00Z') })
    const inSpan = await make('microsoft:zzz', { startsAt: day('2030-09-09T21:00:00Z'), endsAt: day('2030-09-09T22:00:00Z') })
    await make('google:other', { startsAt: day('2030-11-01T00:00:00Z'), endsAt: day('2030-11-01T01:00:00Z') })
    const settled = await make(null, { title: 'Turned down', startsAt: day('2030-09-09T22:00:00Z'), endsAt: day('2030-09-09T23:00:00Z') })
    await q.settleProposal(settled.id, 'rejected')
    // The local day of 10 September 2030 in Melbourne.
    const from = day('2030-09-09T14:00:00Z')
    const to = day('2030-09-10T14:00:00Z')
    expect((await q.proposalsAround({ source: 'google:abc', from, to })).map((p) => p.id)).toEqual([bySource.id, sameMessage.id, inSpan.id, settled.id])
    expect((await q.proposalsAround({ source: ' google:abc/2030-09-10 ', from, to })).map((p) => p.id)).toEqual([bySource.id, sameMessage.id, inSpan.id, settled.id])
    expect((await q.proposalsAround({ source: null, from, to })).map((p) => p.id)).toEqual([bySource.id, inSpan.id, settled.id])
    expect((await q.proposalsAround({ source: '  ', from: day('2031-01-01T00:00:00Z'), to: day('2031-01-02T00:00:00Z') }))).toEqual([])
  })

  it('lists every live proposal, soonest first', async () => {
    const later = await make('s1')
    const sooner = await make(null, { title: 'Assembly', startsAt: new Date('2030-09-01T23:00:00Z'), endsAt: new Date('2030-09-02T00:00:00Z') })
    expect((await q.pendingProposals(early)).map((p) => p.id)).toEqual([sooner.id, later.id])
  })

  it('settles exactly once', async () => {
    const p = await make('s1')
    expect(await q.settleProposal(p.id, 'accepted')).toBeDefined()
    expect(await q.settleProposal(p.id, 'accepted')).toBeUndefined()
  })

  it('drops out of the pending list once settled', async () => {
    const p = await make('s1')
    await q.settleProposal(p.id, 'rejected')
    expect(await q.pendingProposals(early)).toHaveLength(0)
  })

  it('hides a proposal whose occasion has passed, before anything has retired it', async () => {
    const past = await q.addProposal({
      title: 'Pharmacist call',
      startsAt: new Date('2030-08-31T14:00:00Z'), endsAt: new Date('2030-09-01T14:00:00Z'), allDay: true,
    })
    const future = await make('later')
    expect((await q.pendingProposals(new Date('2030-08-01T00:00:00Z'))).map((p) => p.id)).toEqual([past.id, future.id])
    expect((await q.pendingProposals(new Date('2030-09-05T00:00:00Z'))).map((p) => p.id)).toEqual([future.id])
    // The row itself is still pending until the tick retires it.
    expect((await q.getProposal(past.id))!.status).toBe('pending')
  })

  it('hides a proposal once the same occasion is on the calendar by another route', async () => {
    const p = await make('s1')
    expect(await q.pendingProposals(early)).toHaveLength(1)
    const e = await q.addFamilyEvent({ title: ' photo DAY ', startsAt: p.startsAt, endsAt: p.endsAt })
    expect(await q.pendingProposals(early)).toHaveLength(0)
    // A cancelled event does not count as already there.
    await q.cancelFamilyEvent(e.id)
    expect(await q.pendingProposals(early)).toHaveLength(1)
    // A different occasion on the same day is not the same one.
    await q.addFamilyEvent({ title: 'Photo day', startsAt: new Date(p.startsAt.getTime() + 3_600_000), endsAt: p.endsAt })
    expect(await q.pendingProposals(early)).toHaveLength(1)
  })

  it('retires stale proposals with a status that says why, and leaves the live ones', async () => {
    const past = await q.addProposal({
      title: 'Pharmacist call',
      startsAt: new Date('2030-08-31T14:00:00Z'), endsAt: new Date('2030-09-01T14:00:00Z'), allDay: true,
    })
    const covered = await make('covered')
    await q.addFamilyEvent({ title: 'Photo day', startsAt: covered.startsAt, endsAt: covered.endsAt })
    const live = await q.addProposal({
      title: 'Concert',
      startsAt: new Date('2030-10-01T09:00:00Z'), endsAt: new Date('2030-10-01T10:00:00Z'),
    })
    const answered = await q.addProposal({
      title: 'Old but answered',
      startsAt: new Date('2030-08-01T00:00:00Z'), endsAt: new Date('2030-08-01T01:00:00Z'),
    })
    await q.settleProposal(answered.id, 'accepted')

    expect(await q.retireStaleProposals(new Date('2030-09-05T00:00:00Z'))).toEqual({ expired: 1, superseded: 1 })
    expect((await q.pendingProposals(new Date('2030-09-05T00:00:00Z'))).map((p) => p.id)).toEqual([live.id])
    expect((await q.getProposal(covered.id))!.status).toBe('superseded')
    expect((await q.getProposal(answered.id))!.status).toBe('accepted')
    // Retired is settled: a late yes finds nothing to accept.
    expect(await q.settleProposal(past.id, 'accepted')).toBeUndefined()
    // Nothing left to do on a second pass.
    expect(await q.retireStaleProposals(new Date('2030-09-05T00:00:00Z'))).toEqual({ expired: 0, superseded: 0 })
  })

  it('keeps a proposal when its finder leaves, as nobody\'s', async () => {
    const rowan = await member('Rowan')
    const p = await make('s1', { memberId: rowan.id })
    await q.deleteMember(rowan.id)
    expect((await q.getProposal(p.id))!.memberId).toBeNull()
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
