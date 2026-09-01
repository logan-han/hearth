import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

const generateText = vi.hoisted(() => vi.fn())
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText }))

const { runAgent, shouldChimeIn, systemPrompt, stripPreamble } = await import('@/lib/agent')

let client: PGlite

const reply = (text: string) => ({ text, steps: [], usage: {} })

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.GEMINI_API_KEY = 'k'
  process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite'
  delete process.env.LLM_BASE_URL
  delete process.env.OPENROUTER_API_KEY
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('systemPrompt', () => {
  const base = { memberName: 'Logan', now: new Date('2026-08-27T00:00:00Z'), context: '' }

  it('states the date and timezone so relative dates resolve', () => {
    const p = systemPrompt({ ...base, chatType: 'private' })
    expect(p).toContain('Australia/Melbourne')
    expect(p).toContain('2026-08-27')
  })

  it('tells the model who it is talking to', () => {
    expect(systemPrompt({ ...base, chatType: 'private' })).toContain('Logan')
  })

  it('differs between a group and a direct message', () => {
    expect(systemPrompt({ ...base, chatType: 'group' })).toContain('family group chat')
    expect(systemPrompt({ ...base, chatType: 'private' })).toContain('private chat')
  })

  it('always carries the no-silent-email rule', () => {
    expect(systemPrompt({ ...base, chatType: 'group' })).toContain('draft_email')
    expect(systemPrompt({ ...base, chatType: 'group' })).toContain('LATER turn')
  })

  it('tells the model a confirmed send means send_email with the context draft_id', () => {
    expect(systemPrompt({ ...base, chatType: 'private' })).toContain('send_email` NOW with the draft_id')
  })

  it('charges the model with capturing memories unprompted, and correcting them', () => {
    const p = systemPrompt({ ...base, chatType: 'group' })
    expect(p).toContain('call `remember` in that same turn')
    expect(p).toContain('`forget` the old one and `remember` the new one')
  })

  it('speaks the household language and units', () => {
    const p = systemPrompt({ ...base, chatType: 'private' })
    expect(p).toContain('Australian English, with metric units')
    process.env.LANGUAGE = 'American English'
    process.env.UNITS = 'imperial'
    try {
      expect(systemPrompt({ ...base, chatType: 'private' })).toContain('American English, with imperial units')
    } finally {
      delete process.env.LANGUAGE
      delete process.env.UNITS
    }
  })

  it('explains what to do with a photo', () => {
    expect(systemPrompt({ ...base, chatType: 'private' })).toContain('propose_family_event')
  })

  it('includes household context when there is some', () => {
    expect(systemPrompt({ ...base, chatType: 'private', context: 'Known facts: bins on Monday' }))
      .toContain('bins on Monday')
  })
})

describe('systemPrompt money rules', () => {
  const base = { memberName: 'Logan', now: new Date('2026-08-27T00:00:00Z'), context: '' }

  it('forbids reading a destination out of a payee string', () => {
    const p = systemPrompt({ ...base, chatType: 'group' })
    expect(p).toContain("merchant's own trading name and registered city")
    expect(p).toContain('CHEAPTICKETS SEATTLE')
  })

  it('forbids inventing routes, stopovers and airport codes', () => {
    const p = systemPrompt({ ...base, chatType: 'group' })
    expect(p).toContain('Never reconstruct a trip, route, itinerary or stopover from a transaction')
    expect(p).toContain('Do not expand airport, station or flight codes from memory')
  })

  it('sends the model to the confirmation email for a real itinerary', () => {
    expect(systemPrompt({ ...base, chatType: 'group' })).toContain('is in its confirmation email, not the bank feed')
  })
})

describe('stripPreamble', () => {
  it('cuts reasoning that hands over with "Now the post:"', () => {
    const text = [
      'Scooti/Scoot is a known budget airline, and the CHEAPTICKETS SEATTLE line is the other half. Now the post:',
      '',
      '*August snapshot*',
      'Money in **$23,887.18**.',
    ].join('\n')
    expect(stripPreamble(text)).toBe('*August snapshot*\nMoney in **$23,887.18**.')
  })

  it('keeps a reply that simply opens with a lead-in', () => {
    const text = "Here's the summary:\nTwo new transactions."
    expect(stripPreamble(text)).toBe(text)
  })

  it('leaves ordinary prose alone', () => {
    const text = 'Two new transactions today. The larger one is the school fee instalment.'
    expect(stripPreamble(text)).toBe(text)
  })

  it('never eats the whole reply', () => {
    const text = 'A long enough preamble to clear the guard, and now the post:\n'
    expect(stripPreamble(text)).toBe(text)
  })
})

describe('runAgent', () => {
  const input = { chatId: '-100', chatType: 'private', member: null, memberName: 'Logan', text: 'hi' }

  it('returns the model text and which model answered', async () => {
    generateText.mockResolvedValue(reply('Hello.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Hello.')
    expect(r.model).toBe('gemini:gemini-3.5-flash-lite')
  })

  it("lists every member's linked accounts in context, not just the speaker's", async () => {
    const logan = await q.upsertMember('111', 'Logan', { allowed: true })
    await q.saveConnection({ memberId: logan.id, provider: 'google', email: 'logan@han.life', refreshToken: 'r', scopes: null })
    const yuna = await q.upsertMember('222', 'Yuna', { allowed: true })
    await q.saveConnection({ memberId: yuna.id, provider: 'microsoft', email: 'y@hotmail.com', refreshToken: 'r', scopes: null })
    await q.upsertMember('333', 'Winter', { allowed: true })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, member: logan })
    const system = String(generateText.mock.calls[0][0].system)
    expect(system).toContain('Yuna (microsoft: y@hotmail.com)')
    expect(system).toContain('Winter (nothing linked)')
  })

  it('carries pending draft ids in context, so "send it" has something to act on', async () => {
    const m = await q.upsertMember('111', 'Logan', { allowed: true })
    const d = await q.createDraft({
      chatId: '-100', memberId: m.id, provider: 'google',
      to: ['x@y.com'], subject: 'Complaint', body: 'text',
    })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, chatId: '-100', member: m })
    const system = String(generateText.mock.calls[0][0].system)
    expect(system).toContain(`draft_id ${d.id}`)
    expect(system).toContain('x@y.com')
  })

  it('carries pending proposals in context, so a bare yes can settle one', async () => {
    await q.addProposal({
      chatId: '-100', memberId: null, title: 'Sports day',
      startsAt: new Date('2026-09-09T23:00:00Z'), endsAt: new Date('2026-09-10T00:00:00Z'),
      allDay: false, source: null,
    })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, chatId: '-100' })
    const system = String(generateText.mock.calls[0][0].system)
    expect(system).toContain('proposal_id')
    expect(system).toContain('Sports day')
  })

  it('still answers when the database is down, just without ambient context', async () => {
    const { __setDb } = await import('@/lib/db')
    __setDb({ select: () => { throw new Error('db down') } })
    generateText.mockResolvedValue(reply('Hello anyway.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Hello anyway.')
  })

  it('prefixes the speaker so a group transcript is attributable', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent(input)
    const messages = generateText.mock.calls[0][0].messages
    expect(messages.at(-1).content).toBe('Logan: hi')
  })

  it('replays chat history ahead of the new message', async () => {
    await q.recordMessage({ chatId: '-100', authorName: 'Ada', role: 'user', content: 'earlier' })
    await q.recordMessage({ chatId: '-100', role: 'assistant', content: 'answered' })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent(input)
    const messages = generateText.mock.calls[0][0].messages
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'user', content: 'Ada: earlier' })
    expect(messages[1]).toEqual({ role: 'assistant', content: 'answered' })
  })

  it('skips history entirely for a scheduled run', async () => {
    await q.recordMessage({ chatId: '-100', role: 'user', content: 'earlier' })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, history: false })
    expect(generateText.mock.calls[0][0].messages).toHaveLength(1)
  })

  it('leaves out the message it is answering', async () => {
    const id = await q.recordMessage({ chatId: '-100', authorName: 'Logan', role: 'user', content: 'hi' })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, excludeMessageId: id })
    expect(generateText.mock.calls[0][0].messages).toHaveLength(1)
  })

  it('sends attachments as file parts beside the text', async () => {
    generateText.mockResolvedValue(reply('A school notice.'))
    await runAgent({
      ...input,
      attachments: [{ bytes: new Uint8Array([1, 2]), mediaType: 'image/png', kind: 'photo' }],
    })
    const content = generateText.mock.calls[0][0].messages.at(-1).content
    expect(content[0]).toEqual({ type: 'text', text: 'Logan: hi' })
    expect(content[1]).toMatchObject({ type: 'file', mediaType: 'image/png' })
  })

  it('describes a caption-less photo so the model has something to act on', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({
      ...input,
      text: '',
      attachments: [{ bytes: new Uint8Array([1]), mediaType: 'image/png', kind: 'photo' }],
    })
    expect(generateText.mock.calls[0][0].messages.at(-1).content[0].text).toContain('sent a photo')
  })

  it('names a voice note and a PDF for what they are', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({
      ...input, text: '',
      attachments: [
        { bytes: new Uint8Array([1]), mediaType: 'audio/ogg', kind: 'voice' },
        { bytes: new Uint8Array([1]), mediaType: 'application/pdf', kind: 'document' },
      ],
    })
    const said = generateText.mock.calls[0][0].messages.at(-1).content[0].text
    expect(said).toContain('a voice note')
    expect(said).toContain('a PDF')
  })

  it('falls through to the next model when the first fails', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    process.env.OPENROUTER_MODEL = 'minimax/minimax-m3:free'
    generateText.mockRejectedValueOnce(new Error('429 quota')).mockResolvedValueOnce(reply('Second here.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Second here.')
    expect(r.model).toContain('openrouter')
  })

  it('treats an empty completion as a failure worth retrying', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText.mockResolvedValueOnce(reply('   ')).mockResolvedValueOnce(reply('Proper answer.'))
    expect((await runAgent(input)).text).toBe('Proper answer.')
  })

  it('accepts an empty completion when a tool already produced a notice', async () => {
    generateText.mockImplementation(async (opts: { tools: Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }> }) => {
      await opts.tools.add_family_event.execute(
        { title: 'Soccer', start: '2026-08-29T09:00', all_day: false }, {},
      )
      return reply('')
    })
    const r = await runAgent(input)
    expect(r.notices.join(' ')).toContain('Soccer')
    expect(r.text).toContain('Soccer')
  })

  it('throws when nothing is configured at all', async () => {
    delete process.env.GEMINI_API_KEY
    await expect(runAgent(input)).rejects.toThrow(/No LLM configured/)
  })

  it('offers /connect in context when the member has linked nothing', async () => {
    const m = await q.upsertMember('111', 'Logan', { allowed: true })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, member: m })
    expect(generateText.mock.calls[0][0].system).toContain('/connect')
  })

  it('lists the linked accounts in context when there are some', async () => {
    const m = await q.upsertMember('111', 'Logan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'r', scopes: null })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, member: m })
    expect(generateText.mock.calls[0][0].system).toContain('Logan (google: a@b.com)')
  })

  it('puts household memories in front of the model', async () => {
    await q.addMemory('bin night is Monday')
    generateText.mockResolvedValue(reply('ok'))
    await runAgent(input)
    expect(generateText.mock.calls[0][0].system).toContain('bin night is Monday')
  })
})

describe('shouldChimeIn', () => {
  const input = { chatId: '-100', text: 'anyone know the wifi password?', memberName: 'Ada' }

  it('says yes on a clear YES', async () => {
    generateText.mockResolvedValue(reply('YES'))
    expect(await shouldChimeIn(input)).toBe(true)
  })

  it('says no on NO', async () => {
    generateText.mockResolvedValue(reply('NO'))
    expect(await shouldChimeIn(input)).toBe(false)
  })

  it('fails closed when the gate model errors', async () => {
    generateText.mockRejectedValue(new Error('down'))
    expect(await shouldChimeIn(input)).toBe(false)
  })

  it('fails closed on an answer it cannot read', async () => {
    generateText.mockResolvedValue(reply('perhaps'))
    expect(await shouldChimeIn(input)).toBe(false)
  })

  it('spends only one call, on the head of the chain', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText.mockRejectedValue(new Error('down'))
    await shouldChimeIn(input)
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('gives the gate a tiny output budget', async () => {
    generateText.mockResolvedValue(reply('NO'))
    await shouldChimeIn(input)
    expect(generateText.mock.calls[0][0].maxOutputTokens).toBeLessThanOrEqual(8)
  })
})
