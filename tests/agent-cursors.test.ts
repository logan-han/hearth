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

const { runAgent, looksBefore } = await import('@/lib/agent')
const { commitCursors } = await import('@/lib/tools/cursor')

let client: PGlite
type Tools = Record<string, { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }>

const reply = (text: string) => ({ text, steps: [], usage: {} })
const mail = (id: string) => ({ id, from: 'school@x.edu', to: 'me@x.com', subject: 'S', snippet: '…', date: new Date(Date.now() - 3600_000).toISOString(), unread: true })
const rowan = () => q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
const looked = (r: Record<string, unknown>) => (r.accounts as { messages: unknown[] }[])[0].messages.length

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.GEMINI_API_KEY = 'k'
  process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite'
  process.env.OPENROUTER_API_KEY = 'sk-or'
  process.env.OPENROUTER_MODEL = 'minimax/minimax-m3:free'
  // The fallback cases fail Gemini first and hand on to OpenRouter.
  process.env.LLM_ORDER = 'gemini,openrouter'
  delete process.env.LLM_BASE_URL
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('a scheduled run that looks at new mail', () => {
  it('hands its cursor moves back, on its own markers, for the caller to make once the report is kept', async () => {
    const member = await rowan()
    listMail.mockResolvedValue([mail('a')])
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      expect(looked(await opts.tools.new_mail.execute({ limit: 10 }, {}))).toBe(1)
      return reply('One email from the school.')
    })
    const r = await runAgent({ member, memberName: 'Rowan', cursorScope: 'auto:7', text: 'report new school mail' })
    const key = `mail_cursor:auto:7:${member.id}:google`
    expect(r.cursors?.map((c) => c.key)).toEqual([key])
    // Nothing is spent until the caller says the report was kept.
    expect(await q.getSetting(key)).toBeNull()
    await commitCursors(r.cursors)
    expect(JSON.parse((await q.getSetting(key))!).ids).toEqual(['a'])
  })

  it('reads on markers of its own kind when the caller names none', async () => {
    const member = await rowan()
    listMail.mockResolvedValue([mail('a')])
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.new_mail.execute({ limit: 10 }, {})
      return reply('One email from the school.')
    })
    const r = await runAgent({ member, memberName: 'Rowan', text: 'report new school mail' })
    expect(r.cursors?.map((c) => c.key)).toEqual([`mail_cursor:own:${member.id}:google`])
  })

  it('shows the next model the same new mail when the first failed after looking', async () => {
    const member = await rowan()
    listMail.mockResolvedValue([mail('a')])
    let secondSaw = -1
    generateText
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        await opts.tools.new_mail.execute({ limit: 10 }, {})
        throw new Error('429 quota')
      })
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        secondSaw = looked(await opts.tools.new_mail.execute({ limit: 10 }, {}))
        return reply('One email from the school.')
      })
    const r = await runAgent({ member, memberName: 'Rowan', cursorScope: 'auto:7', text: 'report new school mail' })
    expect(r.model).toContain('openrouter')
    expect(secondSaw).toBe(1)
    // One move, from the model whose report is kept.
    expect(r.cursors).toHaveLength(1)
  })

  it('claims nothing of the mail a failed model looked at when the next answers without looking', async () => {
    const member = await rowan()
    listMail.mockResolvedValue([mail('a')])
    generateText
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        await opts.tools.new_mail.execute({ limit: 10 }, {})
        throw new Error('429 quota')
      })
      .mockResolvedValueOnce(reply('Bins out tonight.'))
    const r = await runAgent({ member, memberName: 'Rowan', cursorScope: 'auto:7', text: 'remind about the bins' })
    expect(r.text).toBe('Bins out tonight.')
    expect(r.cursors).toBeUndefined()
  })

  it("spends a run's looks along with an unrepeatable write it made on them, even as it fails", async () => {
    listMail.mockResolvedValue([mail('a')])
    const member = await rowan()
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.new_mail.execute({ limit: 10 }, {})
      await opts.tools.add_to_list.execute({ items: ['gold coin'], list: 'shopping' }, {})
      throw new Error('429 quota')
    })
    const r = await runAgent({ member, memberName: 'Rowan', cursorScope: 'auto:7', tools: ['new_mail', 'add_to_list'], text: 'add what school mail asks us to buy' })
    expect(r.text).toMatch(/^PROBLEM: .*added to a list/)
    expect(r.wrote).toEqual(['add_to_list'])
    expect(r.cursors?.map((c) => c.ids)).toEqual([['a']])
  })

  it('keeps what a failed run looked at against the error, for the tick to count it by', async () => {
    const member = await rowan()
    listMail.mockResolvedValue([mail('a')])
    process.env.OPENROUTER_API_KEY = ''
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.new_mail.execute({ limit: 10 }, {})
      throw new Error('the attachment cannot be read')
    })
    const err = await runAgent({ member, memberName: 'Rowan', cursorScope: 'auto:7', tools: ['new_mail'], text: 'report new school mail' }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('the attachment cannot be read')
    expect(looksBefore(err).map((c) => c.ids)).toEqual([['a']])
    // Nothing was spent: the looks ride on the error, not the cursor.
    expect(await q.getSetting(`mail_cursor:auto:7:${member.id}:google`)).toBeNull()
    expect(looksBefore('not an error')).toEqual([])
    expect(looksBefore(new Error('never seen'))).toEqual([])
  })

  it('spends what a cut-short report read when it is kept because no later model answered', async () => {
    const member = await rowan()
    listMail.mockResolvedValue([mail('a')])
    const lines = Array.from({ length: 12 }, (_, i) => `- Item ${i}: something the school wants by Friday`)
    generateText
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        await opts.tools.new_mail.execute({ limit: 10 }, {})
        return { ...reply(`**School**\n${lines.join('\n')}\n- Item 12: somethi`), finishReason: 'length' }
      })
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        await opts.tools.new_mail.execute({ limit: 10 }, {})
        throw new Error('429 quota')
      })
    const r = await runAgent({ member, memberName: 'Rowan', cursorScope: 'auto:7', tools: ['new_mail'], text: 'report new school mail' })
    expect(r.cutShort).toBe(true)
    // The first model's look, once: the second's went with its failure.
    expect(r.cursors?.map((c) => c.ids)).toEqual([['a']])
  })
})
