import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { recordModelEvent } from '@/lib/model-events'
import { WATCHERS } from '@/lib/watchers'

const generateText = vi.hoisted(() => vi.fn())
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText }))

/** Jev, with the transport faked: what the SDK would have asked, and the probabilities it hands back. */
const systemOne = vi.hoisted(() => vi.fn())
vi.mock('@typesafe-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@typesafe-ai/sdk')>()
  class TypeSafeClient {
    systemOne = systemOne
  }
  return { ...actual, TypeSafeClient }
})

const { runAgent, shouldChimeIn, systemPrompt, stripPreamble, stripWorking, stripReasoning, cleanReply, collectEvidence, decideWatcherPost, reviewDraft, isStructuredOutputError } = await import('@/lib/agent')

let client: PGlite

const reply = (text: string) => ({ text, steps: [], usage: {} })

/** Five structured calls answered with prose: enough for the chain to stop asking that slot first. */
async function keepsAnsweringInProse(slot: string) {
  for (let i = 0; i < 5; i++) {
    await recordModelEvent({ slot, purpose: 'hearth.verify', outcome: 'failed', error: 'No object generated: could not parse the response.' })
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.GEMINI_API_KEY = 'k'
  process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite'
  delete process.env.LLM_BASE_URL
  delete process.env.OPENROUTER_API_KEY
  delete process.env.TYPESAFE_API_KEY
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('systemPrompt', () => {
  const base = { memberName: 'Rowan', now: new Date('2026-08-27T00:00:00Z'), context: '' }

  it('states the date and timezone so relative dates resolve', () => {
    const p = systemPrompt({ ...base, chatType: 'private' })
    expect(p).toContain('Australia/Melbourne')
    expect(p).toContain('2026-08-27')
  })

  it('tells the model who it is talking to', () => {
    expect(systemPrompt({ ...base, chatType: 'private' })).toContain('Rowan')
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
  const base = { memberName: 'Rowan', now: new Date('2026-08-27T00:00:00Z'), context: '' }

  it('explains what a payee string is, with a placeholder example rather than a real payee', () => {
    const p = systemPrompt({ ...base, chatType: 'group' })
    expect(p).toContain('a trading name and a registered city, not where the household went')
    expect(p).toContain('<PAYEE CITY>')
    expect(p).toContain('No source names a trip')
  })

  it('names no particular merchant, place, school or event in any mode or watcher instruction', () => {
    // The fixtures' own stand-ins: a prompt teaches a shape with <placeholders>, never with an example the evals then recognise.
    const specific = /faresaver|lisbon|freshmart|hillside|riverbend|athletics carnival|school|tradies/i
    for (const mode of ['chat', 'watcher', 'sweep'] as const) {
      expect(systemPrompt({ ...base, mode, chatType: 'group' })).not.toMatch(specific)
    }
    for (const w of Object.values(WATCHERS)) expect(w.instruction).not.toMatch(specific)
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
      'Faresaver is a budget airline, and the FARESAVER LISBON line is the other half. Now the post:',
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

describe('stripWorking', () => {
  const working = [
    'I have what I need. Known facts confirm the tax line is deliberate, and the tuition payee is familiar. No web lookup needed.',
    '',
    'Weekly snapshot: in **$8,898.07**, out **$7,973.28**, net **+$924.79**.',
    '',
    'Top spend: Kids $5,273.24 (66% of spend).',
  ].join('\n')
  const post = 'Weekly snapshot: in **$8,898.07**, out **$7,973.28**, net **+$924.79**.\n\nTop spend: Kids $5,273.24 (66% of spend).'

  it('cuts an opening paragraph of working with no handover line when a post follows it', () => {
    expect(stripWorking(working)).toBe(post)
  })

  it('cuts several such paragraphs in a row', () => {
    expect(stripWorking("Let me check the feed first.\n\nI'll fetch the budget too.\n\nBins out tonight.")).toBe('Bins out tonight.')
  })

  it('never eats a reply that is only working', () => {
    const text = 'I have what I need. No web lookup needed.'
    expect(stripWorking(text)).toBe(text)
  })

  it('leaves a post alone that never talks about itself', () => {
    expect(stripWorking(post)).toBe(post)
  })

  it('is applied to watcher replies only', () => {
    expect(cleanReply(working, { working: true })).toEqual({ text: post, stripped: true })
    expect(cleanReply(working).text.startsWith('I have what I need')).toBe(true)
  })
})

describe('runAgent', () => {
  const input = { chatId: '-100', chatType: 'private', member: null, memberName: 'Rowan', text: 'hi' }

  it('returns the model text and which model answered', async () => {
    generateText.mockResolvedValue(reply('Hello.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Hello.')
    expect(r.model).toBe('gemini:gemini-3.5-flash-lite')
  })

  it('strips leaked working from a watcher reply, and keeps a chat reply whole', async () => {
    const leaked = 'I have what I need. No web lookup needed.\n\nBins out tonight.'
    generateText.mockResolvedValue(reply(leaked))
    expect((await runAgent({ ...input, mode: 'watcher' })).text).toBe('Bins out tonight.')
    expect((await runAgent({ ...input, mode: 'chat' })).text).toBe(leaked)
  })

  it("lists every member's linked accounts in context, not just the speaker's", async () => {
    const rowan = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.saveConnection({ memberId: rowan.id, provider: 'google', email: 'rowan@hearth.example', refreshToken: 'r', scopes: null })
    const sam = await q.upsertMember('222', 'Sam', { allowed: true })
    await q.saveConnection({ memberId: sam.id, provider: 'microsoft', email: 'sam@outlook.example', refreshToken: 'r', scopes: null })
    await q.upsertMember('333', 'Juno', { allowed: true })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, member: rowan })
    const system = String(generateText.mock.calls[0][0].system)
    expect(system).toContain('Sam (microsoft: sam@outlook.example)')
    expect(system).toContain('Juno (nothing linked)')
  })

  it('carries pending draft ids in context, so "send it" has something to act on', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
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
      chatId: '-100', memberId: null, title: 'Athletics carnival',
      startsAt: new Date('2030-09-09T23:00:00Z'), endsAt: new Date('2030-09-10T00:00:00Z'),
      allDay: false, source: null,
    })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, chatId: '-100' })
    const system = String(generateText.mock.calls[0][0].system)
    expect(system).toContain('proposal_id')
    expect(system).toContain('Athletics carnival')
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
    expect(messages.at(-1).content).toBe('Rowan: hi')
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
    const id = await q.recordMessage({ chatId: '-100', authorName: 'Rowan', role: 'user', content: 'hi' })
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
    expect(content[0]).toEqual({ type: 'text', text: 'Rowan: hi' })
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

  it('reads a calendar file into a listing, keeps its events for the import tool, and offers that tool', async () => {
    generateText.mockResolvedValue(reply('ok'))
    const ics = [
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Scouts Cuboree', 'DTSTART;VALUE=DATE:20260930', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n')
    await runAgent({
      ...input,
      text: 'Add uploaded .ics file into family calendar',
      attachments: [{ bytes: new TextEncoder().encode(ics), mediaType: 'text/calendar', filename: 'cuboree.ics', kind: 'document' }],
    })
    const call = generateText.mock.calls[0][0]
    const content = call.messages.at(-1).content
    // Text and a listing; no file part, which the endpoints would reject.
    expect(content).toHaveLength(2)
    expect(content[1].type).toBe('text')
    expect(content[1].text).toContain('Calendar file "cuboree.ics": 1 event')
    expect(content[1].text).toContain('Scouts Cuboree: Wed, 30 Sept 2026 (all day)')
    const active: string[] = call.prepareStep({ steps: [], stepNumber: 0, model: {}, messages: [] }).activeTools
    expect(active).toContain('import_calendar_file')
    // The import tool reaches the parsed events through the shared context.
    const out = await call.tools.import_calendar_file.execute({}, {})
    expect(out.added).toHaveLength(1)
    const [e] = await q.listFamilyEvents(new Date('2026-09-01'), new Date('2026-10-30'))
    expect(e).toMatchObject({ title: 'Scouts Cuboree', allDay: true })
  })

  it('recognises a calendar by its content when the type and name say nothing', async () => {
    generateText.mockResolvedValue(reply('ok'))
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Camp\r\nDTSTART;VALUE=DATE:20261003\r\nEND:VEVENT\r\nEND:VCALENDAR'
    await runAgent({ ...input, attachments: [{ bytes: new TextEncoder().encode(ics), mediaType: 'text/plain', filename: 'attachment', kind: 'document' }] })
    const call = generateText.mock.calls[0][0]
    expect(call.messages.at(-1).content[1].text).toContain('Calendar file "attachment": 1 event')
    expect(call.prepareStep({ steps: [], stepNumber: 0, model: {}, messages: [] }).activeTools).toContain('import_calendar_file')
  })

  it('hands any other text file over as text, and does not offer the import tool', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({
      ...input,
      attachments: [{ bytes: new TextEncoder().encode('milk\neggs'), mediaType: 'text/plain', filename: 'list.txt', kind: 'document' }],
    })
    const call = generateText.mock.calls[0][0]
    expect(call.messages.at(-1).content[1]).toEqual({ type: 'text', text: 'Attached file "list.txt" (text/plain):\nmilk\neggs' })
    expect(call.prepareStep({ steps: [], stepNumber: 0, model: {}, messages: [] }).activeTools).not.toContain('import_calendar_file')
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

  it('treats a reply the output cap cut short as a failure, so the next model gets a turn', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockResolvedValueOnce({ ...reply('Y'), finishReason: 'length' })
      .mockResolvedValueOnce(reply('Proper answer.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Proper answer.')
    expect(r.model).toContain('openrouter')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.stringContaining('ran out of output tokens'))
  })

  it('keeps a reply that ran long before the cap cut it', async () => {
    const long = 'The school newsletter says the concert is on Friday and the bus leaves at eight. '.repeat(4).trim()
    generateText.mockResolvedValueOnce({ ...reply(long), finishReason: 'length' })
    expect((await runAgent(input)).text).toBe(long)
  })

  it('drops a cut-short fragment but keeps the notice a tool already produced', async () => {
    generateText.mockImplementation(async (opts: { tools: Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }> }) => {
      await opts.tools.add_family_event.execute(
        { title: 'Soccer', start: '2026-08-29T09:00', all_day: false }, {},
      )
      return { ...reply('Y'), finishReason: 'length' }
    })
    const r = await runAgent(input)
    expect(r.notices.join(' ')).toContain('Soccer')
    expect(r.text).toBe(r.notices.join('\n'))
  })

  it('throws when nothing is configured at all', async () => {
    delete process.env.GEMINI_API_KEY
    await expect(runAgent(input)).rejects.toThrow(/No LLM configured/)
  })

  it('offers /connect in context when the member has linked nothing', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, member: m })
    expect(generateText.mock.calls[0][0].system).toContain('/connect')
  })

  it('lists the linked accounts in context when there are some', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'a@b.com', refreshToken: 'r', scopes: null })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, member: m })
    expect(generateText.mock.calls[0][0].system).toContain('Rowan (google: a@b.com)')
  })

  it('puts household memories in front of the model', async () => {
    await q.addMemory('bin night is Monday')
    generateText.mockResolvedValue(reply('ok'))
    await runAgent(input)
    expect(generateText.mock.calls[0][0].system).toContain('bin night is Monday')
  })
})

describe('a reply that reports a change no tool made', () => {
  const input = { chatId: '-100', chatType: 'private', member: null, memberName: 'Rowan', text: 'replace the 30 Sep vacation care with Scouts Cuboree' }
  const judged = (choice: string) => ({ text: '', output: choice, steps: [], usage: {} })
  const wrote = (text: string, toolName: string) => ({ text, steps: [{ toolCalls: [{ toolName, input: {} }] }], usage: {} })

  it('asks the model to act or take it back, in the same conversation', async () => {
    generateText
      .mockResolvedValueOnce(reply('Done. Replaced it.'))
      .mockResolvedValueOnce(judged('claims_change'))
      .mockResolvedValueOnce(reply('Which one? That day has two events on the calendar.'))
      .mockResolvedValueOnce(judged('no_change_claimed'))
    const r = await runAgent(input)
    expect(r.text).toBe('Which one? That day has two events on the calendar.')
    expect(generateText).toHaveBeenCalledTimes(4)
    expect(generateText.mock.calls[1][0].telemetry.functionId).toBe('hearth.claim')
    const retry = generateText.mock.calls[2][0].messages
    expect(retry.at(-2)).toEqual({ role: 'assistant', content: 'Done. Replaced it.' })
    expect(String(retry.at(-1).content)).toContain('no tool was called this turn')
  })

  it('is satisfied by a write tool call on the second try', async () => {
    generateText
      .mockResolvedValueOnce(reply('Replaced it.'))
      .mockResolvedValueOnce(judged('claims_change'))
      .mockResolvedValueOnce(wrote('Replaced: Scouts Cuboree now sits on 30 Sep.', 'update_family_event'))
    const r = await runAgent(input)
    expect(r.text).toBe('Replaced: Scouts Cuboree now sits on 30 Sep.')
    expect(generateText).toHaveBeenCalledTimes(3)
  })

  it('says plainly that nothing changed when the model insists', async () => {
    generateText
      .mockResolvedValueOnce(reply('Replaced it.'))
      .mockResolvedValueOnce(judged('claims_change'))
      .mockResolvedValueOnce(reply('Yes, replaced.'))
      .mockResolvedValueOnce(judged('claims_change'))
    const r = await runAgent(input)
    expect(r.text).toBe('Yes, replaced.\n\nI did not change anything this turn. If that is not what you expected, tell me exactly what to change.')
  })

  it('trusts a report backed by a write tool call, without asking', async () => {
    generateText.mockResolvedValueOnce(wrote('Replaced it.', 'update_family_event'))
    expect((await runAgent(input)).text).toBe('Replaced it.')
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('leaves an ordinary answer alone once judged, and fails open when the judgement errors', async () => {
    generateText.mockResolvedValueOnce(reply('Bins go out Monday.')).mockResolvedValueOnce(judged('no_change_claimed'))
    expect((await runAgent(input)).text).toBe('Bins go out Monday.')
    expect(generateText).toHaveBeenCalledTimes(2)

    generateText.mockReset()
    generateText.mockResolvedValueOnce(reply('Replaced it.')).mockRejectedValueOnce(new Error('429 quota'))
    expect((await runAgent(input)).text).toBe('Replaced it.')
  })

  it('judges chat turns only, never a watcher or the sweep', async () => {
    generateText.mockResolvedValue(reply('Replaced it.'))
    await runAgent({ ...input, mode: 'watcher', history: false })
    expect(generateText).toHaveBeenCalledTimes(1)
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

  it('tells a watcher to follow a standing instruction among the Known facts, and shows it those facts', () => {
    const p = systemPrompt({ ...base, mode: 'watcher', chatType: 'group', context: 'Known household facts:\n- [7] leave the gym newsletter out of the brief' })
    expect(p).toContain('HOUSE RULES: a Known household fact under Context can be a standing instruction')
    expect(p).toContain('do not say that you did')
    expect(p).toContain('Context:\nKnown household facts:\n- [7] leave the gym newsletter out of the brief')
  })

  it('gives the sweep only the memory rules', () => {
    const p = systemPrompt({ ...base, mode: 'sweep', chatType: 'private' })
    expect(p).toContain('nightly memory pass')
    expect(p).toContain('replaces set to the old id')
    expect(p).not.toContain('send_email')
  })

  it('has the sweep ask rather than guess, and never file from its own posts', () => {
    const p = systemPrompt({ ...base, mode: 'sweep', chatType: 'private' })
    expect(p).toContain('call unsure')
    expect(p).toContain('never file anything from them')
    expect(p).toContain("that turns up in a parent's mail is a child's")
    expect(p).toContain('one-off events and everything about them')
    expect(p).toContain('never with a "Source:" note')
  })

  it('tells a chat turn to settle an answered question', () => {
    expect(systemPrompt({ ...base, chatType: 'group' })).toContain('settle it with answer_question')
  })
})

describe('tool scoping by mode', () => {
  const input = { chatId: '-100', chatType: 'group', member: null, memberName: 'the family', text: 'go', history: false }

  it('routes a chat turn: core tools plus the groups its wording calls for', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'chat', text: 'how much did we spend this month?' })
    const call = generateText.mock.calls[0][0]
    expect(call.activeTools).toBeUndefined()
    const first: string[] = call.prepareStep({ steps: [], stepNumber: 0, model: {}, messages: [] }).activeTools
    expect(first).toContain('spending_summary')
    expect(first).toContain('web_search')
    expect(first).toContain('more_tools')
    expect(first).not.toContain('list_email')
    expect(first).not.toContain('jira_search')
  })

  it('widens a chat turn when the model asks for more tools', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'chat', text: 'what did the school say about athletics carnival?' })
    const prepare = generateText.mock.calls[0][0].prepareStep
    const before: string[] = prepare({ steps: [], stepNumber: 0, model: {}, messages: [] }).activeTools
    expect(before).not.toContain('list_email')
    const after: string[] = prepare({
      steps: [{ toolCalls: [{ toolName: 'more_tools', input: { group: 'mail' } }] }],
      stepNumber: 1, model: {}, messages: [],
    }).activeTools
    expect(after).toContain('list_email')
    expect(after).toContain('read_email')
  })

  it('opens the mail tools when a draft is waiting, whatever the wording', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true })
    await q.createDraft({ chatId: '-100', memberId: m.id, provider: 'google', to: ['x@y.com'], subject: 'Hi', body: 'b' })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'chat', member: m, text: 'yes send it' })
    const first: string[] = generateText.mock.calls[0][0].prepareStep({ steps: [], stepNumber: 0, model: {}, messages: [] }).activeTools
    expect(first).toContain('send_email')
  })

  it('does not route watchers or the sweep', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'watcher', text: 'how much did we spend?' })
    expect(generateText.mock.calls[0][0].prepareStep).toBeUndefined()
  })

  it('gives the sweep only the memory tools', async () => {
    generateText.mockResolvedValue(reply('SKIP'))
    await runAgent({ ...input, mode: 'sweep' })
    expect(generateText.mock.calls[0][0].activeTools).toEqual(['remember', 'forget', 'recall', 'unsure'])
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

  it('names every call for the tracer, by mode', async () => {
    const named = () => generateText.mock.calls.map((c) => (c[0] as { telemetry: { functionId: string } }).telemetry.functionId)
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'chat' })
    // A chat turn with no write behind it is judged for an unmade change, in a named call of its own.
    expect(named()).toEqual(['hearth.chat', 'hearth.claim'])
    expect(generateText.mock.calls[0][0].telemetry).toMatchObject({ functionId: 'hearth.chat', recordInputs: true })
    await runAgent({ ...input, mode: 'watcher' })
    expect(named().at(-1)).toBe('hearth.watcher')
    generateText.mockResolvedValue({ ...reply(''), output: 'stay_silent' })
    await shouldChimeIn({ chatId: '-100', text: 'hi', memberName: 'Ada' })
    expect(named().at(-1)).toBe('hearth.gate')
    generateText.mockResolvedValue({ ...reply(''), output: { decision: 'skip', confidence: 1 } })
    await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(named().at(-1)).toBe('hearth.decision')
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

  it('gives a watcher the household facts but none of a chat turn\'s other business, and the sweep all of the facts', async () => {
    await q.addMemory('bin night is Monday')
    await q.upsertMember('111', 'Rowan', { allowed: true })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'watcher' })
    const watcher = String(generateText.mock.calls[0][0].system)
    expect(watcher).toContain('Known household facts:')
    expect(watcher).toContain('bin night is Monday')
    expect(watcher).not.toContain('Family members')
    await runAgent({ ...input, mode: 'sweep' })
    expect(String(generateText.mock.calls[1][0].system)).toContain('bin night is Monday')
    await runAgent({ ...input, mode: 'chat' })
    expect(String(generateText.mock.calls[2][0].system)).toContain('Family members and their linked accounts: Rowan')
  })

  it('lists the open questions for a chat turn with their ids, and for the sweep so it does not ask twice', async () => {
    await q.askQuestion({ question: 'Who attends Hillside Grammar?', candidate: 'Juno attends Hillside Grammar' })
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, mode: 'chat' })
    const chat = String(generateText.mock.calls[0][0].system)
    expect(chat).toContain('question_id')
    expect(chat).toContain('Who attends Hillside Grammar?')
    expect(chat).toContain('would keep: "Juno attends Hillside Grammar"')
    await runAgent({ ...input, mode: 'sweep' })
    const sweep = String(generateText.mock.calls.at(-1)![0].system)
    expect(sweep).toContain('do not ask again')
    expect(sweep).toContain('Who attends Hillside Grammar?')
  })

  it('returns what the tools said as evidence for a watcher run', async () => {
    generateText.mockResolvedValue({
      ...reply('2Up: **$389.60** FARESAVER LISBON.'),
      steps: [{ toolResults: [{ toolName: 'new_transactions', input: { account: '2up' }, output: { count: 1 } }] }],
    })
    const r = await runAgent({ ...input, mode: 'watcher' })
    expect(r.evidence).toContain('new_transactions')
    expect(r.evidence).toContain('"count":1')
    generateText.mockResolvedValue(reply('hello'))
    expect((await runAgent({ ...input, mode: 'chat' })).evidence).toBeUndefined()
  })

  it('hands back the facts a watcher wrote with, so the post checks see the same sources', async () => {
    await q.addMemory('bin night is Monday')
    generateText.mockResolvedValue(reply('Bins out tonight.'))
    const r = await runAgent({ ...input, mode: 'watcher' })
    expect(r.facts).toContain('bin night is Monday')
    expect((await runAgent({ ...input, mode: 'chat' })).facts).toBeUndefined()
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
    const r = await runAgent({ chatId: '-100', chatType: 'private', member: null, memberName: 'Rowan', text: 'hi' })
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

  it('judges grounding only, and leaves what to include to the writer', async () => {
    generateText.mockResolvedValue({ ...reply(''), output: { decision: 'post', confidence: 0.9 } })
    await decideWatcherPost({ label: 'Morning brief', draft: 'd', evidence: 'e' })
    const system = String(generateText.mock.calls[0][0].system)
    expect(system).toContain("What to include was the writer's call")
    expect(system).toContain('not a reason to skip while the evidence contains it')
    expect(system).toContain('-1 if the post states anything the evidence does not contain')
    expect(system).not.toMatch(/would not need|useful to the household/)
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

  it('asks first the model that has been returning objects, whatever the chain order', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    await keepsAnsweringInProse('gemini:gemini-3.5-flash-lite')
    generateText.mockResolvedValue({ ...reply(''), output: { decision: 'post', confidence: 0.9 } })
    const d = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(d.model).toContain('openrouter')
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('tells a plain error apart from a structured-output failure', () => {
    expect(isStructuredOutputError(new Error('boom'))).toBe(false)
  })
})

describe('reviewDraft', () => {
  const out = (o: unknown) => ({ ...reply(''), output: o })

  it('passes a draft whose every claim the evidence supports', async () => {
    generateText
      .mockResolvedValueOnce(out({ claims: ['$389.60 to FARESAVER LISBON', 'on Tue 26 Aug'] }))
      .mockResolvedValueOnce(out({ supported: true, excerpt: '$389.60' }))
      .mockResolvedValueOnce(out({ supported: true, excerpt: 'Tue 26 Aug' }))
    const r = await reviewDraft({ label: 'x', draft: '2Up: $389.60 FARESAVER LISBON, Tue 26 Aug. Purpose not recorded.', evidence: 'DATA ...' })
    expect(r.unsupported).toEqual([])
    expect(r.message).toBe('2Up: $389.60 FARESAVER LISBON, Tue 26 Aug. Purpose not recorded.')
    expect(generateText).toHaveBeenCalledTimes(3)
    // The checker never sees the draft, only the evidence and one statement.
    const check = String(generateText.mock.calls[1][0].prompt)
    expect(check).toContain('EVIDENCE:')
    expect(check).not.toContain('Purpose not recorded')
  })

  it('cuts the claims that fail and keeps the rest', async () => {
    generateText
      .mockResolvedValueOnce(out({ claims: ['$389.60 to FARESAVER', 'a trip to Lisbon was booked'] }))
      .mockResolvedValueOnce(out({ supported: true }))
      .mockResolvedValueOnce(out({ supported: false }))
      .mockResolvedValueOnce(out({ message: '2Up: $389.60 FARESAVER LISBON.' }))
    const r = await reviewDraft({ label: 'x', draft: '2Up: $389.60 FARESAVER LISBON. Looks like a trip to Lisbon!', evidence: 'DATA ...' })
    expect(r.unsupported).toEqual(['a trip to Lisbon was booked'])
    expect(r.message).toBe('2Up: $389.60 FARESAVER LISBON.')
    // The rewrite edits the draft itself rather than rebuilding it from the list,
    // so whatever the capped list left out survives.
    const rewrite = String(generateText.mock.calls[3][0].prompt)
    expect(rewrite).toContain('POST:\n2Up: $389.60 FARESAVER LISBON. Looks like a trip to Lisbon!')
    expect(rewrite).toContain('NOT SUPPORTED, remove wherever they appear:\n- a trip to Lisbon was booked')
    expect(rewrite).toContain('SUPPORTED, keep as written:\n- $389.60 to FARESAVER')
  })

  it('still edits when every listed claim fails, and is silent only when nothing is left', async () => {
    generateText
      .mockResolvedValueOnce(out({ claims: ['a trip to Lisbon was booked'] }))
      .mockResolvedValueOnce(out({ supported: false }))
      .mockResolvedValueOnce(out({ message: '' }))
    const r = await reviewDraft({ label: 'x', draft: 'Looks like a trip to Lisbon!', evidence: 'DATA ...' })
    expect(r.message).toBeNull()
    expect(generateText).toHaveBeenCalledTimes(3)
  })

  it('asks for at most six claims, checks no more than that, and keeps the draft when they hold', async () => {
    generateText.mockResolvedValueOnce(out({ claims: Array.from({ length: 8 }, (_, i) => `claim ${i}`) }))
    for (let i = 0; i < 6; i++) generateText.mockResolvedValueOnce(out({ supported: true }))
    const r = await reviewDraft({ label: 'x', draft: 'A long post.', evidence: 'DATA ...' })
    expect(String(generateText.mock.calls[0][0].prompt)).toContain('at most 6 statements')
    expect(generateText).toHaveBeenCalledTimes(7)
    expect(r.claims).toHaveLength(6)
    expect(r.message).toBe('A long post.')
  })

  it('runs the checks first on the model that has been returning objects, whatever the chain order', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    await keepsAnsweringInProse('gemini:gemini-3.5-flash-lite')
    generateText.mockResolvedValueOnce(out({ claims: [] }))
    await reviewDraft({ label: 'x', draft: 'Nothing new.', evidence: '' })
    expect(String((generateText.mock.calls[0][0].model as { provider: string }).provider)).toContain('openrouter')
  })

  it('leaves a draft with nothing checkable alone', async () => {
    generateText.mockResolvedValueOnce(out({ claims: [] }))
    const r = await reviewDraft({ label: 'x', draft: 'Nothing new worth flagging.', evidence: '' })
    expect(r.message).toBe('Nothing new worth flagging.')
    expect(generateText).toHaveBeenCalledTimes(1)
  })
})

describe('watcher formatting', () => {
  const base = { memberName: 'Rowan', now: new Date('2026-08-27T00:00:00Z'), context: '' }

  it('offers Telegram markdown and a fold-away quote, and never asks for plain text', () => {
    const p = systemPrompt({ ...base, mode: 'watcher', chatType: 'group' })
    expect(p).toContain('**bold**')
    expect(p).toContain('> at the start of each line')
    expect(p).toContain('pipe table for figures')
    expect(p).toContain('**bold** title line')
    expect(p).not.toMatch(/plain Telegram text/)
  })
})

/*
 * With a TypeSafe key the typed judgements go to Jev: one call, a probability
 * back, the line drawn in lib/jev.ts. The chain keeps writing, and is asked a
 * judgement only when Jev cannot answer it.
 */
describe('with a TypeSafe key', () => {
  const input = { chatId: '-100', chatType: 'group', member: null, memberName: 'Ada', text: 'replace the dentist with Thursday 2pm' }
  const jev = (answers: Record<string, unknown>) => ({ model: 'jev-1.13.0', answers, usage: { input_tokens: 80, output_tokens: 0 } })
  const noul = (p: number) => ({ type: 'noul', noul: p })
  const pick = (supported: number) => ({ type: 'choice', choice: supported >= 0.5 ? 'supported' : 'not_in_evidence', confidence: 0.9, probabilities: { supported, contradicted: 0, not_in_evidence: 1 - supported } })

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = 'ts-test'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('gates on Jev alone, with the conversation as transcript lines and the bot\'s own lines marked', async () => {
    await q.recordMessage({ chatId: '-100', authorName: 'Sam', role: 'user', content: 'that movie was so bad' })
    await q.recordMessage({ chatId: '-100', role: 'assistant', content: 'Noted.' })
    systemOne.mockResolvedValue(jev({ forAssistant: noul(0.91) }))
    expect(await shouldChimeIn({ chatId: '-100', text: 'anyone know the wifi password?', memberName: 'Ada' })).toBe(true)
    expect(generateText).not.toHaveBeenCalled()
    expect(systemOne).toHaveBeenCalledTimes(1)
    expect(systemOne.mock.calls[0][0].state).toEqual({
      conversation: ['Sam: that movie was so bad', 'Hearth: Noted.'],
      message: 'Ada: anyone know the wifi password?',
    })
  })

  it('stays quiet on a low probability, and fails closed when Jev is down', async () => {
    systemOne.mockResolvedValue(jev({ forAssistant: noul(0.2) }))
    expect(await shouldChimeIn({ chatId: '-100', text: 'lol same', memberName: 'Ada' })).toBe(false)
    systemOne.mockRejectedValue(new Error('fetch failed'))
    expect(await shouldChimeIn({ chatId: '-100', text: 'lol same', memberName: 'Ada' })).toBe(false)
    expect(generateText).not.toHaveBeenCalled()
  })

  it('has Jev judge whether a chat reply reports a change no tool made, and sends the reply back on a yes', async () => {
    generateText.mockResolvedValue(reply('Done, replaced it.'))
    systemOne.mockResolvedValueOnce(jev({ claimsChange: noul(0.95) })).mockResolvedValueOnce(jev({ claimsChange: noul(0.05) }))
    const r = await runAgent(input)
    expect(r.text).toBe('Done, replaced it.')
    expect(generateText).toHaveBeenCalledTimes(2)
    expect(String(generateText.mock.calls[1][0].messages.at(-1).content)).toContain('Nothing has changed')
    expect(systemOne.mock.calls[0][0].state).toEqual({ reply: 'Done, replaced it.' })
    // The judgement itself never goes to the chain.
    expect(generateText.mock.calls.every((c) => c[0].output === undefined)).toBe(true)
  })

  it('lets the reply stand when Jev cannot judge it', async () => {
    generateText.mockResolvedValue(reply('Done, replaced it.'))
    systemOne.mockRejectedValue(new Error('fetch failed'))
    expect((await runAgent(input)).text).toBe('Done, replaced it.')
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('checks every claim in one Jev call against the evidence, then edits with the chain', async () => {
    generateText
      .mockResolvedValueOnce({ ...reply(''), output: { claims: ['$389.60 to FARESAVER', 'a trip to Lisbon was booked'] } })
      .mockResolvedValueOnce({ ...reply(''), output: { message: '2Up: $389.60 FARESAVER LISBON.' } })
    systemOne.mockResolvedValue(jev({ c0: pick(0.94), c1: pick(0.08) }))
    const r = await reviewDraft({ label: 'x', draft: '2Up: $389.60 FARESAVER LISBON. Looks like a trip to Lisbon!', evidence: 'DATA ...' })
    expect(r.unsupported).toEqual(['a trip to Lisbon was booked'])
    expect(r.message).toBe('2Up: $389.60 FARESAVER LISBON.')
    expect(systemOne).toHaveBeenCalledTimes(1)
    expect(systemOne.mock.calls[0][0].state).toEqual({ evidence: 'DATA ...' })
    expect(Object.keys(systemOne.mock.calls[0][0].questions)).toEqual(['c0', 'c1'])
    // Extract and rewrite are writing jobs and stay with the chain: two calls, neither a check.
    expect(generateText).toHaveBeenCalledTimes(2)
    expect(generateText.mock.calls.map((c) => c[0].output.name ?? '')).not.toContain('check')
  })

  it('asks the chain to check the claims when Jev cannot', async () => {
    generateText
      .mockResolvedValueOnce({ ...reply(''), output: { claims: ['$389.60 to FARESAVER'] } })
      .mockResolvedValueOnce({ ...reply(''), output: { supported: true } })
    systemOne.mockRejectedValue(new Error('529 overloaded'))
    const r = await reviewDraft({ label: 'x', draft: '2Up: $389.60 FARESAVER LISBON.', evidence: 'DATA ...' })
    expect(r.message).toBe('2Up: $389.60 FARESAVER LISBON.')
    expect(generateText).toHaveBeenCalledTimes(2)
    expect(String(generateText.mock.calls[1][0].prompt)).toContain('STATEMENT TO CHECK:\n$389.60 to FARESAVER')
  })

  it('decides post or skip with Jev, and never asks the chain while Jev answers', async () => {
    systemOne.mockResolvedValue(jev({ invented: noul(0.06), nothingNew: noul(0.03) }))
    const d = await decideWatcherPost({ label: '2Up transactions', draft: 'draft', evidence: 'evidence' })
    expect(d).toEqual({ decision: 'post', confidence: 0.94, model: 'jev:jev-latest' })
    expect(generateText).not.toHaveBeenCalled()
    expect(systemOne.mock.calls[0][0].state).toEqual({ draft: 'draft', evidence: 'evidence' })
  })

  it('falls back to the chain for the decision when Jev is down', async () => {
    systemOne.mockRejectedValue(new Error('fetch failed'))
    generateText.mockResolvedValue({ ...reply(''), output: { decision: 'skip', confidence: 0.8 } })
    const d = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(d).toMatchObject({ decision: 'skip', confidence: 0.8, model: 'gemini:gemini-3.5-flash-lite' })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Jev could not decide'), 'fetch failed')
  })

  it('records its calls beside the chain, under the Jev slot', async () => {
    systemOne.mockResolvedValue(jev({ forAssistant: noul(0.1) }))
    await shouldChimeIn({ chatId: '-100', text: 'hi', memberName: 'Ada' })
    const { chainHealth } = await import('@/lib/model-events')
    const health = await chainHealth(1)
    expect(health.slots.map((s) => s.slot)).toContain('jev:jev-latest')
  })
})
