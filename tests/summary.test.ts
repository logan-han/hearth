import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

const generateText = vi.hoisted(() => vi.fn())
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText }))

const { maybeSummarise, SUMMARISE_BATCH } = await import('@/lib/summary')
const { runAgent } = await import('@/lib/agent')

let client: PGlite
const reply = (text: string) => ({ text, steps: [], usage: {} })

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.GEMINI_API_KEY = 'k'
  process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite'
  client = (await freshDb()).client
  await q.rememberChat('-100', 'group', 'Family')
})
afterEach(async () => closeDb(client))

async function talk(n: number, from = 1) {
  const ids: number[] = []
  for (let i = from; i < from + n; i++) {
    ids.push(await q.recordMessage({ chatId: '-100', authorName: i % 2 ? 'Logan' : 'Yuna', role: 'user', content: `message ${i}` }))
  }
  return ids
}

describe('maybeSummarise', () => {
  it('waits until enough has fallen out of the raw window', async () => {
    await talk(q.CONTEXT_WINDOW + SUMMARISE_BATCH - 1)
    expect(await maybeSummarise('-100')).toBe(false)
    expect(generateText).not.toHaveBeenCalled()
  })

  it('summarises only what the raw window no longer holds, and remembers how far it got', async () => {
    const ids = await talk(q.CONTEXT_WINDOW + SUMMARISE_BATCH)
    generateText.mockResolvedValue(reply('Logan and Yuna talked about messages 1 to 6.'))
    expect(await maybeSummarise('-100')).toBe(true)
    const prompt = String(generateText.mock.calls[0][0].prompt)
    expect(prompt).toContain('message 1')
    expect(prompt).toContain(`message ${SUMMARISE_BATCH}`)
    expect(prompt).not.toContain(`message ${SUMMARISE_BATCH + 1}`)
    expect(prompt).not.toContain('RUNNING SUMMARY')
    expect(generateText.mock.calls[0][0].tools).toBeUndefined()
    const stored = await q.chatSummary('-100')
    expect(stored.summary).toBe('Logan and Yuna talked about messages 1 to 6.')
    expect(stored.through).toBe(ids[SUMMARISE_BATCH - 1])
  })

  it('folds later talk into the existing summary rather than starting over', async () => {
    await talk(q.CONTEXT_WINDOW + SUMMARISE_BATCH)
    generateText.mockResolvedValue(reply('First pass.'))
    await maybeSummarise('-100')
    await talk(SUMMARISE_BATCH, 100)
    generateText.mockResolvedValue(reply('First pass, then more.'))
    expect(await maybeSummarise('-100')).toBe(true)
    const prompt = String(generateText.mock.calls[1][0].prompt)
    expect(prompt).toContain('RUNNING SUMMARY SO FAR:\nFirst pass.')
    expect(prompt).toContain(`message ${SUMMARISE_BATCH + 1}`)
    expect(prompt).not.toContain('message 1\n')
    expect((await q.chatSummary('-100')).summary).toBe('First pass, then more.')
  })

  it('keeps the old summary when the model returns nothing usable', async () => {
    await talk(q.CONTEXT_WINDOW + SUMMARISE_BATCH)
    generateText.mockResolvedValue(reply('<think>still going'))
    await expect(maybeSummarise('-100')).rejects.toThrow(/no summary/)
    expect((await q.chatSummary('-100')).summary).toBeNull()
  })

  it('puts the summary in front of the chat model, above the household facts', async () => {
    await q.setChatSummary('-100', "Ada's dentist is Thursday 2pm.", 3)
    await q.addMemory('bin night is Monday')
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ chatId: '-100', chatType: 'group', member: null, memberName: 'Logan', text: "when is Ada's dentist?" })
    const system = String(generateText.mock.calls[0][0].system)
    expect(system).toContain('Earlier in this chat, summarised')
    expect(system.indexOf("Ada's dentist is Thursday 2pm.")).toBeLessThan(system.indexOf('bin night is Monday'))
  })
})
