import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

const generateText = vi.hoisted(() => vi.fn())
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText }))

const { runAgent, shouldChimeIn, systemPrompt, stripPreamble, stripReasoning, cleanReply, collectEvidence, decideWatcherPost, isStructuredOutputError } = await import('@/lib/agent')

let client: PGlite

const reply = (text: string) => ({ text, steps: [], usage: {} })

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
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
    expect(systemPrompt({ ...base, chatType: 'private' })).toContain('direct message')
  })

  it('always carries the no-silent-email rule', () => {
    expect(systemPrompt({ ...base, chatType: 'group' })).toContain('draft_email')
    expect(systemPrompt({ ...base, chatType: 'group' })).toContain('LATER turn')
  })

  it('tells the model a confirmed send means send_email with the context draft_id', () => {
    expect(systemPrompt({ ...base, chatType: 'private' })).toContain('call send_email NOW with that draft_id')
  })

  it('leaves proactive memory filing to the nightly pass, and keeps corrections in the chat', () => {
    const p = systemPrompt({ ...base, chatType: 'group' })
    expect(p).toContain('Do not file facts on your own initiative')
    expect(p).toContain('pass the old id as replaces')
  })

  it('speaks the household language and units', () => {
    const p = systemPrompt({ ...base, chatType: 'private' })
    expect(p).toContain('Australian English with metric units')
    process.env.LANGUAGE = 'American English'
    process.env.UNITS = 'imperial'
    try {
      expect(systemPrompt({ ...base, chatType: 'private' })).toContain('American English with imperial units')
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

  it('explains what a payee string is, with the Seattle case as the worked example', () => {
    const p = systemPrompt({ ...base, chatType: 'group' })
    expect(p).toContain('a trading name and a registered city, not where the household went')
    expect(p).toContain('CHEAPTICKETS SEATTLE')
    expect(p).toContain('No source names a trip')
  })

  it('sends the model to the confirmation email for where a booking goes', () => {
    expect(systemPrompt({ ...base, chatType: 'group' })).toContain('comes only from a confirmation email or a Known fact')
  })

  it('stays under a few dozen rule lines, in plain lines rather than prose', () => {
    const p = systemPrompt({ ...base, chatType: 'group' })
    const ruleLines = p.split('\n').filter((l) => /^[A-Z][A-Z ,]+:/.test(l))
    expect(ruleLines.length).toBeGreaterThan(8)
    expect(ruleLines.length).toBeLessThan(25)
    expect(p).not.toMatch(/^- /m)
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

  it('says yes when the question answered from both sides agrees', async () => {
    generateText.mockResolvedValue(reply('YES'))
    expect(await shouldChimeIn(input)).toBe(true)
    expect(generateText).toHaveBeenCalledTimes(2)
    expect(String(generateText.mock.calls[0][0].messages.at(-1).content)).toContain('Should the assistant reply?')
    expect(String(generateText.mock.calls[1][0].messages.at(-1).content)).toContain('Should the assistant stay silent?')
  })

  it('stays quiet when the two framings disagree', async () => {
    generateText.mockResolvedValueOnce({ ...reply(''), output: 'reply' }).mockResolvedValueOnce({ ...reply(''), output: 'stay_silent' })
    expect(await shouldChimeIn(input)).toBe(false)
  })

  it('settles banter with a single call', async () => {
    generateText.mockResolvedValue({ ...reply(''), output: 'stay_silent' })
    expect(await shouldChimeIn(input)).toBe(false)
    expect(generateText).toHaveBeenCalledTimes(1)
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

  it('keeps the gate cheap, with room for a model that thinks before it answers', async () => {
    generateText.mockResolvedValue(reply('NO'))
    await shouldChimeIn(input)
    expect(generateText.mock.calls[0][0].maxOutputTokens).toBeLessThanOrEqual(64)
    expect(generateText.mock.calls[0][0].tools).toBeUndefined()
  })

  it('asks for a typed choice and trusts it over the prose', async () => {
    generateText.mockResolvedValue({ ...reply('no idea'), output: 'reply' })
    expect(await shouldChimeIn(input)).toBe(true)
    expect(generateText.mock.calls[0][0].output).toBeDefined()
  })

  it('fails closed if the second framing errors', async () => {
    generateText.mockResolvedValueOnce({ ...reply(''), output: 'reply' }).mockRejectedValueOnce(new Error('down'))
    expect(await shouldChimeIn(input)).toBe(false)
  })

  it('treats unsure as silence', async () => {
    generateText.mockResolvedValue({ ...reply(''), output: 'unsure' })
    expect(await shouldChimeIn(input)).toBe(false)
  })
})

describe('per-mode prompts', () => {
  const base = { memberName: 'the family', now: new Date('2026-08-27T00:00:00Z'), context: '' }

  it('gives a watcher grounding rules and examples, not the chat rules', () => {
    const p = systemPrompt({ ...base, mode: 'watcher', chatType: 'group' })
    expect(p).toContain('WRITE using only the information under DATA')
    expect(p).toContain('purpose not recorded')
    expect(p).toContain('reply with exactly SKIP')
    expect(p).toContain('No source names a trip')
    expect(p).not.toContain('draft_email')
    expect(p).not.toContain('/connect')
  })

  it('gives the sweep only the memory rules', () => {
    const p = systemPrompt({ ...base, mode: 'sweep', chatType: 'private' })
    expect(p).toContain('nightly memory pass')
    expect(p).toContain('replaces set to the old id')
    expect(p).not.toContain('send_email')
  })
})

describe('tool scoping by mode', () => {
  const input = { chatId: '-100', chatType: 'group', member: null, memberName: 'the family', text: 'go', history: false }

  it('leaves every tool open to a chat turn', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'chat' })
    expect(generateText.mock.calls[0][0].activeTools).toBeUndefined()
  })

  it('gives the sweep only the memory tools', async () => {
    generateText.mockResolvedValue(reply('SKIP'))
    await runAgent({ ...input, mode: 'sweep' })
    expect(generateText.mock.calls[0][0].activeTools).toEqual(['remember', 'forget', 'recall'])
  })

  it('keeps a custom watcher read-only', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'watcher' })
    const active: string[] = generateText.mock.calls[0][0].activeTools
    expect(active).toContain('new_transactions')
    expect(active).toContain('propose_family_event')
    expect(active).not.toContain('send_email')
    expect(active).not.toContain('add_family_event')
    expect(active).not.toContain('remember')
    expect(active).not.toContain('create_automation')
  })

  it('honours an explicit tool list', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'watcher', tools: ['recall'] })
    expect(generateText.mock.calls[0][0].activeTools).toEqual(['recall'])
  })

  it('runs watchers and the sweep cooler than chat', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'chat' })
    await runAgent({ ...input, mode: 'watcher' })
    expect(generateText.mock.calls[0][0].temperature).toBeUndefined()
    expect(generateText.mock.calls[1][0].temperature).toBeLessThan(0.5)
  })

  it('gives a watcher no memories in context, and the sweep all of them', async () => {
    await q.addMemory('bin night is Monday')
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'watcher' })
    expect(String(generateText.mock.calls[0][0].system)).not.toContain('bin night')
    await runAgent({ ...input, mode: 'sweep' })
    expect(String(generateText.mock.calls[1][0].system)).toContain('bin night is Monday')
  })

  it('returns what the tools said as evidence for a watcher run', async () => {
    generateText.mockResolvedValue({
      ...reply('2Up: **$412.30** CHEAPTICKETS SEATTLE.'),
      steps: [{ toolResults: [{ toolName: 'new_transactions', input: { account: '2up' }, output: { count: 1 } }] }],
    })
    const r = await runAgent({ ...input, mode: 'watcher' })
    expect(r.evidence).toContain('new_transactions')
    expect(r.evidence).toContain('"count":1')
    generateText.mockResolvedValue(reply('hello'))
    expect((await runAgent({ ...input, mode: 'chat' })).evidence).toBeUndefined()
  })
})

describe('leaked reasoning', () => {
  it('drops inline think blocks and keeps the answer', () => {
    expect(stripReasoning('<think>is it Monday?</think>Bins out tonight.')).toBe('Bins out tonight.')
  })

  it('treats a reply that never finished thinking as empty', () => {
    expect(stripReasoning('<think>still working this out')).toBe('')
  })

  it('reports whether anything was cut', () => {
    expect(cleanReply('Plain answer.')).toEqual({ text: 'Plain answer.', stripped: false })
    expect(cleanReply('<think>hm</think>Answer.').stripped).toBe(true)
  })

  it('strips thinking from a live reply, and moves on when that leaves nothing', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockResolvedValueOnce(reply('<think>never mind'))
      .mockResolvedValueOnce(reply('<think>ok</think>Bins out tonight.'))
    const r = await runAgent({ chatId: '-100', chatType: 'private', member: null, memberName: 'Logan', text: 'hi' })
    expect(r.text).toBe('Bins out tonight.')
    expect(r.model).toContain('openrouter')
  })
})

describe('collectEvidence', () => {
  it('clips long results and stops at the total budget', () => {
    const big = 'x'.repeat(5_000)
    const steps = Array.from({ length: 10 }, () => ({ toolResults: [{ toolName: 'read_url', input: {}, output: big }] }))
    const out = collectEvidence(steps)
    expect(out.length).toBeLessThanOrEqual(12_100)
    expect(out.split('\n').length).toBeLessThan(10)
  })
})

describe('decideWatcherPost', () => {
  it('asks for a structured decision with no tools and returns it with the model', async () => {
    generateText.mockResolvedValue({ ...reply(''), output: { decision: 'post', confidence: 0.9, message: 'Trimmed.' } })
    const d = await decideWatcherPost({ label: '2Up transactions', draft: 'draft', evidence: 'evidence' })
    expect(d).toMatchObject({ decision: 'post', confidence: 0.9, message: 'Trimmed.', model: 'gemini:gemini-3.5-flash-lite' })
    const call = generateText.mock.calls[0][0]
    expect(call.output).toBeDefined()
    expect(call.tools).toBeUndefined()
    expect(String(call.system)).toContain('+0.4 if you choose skip')
    expect(String(call.prompt)).toContain('DRAFT:\ndraft')
  })

  it('moves to the next model when the first returns no object', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockRejectedValueOnce(new Error('No object generated'))
      .mockResolvedValueOnce({ ...reply(''), output: { decision: 'skip', confidence: 0.8 } })
    const d = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(d.decision).toBe('skip')
    expect(d.model).toContain('openrouter')
  })

  it('tells a plain error apart from a structured-output failure', () => {
    expect(isStructuredOutputError(new Error('boom'))).toBe(false)
  })
})
