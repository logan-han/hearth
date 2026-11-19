import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { Member } from '@/lib/db/schema'
import { hashToken, mcpKeyHolder, mintMcpKey, randomToken } from '@/lib/crypto'

/** Linked mailboxes, none unless a test adds one; whose they were asked for is kept. */
const mailboxes = vi.hoisted(() => ({ list: [] as { provider: string; listMail: () => Promise<unknown[]> }[], askedFor: [] as number[] }))
vi.mock('@/lib/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/providers')>()),
  clientsFor: async (memberId: number) => {
    mailboxes.askedFor.push(memberId)
    return mailboxes.list
  },
}))

const hydrateSecrets = vi.fn(async () => {})
vi.mock('@/lib/settings', async (orig) => {
  const actual = await orig<typeof import('@/lib/settings')>()
  return { ...actual, hydrateSecrets }
})

const { callTool, descriptors, context, connectLine, CONTEXT_TOOL, INSTRUCTIONS, SERVER_INFO } = await import('@/lib/mcp')

let client: PGlite
let member: Member
let realDb: unknown

const add = (name: string, extra: Partial<{ email: string; isAdmin: boolean; allowed: boolean }> = {}) =>
  q.saveMember({ name, email: extra.email ?? `${name.toLowerCase()}@hearth.example`, allowed: extra.allowed ?? true, isAdmin: extra.isAdmin ?? false })

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  process.env.TIMEZONE = 'Australia/Melbourne'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  const fresh = await freshDb()
  client = fresh.client
  realDb = fresh.db
  member = await add('Rowan')
  mailboxes.list = []
  mailboxes.askedFor = []
})
afterEach(async () => closeDb(client))

const text = (result: { content: { text: string }[] }) => result.content[0].text
const as = (m: Member, keyId = 1) => ({ member: m, keyId })

describe('what a client is told before it calls anything', () => {
  it('names the server and says to read the context first', () => {
    expect(SERVER_INFO.name).toBe('hearth')
    expect(INSTRUCTIONS).toContain(`Call ${CONTEXT_TOOL} first`)
  })

  it('says nothing is posted anywhere, so the client passes on what it is told', () => {
    expect(INSTRUCTIONS).toContain('Nothing is posted anywhere')
    expect(INSTRUCTIONS).not.toMatch(/chat/i)
  })

  it('gives the one line that adds a key to Claude Code', () => {
    expect(connectLine('5.abc.def')).toBe(
      'claude mcp add --transport http hearth https://hearth.example/api/mcp --header "Authorization: Bearer 5.abc.def"',
    )
  })
})

describe('the tools an MCP client is offered', () => {
  const names = () => descriptors().map((d) => d.name)

  it('offers the whole set at once', () => {
    expect(names()).toEqual(
      expect.arrayContaining([
        'web_search', 'add_family_event', 'send_email', 'jira_create_issue', 'create_automation',
        'morning_brief', 'money_snapshot', 'list_reports', 'accept_event_proposal',
      ]),
    )
  })

  it('has no tool that only meant something in a chat', () => {
    expect(names()).not.toContain('more_tools')
    expect(names()).not.toContain('import_calendar_file')
  })

  it('puts the context first', () => {
    expect(names()[0]).toBe(CONTEXT_TOOL)
  })

  it('describes every one of them, so a client can choose', () => {
    for (const d of descriptors()) {
      expect(d.description.length, d.name).toBeGreaterThan(20)
      expect(d.inputSchema, d.name).toBeDefined()
    }
  })

  it('names each tool once', () => {
    expect(new Set(names()).size).toBe(names().length)
  })
})

describe('calling a tool', () => {
  it('runs it in the name of whoever holds the key', async () => {
    await callTool('add_family_event', { title: 'Swimming', start: '2026-09-20T10:00', all_day: false }, as(member))
    const [event] = await q.listFamilyEvents(new Date('2026-09-01'), new Date('2026-10-01'))
    expect(event.title).toBe('Swimming')
    expect(event.createdBy).toBe(member.id)
  })

  it('posts nothing: what the tool did comes back to the client alone', async () => {
    const result = JSON.parse(text(await callTool('add_family_event', { title: 'Swimming', start: '2026-09-20T10:00', all_day: false }, as(member))))
    expect(result.title).toBe('Swimming')
    expect(result).not.toHaveProperty('posted')
    expect(result.added).toContain('Swimming')
  })

  it("keeps what it changed on the member's own record, as done through an MCP client", async () => {
    const other = await add('Sam')
    await callTool('add_to_list', { items: ['milk'], list: 'shopping' }, as(member))
    const [mine] = await q.recentActivity({ memberId: member.id })
    expect(mine.via).toBe('mcp')
    expect(mine.summary).toContain('milk')
    expect(await q.recentActivity({ memberId: other.id })).toEqual([])
  })

  it('spends what it reported as new once the call returns, on markers of its key alone', async () => {
    const date = new Date(Date.now() - 3600_000).toISOString()
    mailboxes.list = [{ provider: 'google', listMail: async () => [{ id: 'm1', from: 'school', to: 'me', subject: 'S', snippet: '…', date, unread: true }] }]
    const first = JSON.parse(text(await callTool('new_mail', { limit: 10 }, as(member, 7))))
    expect(first.accounts[0].messages).toHaveLength(1)
    const again = JSON.parse(text(await callTool('new_mail', { limit: 10 }, as(member, 7))))
    expect(again.accounts[0].messages).toEqual([])
    expect(await q.getSetting(`mail_cursor:key:7:${member.id}:google`)).not.toBeNull()
    // Another of the member's clients, and their morning brief, still have it to see.
    const other = JSON.parse(text(await callTool('new_mail', { limit: 10 }, as(member, 8))))
    expect(other.accounts[0].messages).toHaveLength(1)
    expect(await q.getSetting(`mail_cursor:brief:${member.id}:google`)).toBeNull()
  })

  it("reads only the key holder's own mailbox", async () => {
    await add('Ada')
    mailboxes.list = [{ provider: 'google', listMail: async () => [] }]
    await callTool('new_mail', { limit: 10 }, as(member))
    expect(mailboxes.askedFor).toEqual([member.id])
  })

  it('answers a name it does not have rather than failing the call', async () => {
    const result = await callTool('rm_rf', {}, as(member))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('rm_rf')
  })

  it('has no more_tools to reach for', async () => {
    expect((await callTool('more_tools', { group: 'mail' }, as(member))).isError).toBe(true)
  })

  it('turns a failure on the way in into an answer, not a throw', async () => {
    hydrateSecrets.mockRejectedValueOnce(new Error('the store is unreachable'))
    const result = await callTool('recall', {}, as(member))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the store is unreachable')
  })

  it('loads the stored keys before the first tool touches them', async () => {
    await callTool('recall', {}, as(member))
    expect(hydrateSecrets).toHaveBeenCalled()
  })

  it('hands back a tool result that is already words as it is', async () => {
    // hearth_context answers in plain text, not JSON.
    expect(text(await callTool(CONTEXT_TOOL, {}, as(member)))).toMatch(/^You are acting as Rowan\./)
  })
})

describe('the context a client reads first', () => {
  const now = new Date('2026-09-15T00:00:00Z')
  const read = (m: Member = member) => context(m, now)

  it('says who it is acting as and when, in the household clock', async () => {
    const result = await read()
    expect(result).toContain('You are acting as Rowan.')
    expect(result).toContain('Australia/Melbourne')
    expect(result).not.toMatch(/lands in|chat/i)
  })

  it('says when the caller is an admin', async () => {
    const admin = await add('Sam', { isAdmin: true })
    expect(await read(admin)).toContain('an admin of this household')
  })

  it("names everyone's linked accounts, and that nobody else's mail is opened", async () => {
    const ada = await add('Ada')
    await q.saveConnection({ memberId: ada.id, provider: 'google', email: 'ada@gmail.example', refreshToken: 'r', scopes: null })
    await q.setConnectionReadOnly(ada.id, 'google', true)
    const result = await read()
    expect(result).toContain('Ada (google: ada@gmail.example, read only)')
    expect(result).toContain('Rowan (nothing linked)')
    expect(result).toContain("nobody else's is ever opened")
  })

  it('says an account is linked even when the provider gave no address for it', async () => {
    await q.saveConnection({ memberId: member.id, provider: 'microsoft', email: null, refreshToken: 'r', scopes: null })
    expect(await read()).toContain('Rowan (microsoft: linked)')
  })

  it('tells a caller with nothing linked where to link it', async () => {
    expect(await read()).toContain('they can link one at https://hearth.example/connect')
    await q.saveConnection({ memberId: member.id, provider: 'google', email: 'rowan@gmail.example', refreshToken: 'r', scopes: null })
    expect(await read()).not.toContain('can link one at')
  })

  it("carries the caller's own drafts and never another member's", async () => {
    const sam = await add('Sam')
    const mine = await q.createDraft({ memberId: member.id, provider: 'google', to: ['school@example.com'], subject: 'Absence', body: 'b' })
    await q.createDraft({ memberId: sam.id, provider: 'google', to: ['bank@example.com'], subject: 'Loan', body: 'b' })
    const result = await read()
    expect(result).toContain(`draft_id ${mine.id}: to school@example.com, "Absence"`)
    expect(result).not.toContain('Loan')
  })

  it('carries every proposal still waiting, whoever it was found for', async () => {
    const sam = await add('Sam')
    const p = await q.addProposal({ memberId: sam.id, title: 'Athletics carnival', startsAt: new Date('2026-10-14T23:00:00Z'), endsAt: new Date('2026-10-15T02:00:00Z') })
    expect(await read()).toContain(`proposal_id ${p.id}: "Athletics carnival"`)
  })

  it('carries the open questions with their ids', async () => {
    const { row } = await q.askQuestion({ question: 'Who attends Riverbend?', candidate: 'Juno attends Riverbend' })
    const result = await read()
    expect(result).toContain(`question_id ${row.id}: Who attends Riverbend?`)
    expect(result).toContain('would keep: "Juno attends Riverbend"')
  })

  it("carries the caller's own goals and never another member's", async () => {
    const sam = await add('Sam')
    const goal = await q.createGoal({ memberId: member.id, title: 'Bali trip', targetDate: '2026-12-01' })
    await q.addGoalSteps(goal.id, ['Book flights', 'Pack'])
    await q.createGoal({ memberId: sam.id, title: 'Sell the car' })
    const result = await read()
    expect(result).toContain(`goal_id ${goal.id}: "Bali trip", 0 of 2 steps done`)
    expect(result).toContain('next: Book flights')
    expect(result).toContain('target ')
    expect(result).not.toContain('Sell the car')
  })

  it('names a goal with no target date or step left by what it has', async () => {
    const done = await q.createGoal({ memberId: member.id, title: 'Tidy the shed' })
    const [only] = await q.addGoalSteps(done.id, ['Sort the tools'])
    await q.setGoalStepDone(only.id, true)
    const line = (await read()).split('\n').find((l) => l.includes('Tidy the shed'))!
    expect(line).toBe(`- goal_id ${done.id}: "Tidy the shed", 1 of 1 steps done`)
  })

  it('names the helpers and the routines kept', async () => {
    await q.addHelper({ name: 'Chef', role: 'Plans meals. Keeps to allergies.', createdBy: member.id })
    await q.saveRoutine({ name: 'Sunday reset', steps: 'Clear the fridge', createdBy: member.id })
    const result = await read()
    expect(result).toContain('- Chef: Plans meals.')
    expect(result).not.toContain('Keeps to allergies')
    expect(result).toContain('Routines kept')
    expect(result).toContain('Sunday reset')
  })

  it("carries the caller's latest reports, from the last few days only, and never another member's", async () => {
    const sam = await add('Sam')
    await q.addReport({ memberId: member.id, automationId: null, label: 'Camp dates', status: 'ready', body: 'The camp is 3 to 5 March.', helper: 'Researcher' })
    await q.addReport({ memberId: member.id, automationId: null, label: 'Bills', status: 'held', body: 'Draft', detail: 'Held back: invented a figure.' })
    await q.addReport({ memberId: sam.id, automationId: null, label: 'Secret', status: 'ready', body: 'Not yours' })
    const old = await q.addReport({ memberId: member.id, automationId: null, label: 'Ancient', status: 'ready', body: 'Long ago' })
    await client.query(`update automation_reports set created_at = now() - interval '10 days' where id = $1`, [old.id])
    const result = await context(member)
    expect(result).toContain('Reports from your scheduled jobs')
    expect(result).toContain('Camp dates (Researcher), found this: The camp is 3 to 5 March.')
    expect(result).toContain('Bills, held back by the checks: Draft [Held back: invented a figure.]')
    expect(result).not.toContain('Not yours')
    expect(result).not.toContain('Long ago')
  })

  it('carries what the household knows, ids and all', async () => {
    const fact = await q.addMemory('Bin night is Monday', member.id, null)
    const result = await read()
    expect(result).toContain('Bin night is Monday')
    expect(result).toContain(`[${fact.id}]`)
  })

  it('still says who and when when the store cannot be read', async () => {
    const { __setDb } = await import('@/lib/db')
    __setDb({ select: () => { throw new Error('locked') }, execute: () => { throw new Error('locked') } })
    try {
      const result = await read()
      expect(result).toContain('You are acting as Rowan.')
      expect(result).toContain('can link one at')
    } finally {
      __setDb(realDb)
    }
  })

  it('is what hearth_context answers', async () => {
    await q.addMemory('Bin night is Monday', member.id, null)
    expect(text(await callTool(CONTEXT_TOOL, {}, as(member)))).toContain('Bin night is Monday')
  })
})

describe('the keys that say who is calling', () => {
  it('names exactly one member, and which of their keys it is', async () => {
    const { key, row } = await q.issueMcpKey(member.id, 'Claude Code')
    const found = await q.memberByMcpKey(key)
    expect(found?.member.id).toBe(member.id)
    expect(found?.keyId).toBe(row.id)
    expect(row.label).toBe('Claude Code')
  })

  it('is never stored as itself, so a lost one cannot be read back', async () => {
    const { key } = await q.issueMcpKey(member.id, 'Laptop')
    const [row] = await q.mcpKeysFor(member.id)
    expect(row.tokenHash).not.toBe(key)
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(key.split('.')[1])
  })

  it('keeps one per client, each working beside the others', async () => {
    const laptop = await q.issueMcpKey(member.id, 'Laptop')
    const phone = await q.issueMcpKey(member.id, 'Phone')
    expect((await q.memberByMcpKey(laptop.key))?.keyId).toBe(laptop.row.id)
    expect((await q.memberByMcpKey(phone.key))?.keyId).toBe(phone.row.id)
    expect((await q.mcpKeysFor(member.id)).map((k) => k.label)).toEqual(['Phone', 'Laptop'])
  })

  it('tidies a label and gives a blank one a name', async () => {
    expect((await q.issueMcpKey(member.id, '  Claude   Desktop  ')).row.label).toBe('Claude Desktop')
    expect((await q.issueMcpKey(member.id, '   ')).row.label).toBe('MCP client')
    expect((await q.issueMcpKey(member.id, 'x'.repeat(200))).row.label).toHaveLength(q.MCP_KEY_LABEL_MAX)
  })

  it('leaves nothing to find once revoked, and the others go on working', async () => {
    const laptop = await q.issueMcpKey(member.id, 'Laptop')
    const phone = await q.issueMcpKey(member.id, 'Phone')
    expect(await q.revokeMcpKey(member.id, laptop.row.id)).toBe(true)
    // Its tag still checks: the missing row is what turns it away.
    expect(await mcpKeyHolder(laptop.key)).toBe(member.id)
    expect(await q.memberByMcpKey(laptop.key)).toBeNull()
    expect((await q.memberByMcpKey(phone.key))?.member.id).toBe(member.id)
    expect(await q.revokeMcpKey(member.id, laptop.row.id)).toBe(false)
  })

  it("cannot be revoked by anyone but its member", async () => {
    const sam = await add('Sam')
    const { key, row } = await q.issueMcpKey(member.id, 'Laptop')
    expect(await q.revokeMcpKey(sam.id, row.id)).toBe(false)
    expect(await q.memberByMcpKey(key)).not.toBeNull()
  })

  it('stops working the moment the member is denied, like every other door', async () => {
    const { key } = await q.issueMcpKey(member.id, 'Laptop')
    await q.saveMember({ id: member.id, name: member.name, email: member.email, allowed: false, isAdmin: false })
    expect(await q.memberByMcpKey(key)).toBeNull()
  })

  it('goes with its member', async () => {
    const { key } = await q.issueMcpKey(member.id, 'Laptop')
    await q.deleteMember(member.id)
    expect(await q.memberByMcpKey(key)).toBeNull()
    expect(await q.mcpKeysFor(member.id)).toEqual([])
  })

  it('answers nothing to an empty or unknown key', async () => {
    await q.issueMcpKey(member.id, 'Laptop')
    expect(await q.memberByMcpKey('')).toBeNull()
    expect(await q.memberByMcpKey('not-a-key')).toBeNull()
  })

  it('reads nothing for a key it did not mint', async () => {
    const { key } = await q.issueMcpKey(member.id, 'Laptop')
    const [id, random] = key.split('.')
    const reads = vi.spyOn(client, 'query')
    try {
      for (const made of ['not-a-key', randomToken(32), `${id}.${random}.${'A'.repeat(43)}`]) {
        expect(await q.memberByMcpKey(made)).toBeNull()
      }
      expect(reads).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
    }
  })

  it('names only the member a key was minted for, whoever holds its hash', async () => {
    const sam = await add('Sam')
    const theirs = await mintMcpKey(sam.id)
    await client.query(`insert into mcp_keys (member_id, label, token_hash) values ($1, 'stolen', $2)`, [member.id, await hashToken(theirs)])
    expect(await q.memberByMcpKey(theirs)).toBeNull()
  })

  it('notes when it was last used, once an hour at most', async () => {
    const { key, row } = await q.issueMcpKey(member.id, 'Laptop')
    expect(row.lastUsedAt).toBeNull()
    await q.memberByMcpKey(key)
    const [first] = await q.mcpKeysFor(member.id)
    expect(first.lastUsedAt).toBeInstanceOf(Date)
    await q.memberByMcpKey(key)
    const [second] = await q.mcpKeysFor(member.id)
    expect(second.lastUsedAt?.getTime()).toBe(first.lastUsedAt?.getTime())
    await client.query(`update mcp_keys set last_used_at = now() - interval '2 hours'`)
    await q.memberByMcpKey(key)
    const [third] = await q.mcpKeysFor(member.id)
    expect(third.lastUsedAt!.getTime()).toBeGreaterThan(first.lastUsedAt!.getTime() - 2 * 3600_000 + 60_000)
  })

  it('lets a key in even when its last use cannot be written down', async () => {
    const { key } = await q.issueMcpKey(member.id, 'Laptop')
    const real = client.query.bind(client)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spy = vi.spyOn(client, 'query').mockImplementation(((sql: string, ...rest: unknown[]) =>
      /^update "mcp_keys"/i.test(sql) ? Promise.reject(new Error('read only')) : (real as (...a: unknown[]) => unknown)(sql, ...rest)) as never)
    try {
      expect((await q.memberByMcpKey(key))?.member.id).toBe(member.id)
      expect(warn).toHaveBeenCalledWith('[mcp] could not note a key as used:', expect.any(Error))
    } finally {
      spy.mockRestore()
      warn.mockRestore()
    }
  })
})
