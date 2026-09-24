import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { Member } from '@/lib/db/schema'

const send = vi.fn(async () => {})
vi.mock('@/lib/telegram', () => ({ send }))
const unaccountedIn = vi.hoisted(() => vi.fn(async (_chatId: string): Promise<number | null> => 0))
vi.mock('@/lib/headcount', () => ({ unaccountedIn }))

const hydrateSecrets = vi.fn(async () => {})
vi.mock('@/lib/settings', async (orig) => {
  const actual = await orig<typeof import('@/lib/settings')>()
  return { ...actual, hydrateSecrets }
})

const { callTool, descriptors, mcpChat, CONTEXT_TOOL } = await import('@/lib/mcp')

let client: PGlite
let member: Member
let realDb: unknown

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
  member = await q.upsertMember('111', 'Rowan', { allowed: true })
})
afterEach(async () => closeDb(client))

const text = (result: { content: { text: string }[] }) => result.content[0].text

describe('the tools an MCP client is offered', () => {
  const names = () => descriptors().map((d) => d.name)

  it('offers the whole set at once, not the routed subset a chat turn sees', () => {
    expect(names()).toEqual(
      expect.arrayContaining(['web_search', 'add_family_event', 'send_email', 'jira_create_issue', 'create_automation']),
    )
  })

  it('leaves out the two that mean nothing down this pipe', () => {
    // more_tools widens a routed list, and there is no routing here; the import
    // tool reads a file attached to a Telegram message, and there is no message.
    expect(names()).not.toContain('more_tools')
    expect(names()).not.toContain('import_calendar_file')
  })

  it('stands in for the context a chat turn gets free', () => {
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

describe('the room a call acts in', () => {
  it('is the household group, so what it posts reaches everyone', async () => {
    await q.rememberChat('-100', 'supergroup', 'Home')
    expect(await mcpChat(member)).toBe('-100')
  })

  it('is not a room with someone unrecognised in it', async () => {
    await q.rememberChat('-100', 'supergroup', 'Home')
    await q.noteStranger('-100', { id: '999', name: 'Guest' })
    expect(await mcpChat(member)).toBe(member.telegramUserId)
  })

  it("falls back to the member's own chat when there is no group at all", async () => {
    expect(await mcpChat(member)).toBe('111')
  })

  it('treats a failed room lookup as no rooms, falling back to the caller\'s own chat', async () => {
    const { __setDb } = await import('@/lib/db')
    __setDb({ select: () => { throw new Error('chats table locked') } })
    try {
      expect(await mcpChat(member)).toBe(member.telegramUserId)
    } finally {
      __setDb(realDb)
    }
  })
})

describe('calling a tool', () => {
  beforeEach(async () => q.rememberChat('-100', 'supergroup', 'Home'))

  it('runs it in the name of whoever holds the key', async () => {
    await callTool('add_family_event', { title: 'Swimming', start: '2026-09-20T10:00', all_day: false }, member)
    const [event] = await q.listFamilyEvents(new Date('2026-09-01'), new Date('2026-10-01'))
    expect(event.title).toBe('Swimming')
    expect(event.createdBy).toBe(member.id)
  })

  it('says in the family chat what the tool asked the family to hear', async () => {
    const result = await callTool(
      'add_family_event',
      { title: 'Swimming', start: '2026-09-20T10:00', all_day: false },
      member,
    )
    expect(send).toHaveBeenCalledWith('-100', expect.stringContaining('Swimming'))
    expect(text(result)).toContain('Swimming')
  })

  it('says it in the member\'s own chat instead when the group holds people nobody has accounted for', async () => {
    for (const count of [3, null]) {
      send.mockClear()
      unaccountedIn.mockResolvedValueOnce(count)
      const result = await callTool('add_family_event', { title: `Swimming ${count}`, start: '2026-09-20T10:00', all_day: false }, member)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith(member.telegramUserId, expect.stringContaining('Swimming'))
      expect(text(result)).toContain('your own chat rather than the family group')
    }
  })

  it('withdraws the promise when the family could not be told', async () => {
    send.mockRejectedValueOnce(new Error('telegram is down'))
    const result = await callTool(
      'add_family_event',
      { title: 'Swimming', start: '2026-09-20T10:00', all_day: false },
      member,
    )
    expect(text(result)).toContain('nobody there has been told')
    expect(result.isError).toBeUndefined()
  })

  it('stays quiet in the chat when the tool only read something', async () => {
    await callTool('recall', {}, member)
    expect(send).not.toHaveBeenCalled()
  })

  it('answers a name it does not have rather than failing the call', async () => {
    const result = await callTool('rm_rf', {}, member)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('rm_rf')
  })

  it('will not reach a tool a chat turn cannot reach either', async () => {
    expect((await callTool('more_tools', { group: 'mail' }, member)).isError).toBe(true)
  })

  it('turns a failure on the way in into an answer, not a throw', async () => {
    hydrateSecrets.mockRejectedValueOnce(new Error('the store is unreachable'))
    const result = await callTool('recall', {}, member)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the store is unreachable')
  })

  it('loads the stored keys before the first tool touches them', async () => {
    await callTool('recall', {}, member)
    expect(hydrateSecrets).toHaveBeenCalled()
  })
})

describe('the context a client gets instead of a chat turn', () => {
  it('says who it is acting as, where it is acting, and when', async () => {
    await q.rememberChat('-100', 'supergroup', 'Home')
    const result = text(await callTool(CONTEXT_TOOL, {}, member))
    expect(result).toContain('acting as Rowan')
    expect(result).toContain('the family group')
    expect(result).toContain('Australia/Melbourne')
  })

  it('says when it is acting somewhere only the member can see', async () => {
    const admin = await q.upsertMember('222', 'Sam', { allowed: true, isAdmin: true })
    const result = text(await callTool(CONTEXT_TOOL, {}, admin))
    expect(result).toContain('an admin of this household')
    expect(result).toContain('your own chat with Hearth')
  })

  it('carries what the household knows, ids and all', async () => {
    const fact = await q.addMemory('Bin night is Monday', member.id, null)
    const result = text(await callTool(CONTEXT_TOOL, {}, member))
    expect(result).toContain('Bin night is Monday')
    expect(result).toContain(`[${fact.id}]`)
  })
})

describe('the key that says who is calling', () => {
  it('names exactly one member', async () => {
    const key = await q.issueMcpKey(member.id)
    expect((await q.memberByMcpKey(key))?.id).toBe(member.id)
  })

  it('is never stored as itself, so a lost one cannot be read back', async () => {
    const key = await q.issueMcpKey(member.id)
    const [row] = await q.allMembers()
    expect(row.mcpTokenHash).not.toBe(key)
    expect(row.mcpTokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('retires the one it replaces', async () => {
    const first = await q.issueMcpKey(member.id)
    const second = await q.issueMcpKey(member.id)
    expect(await q.memberByMcpKey(first)).toBeNull()
    expect((await q.memberByMcpKey(second))?.id).toBe(member.id)
  })

  it('leaves nothing to find once revoked', async () => {
    const key = await q.issueMcpKey(member.id)
    await q.revokeMcpKey(member.id)
    expect(await q.memberByMcpKey(key)).toBeNull()
  })

  it('stops working the moment the member is denied, like every other door', async () => {
    const key = await q.issueMcpKey(member.id)
    await q.setMemberAllowed('111', false)
    expect(await q.memberByMcpKey(key)).toBeNull()
  })

  it('answers nothing to an empty or unknown key', async () => {
    await q.issueMcpKey(member.id)
    expect(await q.memberByMcpKey('')).toBeNull()
    expect(await q.memberByMcpKey('not-a-key')).toBeNull()
  })
})
