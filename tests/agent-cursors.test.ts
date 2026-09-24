import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

const generateText = vi.hoisted(() => vi.fn())
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText }))

/** One linked Gmail whose inbox is whatever the test says. */
const listMail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/providers')>()),
  clientsFor: async () => [{ provider: 'google', listMail }],
}))

const { runAgent } = await import('@/lib/agent')
const { commitCursors } = await import('@/lib/tools/cursor')

let client: PGlite
type Tools = Record<string, { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }>

const reply = (text: string) => ({ text, steps: [], usage: {} })
const mail = (id: string) => ({ id, from: 'school@x.edu', to: 'me@x.com', subject: 'S', snippet: '…', date: new Date(Date.now() - 3600_000).toISOString(), unread: true })

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.GEMINI_API_KEY = 'k'
  process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite'
  process.env.OPENROUTER_API_KEY = 'sk-or'
  process.env.OPENROUTER_MODEL = 'minimax/minimax-m3:free'
  delete process.env.LLM_BASE_URL
  delete process.env.TYPESAFE_API_KEY
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('a turn that looks at new mail', () => {
  it('hands its cursor moves back for the caller to make once the reply is out', async () => {
    const member = await q.upsertMember('111', 'Rowan', { allowed: true })
    listMail.mockResolvedValue([mail('a')])
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      const r = await opts.tools.new_mail.execute({ limit: 10, everyone: false }, {})
      expect((r.accounts as { messages: unknown[] }[])[0].messages).toHaveLength(1)
      return reply('One email from the school.')
    })
    const r = await runAgent({ chatId: '111', chatType: 'private', member, memberName: 'Rowan', text: 'any new mail?' })
    const key = `mail_cursor:111:${member.id}:google`
    expect(r.cursors?.map((c) => c.key)).toEqual([key])
    // Nothing is spent until the caller says the reply went out.
    expect(await q.getSetting(key)).toBeNull()
    await commitCursors(r.cursors)
    expect(JSON.parse((await q.getSetting(key))!).ids).toEqual(['a'])
  })

  it('shows the next model the same new mail when the first failed after looking', async () => {
    const member = await q.upsertMember('111', 'Rowan', { allowed: true })
    listMail.mockResolvedValue([mail('a')])
    let secondSaw = -1
    generateText
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        await opts.tools.new_mail.execute({ limit: 10, everyone: false }, {})
        throw new Error('429 quota')
      })
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        const r = await opts.tools.new_mail.execute({ limit: 10, everyone: false }, {})
        secondSaw = (r.accounts as { messages: unknown[] }[])[0].messages.length
        return reply('One email from the school.')
      })
    const r = await runAgent({ chatId: '111', chatType: 'private', member, memberName: 'Rowan', text: 'any new mail?' })
    expect(r.model).toContain('openrouter')
    expect(secondSaw).toBe(1)
    // One move, from the model whose reply went out.
    expect(r.cursors).toHaveLength(1)
  })

  it('claims nothing when the reply is only notices, which say nothing of the mail', async () => {
    const member = await q.upsertMember('111', 'Rowan', { allowed: true })
    listMail.mockResolvedValue([mail('a')])
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.new_mail.execute({ limit: 10, everyone: false }, {})
      await opts.tools.add_family_event.execute({ title: 'Swimming', start: '2026-10-03T09:00', all_day: false }, {})
      return reply('')
    })
    const r = await runAgent({ chatId: '111', chatType: 'private', member, memberName: 'Rowan', text: 'add swimming, and any new mail?' })
    expect(r.text).toContain('Added to the family calendar')
    expect(r.cursors).toBeUndefined()
  })

  it('drops the first reply\'s claim on the mail when the claim retry replaces that reply', async () => {
    const member = await q.upsertMember('111', 'Rowan', { allowed: true })
    listMail.mockResolvedValue([mail('a')])
    generateText
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        await opts.tools.new_mail.execute({ limit: 10, everyone: false }, {})
        return reply('One email from the school, and I have replied to it.')
      })
      .mockResolvedValueOnce({ text: '', output: 'claims_change', steps: [], usage: {} })
      .mockResolvedValueOnce(reply('I have not replied to anything; I can draft a reply if you like.'))
      .mockResolvedValueOnce({ text: '', output: 'no_change_claimed', steps: [], usage: {} })
    const r = await runAgent({ chatId: '111', chatType: 'private', member, memberName: 'Rowan', text: 'any new mail? reply to the school' })
    expect(r.text).toBe('I have not replied to anything; I can draft a reply if you like.')
    expect(r.cursors).toBeUndefined()
  })

  it('lets the claim retry see the mail as new, and keeps the first look when the first reply stands', async () => {
    const member = await q.upsertMember('111', 'Rowan', { allowed: true })
    listMail.mockResolvedValue([mail('a')])
    let retrySaw = -1
    generateText
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        await opts.tools.new_mail.execute({ limit: 10, everyone: false }, {})
        return reply('One email from the school, and I have replied to it.')
      })
      .mockResolvedValueOnce({ text: '', output: 'claims_change', steps: [], usage: {} })
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        const r = await opts.tools.new_mail.execute({ limit: 10, everyone: false }, {})
        retrySaw = (r.accounts as { messages: unknown[] }[])[0].messages.length
        throw new Error('429 quota')
      })
    const r = await runAgent({ chatId: '111', chatType: 'private', member, memberName: 'Rowan', text: 'any new mail? reply to the school' })
    // The retry could see the email; it failed, so the first reply stands with its claim on the mail.
    expect(retrySaw).toBe(1)
    expect(r.text).toContain('One email from the school')
    expect(r.cursors?.map((c) => c.ids)).toEqual([['a']])
  })

  it('spends an unattended run\'s looks along with an unrepeatable write it made on them, even as it fails', async () => {
    listMail.mockResolvedValue([mail('a')])
    const member = await q.upsertMember('111', 'Rowan', { allowed: true })
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.new_mail.execute({ limit: 10, everyone: false }, {})
      await opts.tools.add_to_list.execute({ items: ['gold coin'], list: 'shopping' }, {})
      throw new Error('429 quota')
    })
    const r = await runAgent({ chatId: '111', chatType: 'private', member, memberName: 'Rowan', mode: 'watcher', tools: ['new_mail', 'add_to_list'], text: 'add what school mail asks us to buy' })
    expect(r.text).toMatch(/^PROBLEM: .*added to a list/)
    expect(r.wrote).toEqual(['add_to_list'])
    expect(r.cursors?.map((c) => c.ids)).toEqual([['a']])
  })

  it('stages nothing for a failed look when the turn then ends on a write', async () => {
    const member = await q.upsertMember('111', 'Rowan', { allowed: true })
    listMail.mockResolvedValue([mail('a')])
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.new_mail.execute({ limit: 10, everyone: false }, {})
      await opts.tools.add_to_list.execute({ items: ['milk'], list: 'shopping' }, {})
      throw new Error('429 quota')
    })
    const r = await runAgent({ chatId: '111', chatType: 'private', member, memberName: 'Rowan', text: 'add milk, and any new mail?' })
    // The reply says what was done, not what arrived, so the mail stays new.
    expect(r.text).toContain('Done so far: added to a list')
    expect(r.cursors).toBeUndefined()
  })
})
