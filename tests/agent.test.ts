import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { recordModelEvent } from '@/lib/model-events'

const generateText = vi.hoisted(() => vi.fn())
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText }))

// What each model call is traced under, which is what Langfuse groups it by.
const traced = vi.hoisted(() => vi.fn(async (_attrs: unknown, fn: () => Promise<unknown>) => fn()))
vi.mock('@/lib/telemetry', async (orig) => ({ ...(await orig<typeof import('@/lib/telemetry')>()), traced }))

const {
  runAgent, knownFacts, systemPrompt, stripPreamble, stripWorking, stripReasoning, cleanReply, collectEvidence,
  decideWatcherPost, reviewDraft, cutFromDraft, dropEmptiedHeadings, isStructuredOutputError, TURN_BUDGET_MS, CHAIN_POST_CONFIDENCE,
  scheduledInstruction,
} = await import('@/lib/agent')
const { CUSTOM_AUTOMATION_TOOLS } = await import('@/lib/tools')
const { generateText: sdkGenerateText } = await vi.importActual<typeof import('ai')>('ai')
const { MockLanguageModelV4 } = await import('ai/test')

let client: PGlite

type Tools = Record<string, { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }>

const reply = (text: string) => ({ text, steps: [], usage: {} })

/**
 * The SDK's own generateText, on a model that answers `text` and stops for
 * `finish`: what a provider's answer really does to a typed call, where a
 * stub can only say what the test assumes.
 */
const modelSays = (text: string, finish: 'stop' | 'length' = 'stop') => (opts: Parameters<typeof sdkGenerateText>[0]) =>
  sdkGenerateText({
    ...opts,
    model: new MockLanguageModelV4({
      doGenerate: async () => ({
        content: text ? [{ type: 'text', text }] : [],
        finishReason: { unified: finish, raw: finish },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }) as never,
    }),
  } as never)

/** Five structured calls answered with prose: enough for the chain to stop asking that slot first. */
async function keepsAnsweringInProse(slot: string) {
  for (let i = 0; i < 5; i++) {
    await recordModelEvent({ slot, purpose: 'hearth.verify', outcome: 'failed', error: 'No object generated: could not parse the response.' })
  }
}

const rowan = () => q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.GEMINI_API_KEY = 'k'
  process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite'
  // The fallback cases fail Gemini first and hand on to OpenRouter.
  process.env.LLM_ORDER = 'gemini,openrouter'
  delete process.env.LLM_BASE_URL
  delete process.env.OPENROUTER_API_KEY
  delete process.env.OPENROUTER_MODEL
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('systemPrompt', () => {
  const base = { now: new Date('2026-08-27T00:00:00Z'), context: '' }
  afterEach(() => {
    delete process.env.ASSISTANT_NAME
    delete process.env.LANGUAGE
    delete process.env.UNITS
  })

  it('states the date and timezone so relative dates resolve', () => {
    const p = systemPrompt(base)
    expect(p).toContain('Australia/Melbourne')
    expect(p).toContain('2026-08-27')
  })

  it('says it is a scheduled job, whose writing is kept as a report for whoever set it up', () => {
    const p = systemPrompt(base)
    expect(p).toContain('This is a scheduled job, not a conversation.')
    expect(p).toContain('kept as a report for the family member who set it up')
    expect(p).not.toMatch(/telegram|chat|posted to/i)
  })

  it('gives the run grounding rules and examples, and a way to stay quiet or flag a fault', () => {
    const p = systemPrompt(base)
    expect(p).toContain('WRITE using only the tool results you fetch')
    expect(p).toContain('purpose not recorded')
    expect(p).toContain('reply with exactly SKIP')
    expect(p).toContain('PROBLEMS: if a tool fails, write PROBLEM:')
    expect(p).toContain('No source names a trip')
    expect(p).not.toContain('draft_email')
  })

  it('tells the run to follow a standing instruction among the Known facts, and shows it those facts', () => {
    const p = systemPrompt({ ...base, context: 'Known household facts:\n- [7] leave the gym newsletter out of the brief' })
    expect(p).toContain('HOUSE RULES: a Known household fact under Context can be a standing instruction')
    expect(p).toContain('do not say that you did')
    expect(p).toContain('Context:\nKnown household facts:\n- [7] leave the gym newsletter out of the brief')
    expect(systemPrompt(base)).not.toContain('Context:')
  })

  it('speaks the household language and units', () => {
    expect(systemPrompt(base)).toContain('Australian English with metric units')
    process.env.LANGUAGE = 'American English'
    process.env.UNITS = 'imperial'
    expect(systemPrompt(base)).toContain('American English with imperial units')
  })

  it('is Hearth, plainly, until the household names it, and keeps a name that would not pass', () => {
    expect(systemPrompt(base)).toContain('You are Hearth, the household assistant for one family.')
    process.env.ASSISTANT_NAME = 'Pip'
    expect(systemPrompt(base)).toContain('You are Pip, the household assistant for one family.')
    process.env.ASSISTANT_NAME = 'not! a name'
    expect(systemPrompt(base)).toContain('You are Hearth,')
  })

  it("puts a helper's name and role at the head, and has it leave the signing to its report", () => {
    const p = systemPrompt({ ...base, helper: { name: 'Chef', role: 'Plans meals.' } })
    expect(p.startsWith("You are Chef, one of Hearth's helpers for one family. Your report carries your name, so never sign it yourself.\nROLE: Plans meals.")).toBe(true)
  })

  it('names no particular merchant, place, school or event: the shapes are taught with placeholders', () => {
    // The fixtures' own stand-ins: a prompt teaches a shape with <placeholders>, never with an example the evals then recognise.
    const p = systemPrompt(base)
    expect(p).not.toMatch(/faresaver|lisbon|freshmart|hillside|riverbend|athletics carnival|school|tradies/i)
    expect(p).toContain('<PAYEE AS SHOWN>')
  })

  it('keeps tables out of a report, and asks for bold title and heading lines when it comes in parts', () => {
    const p = systemPrompt(base)
    expect(p).toContain('No tables')
    expect(p).toContain('**bold** title line')
    expect(p).not.toMatch(/pipe table|> at the start/)
  })

  it('stays under a few dozen rule lines, in plain lines rather than prose', () => {
    const p = systemPrompt(base)
    const ruleLines = p.split('\n').filter((l) => /^[A-Z][A-Z ,]+:/.test(l))
    expect(ruleLines.length).toBeGreaterThan(5)
    expect(ruleLines.length).toBeLessThan(25)
    expect(p).not.toMatch(/^- /m)
  })
})

describe('knownFacts', () => {
  it('is nothing at all when nothing is known', async () => {
    expect(await knownFacts()).toBe('')
  })

  it('lists what is known with each id, for a run to follow and the checks to judge by', async () => {
    const m = await q.addMemory('bin night is Monday')
    expect(await knownFacts()).toBe(`Known household facts:\n- [${m.id}] bin night is Monday`)
  })

  it('is nothing, not a throw, when the facts cannot be read', async () => {
    const { __setDb } = await import('@/lib/db')
    __setDb({ select: () => { throw new Error('db down') } })
    expect(await knownFacts()).toBe('')
  })
})

describe('stripPreamble', () => {
  it('cuts reasoning that hands over with "Now the report:"', () => {
    const text = [
      'Faresaver is a budget airline, and the FARESAVER LISBON line is the other half. Now the report:',
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
  const report = 'Weekly snapshot: in **$8,898.07**, out **$7,973.28**, net **+$924.79**.\n\nTop spend: Kids $5,273.24 (66% of spend).'

  it('cuts an opening paragraph of working with no handover line when a report follows it', () => {
    expect(stripWorking(working)).toBe(report)
  })

  it('cuts several such paragraphs in a row', () => {
    expect(stripWorking("Let me check the feed first.\n\nI'll fetch the budget too.\n\nBins out tonight.")).toBe('Bins out tonight.')
  })

  it('never eats a reply that is only working', () => {
    const text = 'I have what I need. No web lookup needed.'
    expect(stripWorking(text)).toBe(text)
  })

  it('stops after three paragraphs of working, so a long report is never eaten whole', () => {
    const text = 'Let me check.\n\nI checked the calendar.\n\nI have what I need.\n\nLet me say it.\n\nBins out tonight.'
    expect(stripWorking(text)).toBe('Let me say it.\n\nBins out tonight.')
  })

  it('leaves a report alone that never talks about itself', () => {
    expect(stripWorking(report)).toBe(report)
  })

  it('is applied only when asked for', () => {
    expect(cleanReply(working, { working: true })).toEqual({ text: report, stripped: true })
    expect(cleanReply(working).text.startsWith('I have what I need')).toBe(true)
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
})

describe('collectEvidence', () => {
  it('keeps what the tools returned whole while it fits, a full email and a full page included', () => {
    const email = `Athletics carnival Friday 9am. ${'Details. '.repeat(650)}Bring a hat and a water bottle.`
    const steps = [
      { toolResults: [{ toolName: 'read_email', input: { id: 'm1' }, output: { body: email } }] },
      { toolResults: [{ toolName: 'read_url', input: { url: 'https://x.test' }, output: { text: 'p'.repeat(9_000) } }] },
    ]
    const out = collectEvidence(steps)
    expect(out).toContain('Bring a hat and a water bottle.')
    expect(out).not.toContain('[cut short]')
  })

  it('over the total, cuts the longest results evenly and keeps every one, the short writes whole', () => {
    const big = 'x'.repeat(9_000)
    const steps = [
      ...Array.from({ length: 6 }, (_, i) => ({ toolResults: [{ toolName: 'read_email', input: { id: `m${i}` }, output: big }] })),
      { toolResults: [{ toolName: 'propose_family_event', input: { title: 'Carnival' }, output: { proposal_id: 7 } }] },
    ]
    const out = collectEvidence(steps)
    const lines = out.split('\n')
    expect(out.length).toBeLessThanOrEqual(40_000)
    expect(lines).toHaveLength(7)
    expect(lines.at(-1)).toBe('propose_family_event({"title":"Carnival"}) -> {"proposal_id":7}')
    const cut = lines.slice(0, 6).map((l) => l.length)
    expect(new Set(cut).size).toBe(1)
    expect(cut[0]).toBeGreaterThan(6_000)
    expect(lines[0]).toMatch(/…\[cut short\]$/)
  })

  it('passes over a step that called no tools', () => {
    const steps = [{}, { toolResults: [{ toolName: 'list_email', input: { limit: 1 }, output: [] }] }]
    expect(collectEvidence(steps)).toBe('list_email({"limit":1}) -> []')
  })
})

describe('runAgent', () => {
  const input = { member: null, memberName: 'Rowan', text: 'Remind everyone the bins go out tonight.' }

  it('returns the report and which model wrote it', async () => {
    generateText.mockResolvedValue(reply('Bins out tonight.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Bins out tonight.')
    expect(r.model).toBe('gemini:gemini-3.5-flash-lite')
  })

  it('hands the model the instruction alone, in the name of whoever set it up, with no conversation before it', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent(input)
    expect(generateText.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'Rowan: Remind everyone the bins go out tonight.' }])
    expect(String(generateText.mock.calls[0][0].system)).toContain('This is a scheduled job')
  })

  it('strips working that leaked into a report, and says so in the log', async () => {
    generateText.mockResolvedValue(reply('I have what I need. No web lookup needed.\n\nBins out tonight.'))
    expect((await runAgent(input)).text).toBe('Bins out tonight.')
    expect(console.warn).toHaveBeenCalledWith('[agent] gemini:gemini-3.5-flash-lite leaked its working into the report; stripped')
  })

  it('writes with the household facts in view, and hands them back so the checks judge against the same sources', async () => {
    await q.addMemory('bin night is Monday')
    generateText.mockResolvedValue(reply('Bins out tonight.'))
    const r = await runAgent(input)
    expect(String(generateText.mock.calls[0][0].system)).toContain('Known household facts:')
    expect(String(generateText.mock.calls[0][0].system)).toContain('bin night is Monday')
    expect(r.facts).toContain('bin night is Monday')
  })

  it('still runs when the database is down, just without the facts', async () => {
    const { __setDb } = await import('@/lib/db')
    __setDb({ select: () => { throw new Error('db down') } })
    generateText.mockResolvedValue(reply('Bins out tonight.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Bins out tonight.')
    expect(r.facts).toBe('')
  })

  it('reaches only for what a scheduled run may, read-only, unless told a narrower list', async () => {
    generateText.mockResolvedValue(reply('ok'))
    await runAgent(input)
    const active: string[] = generateText.mock.calls[0][0].activeTools
    expect(active).toEqual(CUSTOM_AUTOMATION_TOOLS)
    for (const write of ['send_email', 'add_family_event', 'remember', 'create_automation', 'accept_event_proposal']) expect(active).not.toContain(write)
    expect(active).toContain('propose_family_event')
    await runAgent({ ...input, tools: ['recall'] })
    expect(generateText.mock.calls[1][0].activeTools).toEqual(['recall'])
  })

  it('names each call for the tracer, cool and short, with its member as the user and its helper in the metadata', async () => {
    const member = await rowan()
    generateText.mockResolvedValue(reply('ok'))
    await runAgent({ ...input, member, helper: { id: 3, name: 'Chef', role: 'Plans meals.', createdBy: null, createdAt: new Date() } })
    const call = generateText.mock.calls[0][0]
    expect(call.telemetry).toMatchObject({ functionId: 'hearth.watcher', recordInputs: true })
    expect(call.temperature).toBe(0.3)
    expect(call.maxOutputTokens).toBe(4000)
    expect(String(call.system)).toContain('You are Chef')
    expect(traced).toHaveBeenCalledWith(
      { traceName: 'hearth.watcher', userId: String(member.id), tags: ['watcher'], metadata: { model: 'gemini:gemini-3.5-flash-lite', helper: 'Chef' } },
      expect.any(Function),
    )
    // With nobody behind it, there is no user to name.
    traced.mockClear()
    await runAgent(input)
    expect(traced).toHaveBeenCalledWith({ traceName: 'hearth.watcher', tags: ['watcher'], metadata: { model: 'gemini:gemini-3.5-flash-lite' } }, expect.any(Function))
  })

  it('passes the configured reasoning level to the model, and none when it is unset', async () => {
    generateText.mockResolvedValue(reply('ok'))
    process.env.LLM_REASONING = 'Low'
    try {
      await runAgent(input)
    } finally {
      delete process.env.LLM_REASONING
    }
    await runAgent(input)
    expect(generateText.mock.calls[0][0].reasoning).toBe('low')
    expect(generateText.mock.calls[1][0]).not.toHaveProperty('reasoning')
  })

  it("files what its tools change on its member's record, as done on a schedule", async () => {
    const member = await rowan()
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.add_to_list.execute({ items: ['bin bags'], list: 'shopping' }, {})
      return reply('Added bin bags to the shopping list.')
    })
    const r = await runAgent({ ...input, member })
    expect(r.wrote).toEqual(['add_to_list'])
    const [a] = await q.recentActivity({ memberId: member.id })
    expect(a).toMatchObject({ via: 'watcher', tool: 'add_to_list', summary: 'added bin bags to the shopping list' })
  })

  it('returns what the tools said as evidence, and empty evidence when there were no steps at all', async () => {
    generateText.mockResolvedValue({
      ...reply('2Up: **$389.60** FARESAVER LISBON.'),
      steps: [{ toolResults: [{ toolName: 'list_transactions', input: { search: 'faresaver' }, output: { count: 1 } }] }],
    })
    const r = await runAgent(input)
    expect(r.evidence).toContain('list_transactions')
    expect(r.evidence).toContain('"count":1')
    generateText.mockResolvedValue({ text: 'Bins out tonight.' })
    expect((await runAgent(input)).evidence).toBe('')
  })

  it('falls through to the next model when the first fails', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    process.env.OPENROUTER_MODEL = 'minimax/minimax-m3:free'
    generateText.mockRejectedValueOnce(new Error('429 quota')).mockResolvedValueOnce(reply('Second here.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Second here.')
    expect(r.model).toContain('openrouter')
  })

  it('gives the last model in the chain room to think: it has nothing to fall back on', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    process.env.OPENROUTER_MODEL = 'openrouter/auto'
    generateText.mockRejectedValueOnce(new Error('503 Service Unavailable')).mockResolvedValueOnce(reply('SKIP'))
    await runAgent(input)
    expect(generateText.mock.calls.map((c) => c[0].maxOutputTokens)).toEqual([800, 4000])

    // Twice the run's own allowance where that is more.
    generateText.mockReset()
    generateText.mockRejectedValueOnce(new Error('503 Service Unavailable')).mockResolvedValueOnce(reply('**Today**\n- Swim at 9'))
    await runAgent({ ...input, maxOutputTokens: 2400 })
    expect(generateText.mock.calls.map((c) => c[0].maxOutputTokens)).toEqual([2400, 4800])
  })

  it('gives every call only what is left of the run, and tries no model once it is spent', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText.mockResolvedValueOnce(reply('Bins go out Monday.'))
    await runAgent(input)
    const { totalMs, stepMs } = generateText.mock.calls[0][0].timeout
    expect(totalMs).toBeGreaterThan(TURN_BUDGET_MS - 10_000)
    expect(totalMs).toBeLessThanOrEqual(TURN_BUDGET_MS)
    expect(stepMs).toBe(60_000)

    // The first model runs out the clock; the second is never started, and the run says why.
    generateText.mockReset()
    const deadline = Date.now() + 500
    generateText.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, deadline - Date.now() + 10))
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    await expect(runAgent({ ...input, deadline })).rejects.toThrow('aborted due to timeout')
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it("ends at the caller's deadline when that is nearer, and never runs past its own budget", async () => {
    generateText.mockResolvedValue(reply('Bins go out Monday.'))
    await runAgent({ ...input, deadline: Date.now() + 40_000 })
    expect(generateText.mock.calls[0][0].timeout.totalMs).toBeGreaterThan(30_000)
    expect(generateText.mock.calls[0][0].timeout.totalMs).toBeLessThanOrEqual(40_000)
    // A caller whose clock leaves more than a run needs still gets only the run.
    await runAgent({ ...input, deadline: Date.now() + 600_000 })
    expect(generateText.mock.calls[1][0].timeout.totalMs).toBeLessThanOrEqual(TURN_BUDGET_MS)
  })

  it('reports nothing but the problem when a model fails after changing something, and hands the run to no other', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    process.env.OPENROUTER_MODEL = 'minimax/minimax-m3:free'
    const member = await rowan()
    // The first slot adds to the list and then hits its rate limit mid-run.
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.add_to_list.execute({ items: ['milk', 'eggs'], list: 'shopping' }, {})
      throw new Error('429 quota')
    })
    const r = await runAgent({ ...input, member })
    // No second slot, so nothing is added twice.
    expect(generateText).toHaveBeenCalledTimes(1)
    expect(r.text).toBe('PROBLEM: gemini:gemini-3.5-flash-lite failed (429 quota) after it had added to a list, so this run reported nothing.\nSKIP')
    expect(r.wrote).toEqual(['add_to_list'])
    expect(r.evidence).toBeUndefined()
    const list = await q.findOrCreateList('shopping')
    expect((await q.listContents(list.id)).map((i) => i.content)).toEqual(['milk', 'eggs'])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('failed after changing something'), expect.stringContaining('429'))
    // The System page sees the slot fail, not answer.
    const { chainHealth } = await import('@/lib/model-events')
    const gemini = (await chainHealth(1)).slots.find((x) => x.slot.startsWith('gemini:'))
    expect(gemini).toMatchObject({ answered: 0, failed: 1 })
  })

  it('ends the same way when the model changed something and then said nothing', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.add_to_list.execute({ items: ['batteries'], list: 'hardware' }, {})
      return reply('')
    })
    const r = await runAgent(input)
    expect(generateText).toHaveBeenCalledTimes(1)
    expect(r.text).toMatch(/^PROBLEM: gemini:gemini-3\.5-flash-lite failed \(gemini:gemini-3\.5-flash-lite returned no text\) after it had added to a list/)
  })

  it('still ends a run the clock stopped after a write by reporting the problem', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    const deadline = Date.now() + 500
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.add_to_list.execute({ items: ['milk'], list: 'shopping' }, {})
      await new Promise((resolve) => setTimeout(resolve, deadline - Date.now() + 10))
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    const r = await runAgent({ ...input, deadline })
    expect(generateText).toHaveBeenCalledTimes(1)
    expect(r.text).toMatch(/^PROBLEM: .*after it had added to a list, so this run reported nothing\.\nSKIP$/)
  })

  describe('after a write that ran out of time', () => {
    beforeEach(() => {
      process.env.OPENROUTER_API_KEY = 'sk-or'
      Object.assign(process.env, { JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'r@hearth.example', JIRA_API_TOKEN: 'token' })
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }))
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      for (const k of ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) delete process.env[k]
    })

    it('ends the run rather than have the next model do it again, and does not say it was done', async () => {
      generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
        expect(await opts.tools.jira_comment.execute({ key: 'HTL-1', text: 'Paid' }, {})).toMatchObject({ maybe_done: true })
        throw new Error('429 quota')
      })
      const r = await runAgent(input)
      expect(generateText).toHaveBeenCalledTimes(1)
      expect(r.text).toMatch(/after it had changed something, so this run reported nothing/)
      expect(r.unconfirmed).toEqual(['jira_comment'])
    })

    it('says what was done besides, and nothing of the write that may not have been', async () => {
      generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
        await opts.tools.add_to_list.execute({ items: ['stamps'], list: 'shopping' }, {})
        await opts.tools.jira_comment.execute({ key: 'HTL-1', text: 'Paid' }, {})
        throw new Error('429 quota')
      })
      const r = await runAgent(input)
      expect(generateText).toHaveBeenCalledTimes(1)
      expect(r.text).toMatch(/after it had added to a list, so this run reported nothing/)
      expect(r.text).not.toContain('commented')
    })
  })

  it('still hands the run on when nothing was changed, a refused write included', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        // A schedule that never fires is refused with an error result.
        const refused = await opts.tools.create_automation.execute({ label: 'never', cron: '0 0 31 2 *', instruction: 'x' }, {})
        expect(refused).toHaveProperty('error')
        await opts.tools.recall.execute({}, {})
        throw new Error('429 quota')
      })
      .mockResolvedValueOnce(reply('Second here.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Second here.')
    expect(r.model).toContain('openrouter')
    expect(await q.listAutomations()).toHaveLength(0)
  })

  it('hands the run on after a write that checks for itself, so a proposal is made once however many models try', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    const member = await rowan()
    const propose = (opts: { tools: Tools }) =>
      opts.tools.propose_family_event.execute({ title: 'Athletics carnival', start: '2030-10-15T09:00', source: 'google:m1', description: 'From the school office.' }, {})
    generateText
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        await propose(opts)
        throw new Error('429 quota')
      })
      .mockImplementationOnce(async (opts: { tools: Tools }) => {
        // The second model proposes it again, which finds the first rather than adding to it.
        expect(await propose(opts)).toMatchObject({ already_proposed: true })
        return reply('Proposed the athletics carnival for the family calendar.')
      })
    const r = await runAgent({ ...input, member })
    expect(r.model).toContain('openrouter')
    expect((await q.pendingProposals()).map((p) => p.title)).toEqual(['Athletics carnival'])
  })

  it('never lets a report end mid-line, keeping the complete lines of a long one', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `- Item ${i}: something to attend to by Friday`)
    // Cut off by the cap in the middle of its last bullet.
    generateText.mockResolvedValueOnce({ ...reply(`**To do**\n${lines.join('\n')}\n- Item 40: somethi`), finishReason: 'length' })
    const r = await runAgent({ ...input, tools: ['recall'] })
    // The only model in the chain: nobody else could say it shorter.
    expect(r.text).toBe(`**To do**\n${lines.join('\n')}`)
    expect(r.cutShort).toBe(true)
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('gives a long report the cap cut off to the next model first, which may fit it', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    const lines = Array.from({ length: 40 }, (_, i) => `- Item ${i}: something to attend to by Friday`)
    generateText
      // A provider that reports no steps at all, as some do on a cut-off answer.
      .mockResolvedValueOnce({ text: `**To do**\n${lines.join('\n')}\n- Item 40: somethi`, finishReason: 'length' })
      .mockResolvedValueOnce(reply('**To do**\n- Forty things by Friday.'))
    const r = await runAgent({ ...input, tools: ['recall'] })
    expect(r.text).toBe('**To do**\n- Forty things by Friday.')
    expect(r.model).toContain('openrouter')
    expect(r.cutShort).toBeUndefined()
  })

  it("keeps the first model's cut-short report after all when no later model answers", async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    const lines = Array.from({ length: 40 }, (_, i) => `- Item ${i}: something to attend to by Friday`)
    generateText
      .mockResolvedValueOnce({ ...reply(`**To do**\n${lines.join('\n')}\n- Item 40: somethi`), finishReason: 'length' })
      .mockRejectedValueOnce(new Error('429 quota'))
    const r = await runAgent({ ...input, tools: ['recall'] })
    expect(r.text).toBe(`**To do**\n${lines.join('\n')}`)
    expect(r.model).toContain('gemini')
    expect(r.cutShort).toBe(true)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no later model answered (429 quota); keeping gemini:gemini-3.5-flash-lite's report, cut short"))
  })

  it('keeps the first long report the cap cut off, not a later one, when no model after them answers', async () => {
    process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite,gemini-3.5-flash'
    process.env.OPENROUTER_API_KEY = 'sk-or'
    const first = Array.from({ length: 40 }, (_, i) => `- Item ${i}: something to attend to by Friday`)
    const second = Array.from({ length: 40 }, (_, i) => `- Thing ${i}: something else to attend to by Friday`)
    generateText
      .mockResolvedValueOnce({ ...reply(`**To do**\n${first.join('\n')}\n- Item 40: somethi`), finishReason: 'length' })
      .mockResolvedValueOnce({ ...reply(`**To do**\n${second.join('\n')}\n- Thing 40: somethi`), finishReason: 'length' })
      .mockRejectedValueOnce(new Error('429 quota'))
    const r = await runAgent({ ...input, tools: ['recall'] })
    expect(generateText).toHaveBeenCalledTimes(3)
    expect(r.model).toBe('gemini:gemini-3.5-flash-lite')
    expect(r.text).toBe(`**To do**\n${first.join('\n')}`)
  })

  it('copes with a model that throws something other than an error', async () => {
    generateText.mockRejectedValueOnce('the provider hung up')
    await expect(runAgent(input)).rejects.toThrow('the provider hung up')
  })

  it('keeps no fragment in reserve: with no later answer, the run fails as it would have', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockResolvedValueOnce({ ...reply(`**To do**\n${'x'.repeat(300)}`), finishReason: 'length' })
      .mockRejectedValueOnce(new Error('429 quota'))
    await expect(runAgent({ ...input, tools: ['recall'] })).rejects.toThrow('429 quota')
  })

  it('trims on the first model when it already wrote something, since no other model gets the run', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    const lines = Array.from({ length: 40 }, (_, i) => `- Item ${i}: something to attend to by Friday`)
    generateText.mockImplementationOnce(async (opts: { tools: Tools }) => {
      await opts.tools.add_to_list.execute({ items: ['bin bags'], list: 'shopping' }, {})
      return { ...reply(`**To do**\n${lines.join('\n')}\n- Item 40: somethi`), finishReason: 'length' }
    })
    const r = await runAgent({ ...input, tools: ['add_to_list', 'recall'] })
    expect(generateText).toHaveBeenCalledTimes(1)
    expect(r.text).toContain('- Item 39:')
    expect(r.text).not.toContain('Item 40')
    expect(r.cutShort).toBe(true)
  })

  it('drops what is left of a report cut off early, when its complete lines are only a heading', async () => {
    // Long enough to be kept, but its only complete line is the heading.
    generateText.mockResolvedValueOnce({ ...reply(`**To do**\n${'x'.repeat(300)}`), finishReason: 'length' })
    await expect(runAgent({ ...input, tools: ['recall'] })).rejects.toThrow(/ran out of output tokens before answering/)
  })

  it("hands a single cut-off line to the next model, being a fragment, and so too a reply the cap cut short", async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockResolvedValueOnce({ ...reply('x'.repeat(400)), finishReason: 'length' })
      .mockResolvedValueOnce(reply('Bins out tonight.'))
    const r = await runAgent({ ...input, tools: ['recall'] })
    expect(r.text).toBe('Bins out tonight.')
    expect(r.model).toContain('openrouter')

    generateText.mockReset()
    generateText.mockResolvedValueOnce({ ...reply('Y'), finishReason: 'length' }).mockResolvedValueOnce(reply('Proper answer.'))
    const again = await runAgent(input)
    expect(again.text).toBe('Proper answer.')
    expect(console.warn).toHaveBeenCalledWith('[agent] gemini:gemini-3.5-flash-lite ran out of output tokens after 1 characters of reply; dropped')
  })

  it('treats an empty completion as a failure worth retrying', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText.mockResolvedValueOnce(reply('   ')).mockResolvedValueOnce(reply('Proper answer.'))
    expect((await runAgent(input)).text).toBe('Proper answer.')
  })

  it('strips thinking from a live reply, and moves on when that leaves nothing', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockResolvedValueOnce(reply('<think>never mind'))
      .mockResolvedValueOnce(reply('<think>ok</think>Bins out tonight.'))
    const r = await runAgent(input)
    expect(r.text).toBe('Bins out tonight.')
    expect(r.model).toContain('openrouter')
  })

  it('throws when nothing is configured at all', async () => {
    delete process.env.GEMINI_API_KEY
    await expect(runAgent(input)).rejects.toThrow(/No LLM configured/)
  })
})

describe('decideWatcherPost', () => {
  const answers = (o: object) => ({ ...reply(''), output: { invented: false, nothing_new: false, confidence: 0.9, ...o } })

  it('asks the chain the two questions with no tools, and keeps the draft when neither is a yes', async () => {
    generateText.mockResolvedValue(answers({}))
    const d = await decideWatcherPost({ label: 'bin night', draft: 'draft', evidence: 'evidence' })
    expect(d).toEqual({ decision: 'post', confidence: 0.9, model: 'gemini:gemini-3.5-flash-lite' })
    const call = generateText.mock.calls[0][0]
    expect(call.output).toBeDefined()
    expect(call.tools).toBeUndefined()
    expect(String(call.system)).toContain('invented: does the draft state anything')
    expect(String(call.system)).toContain('nothing_new: does the draft only say')
    expect(String(call.system)).toContain('a draft report from a scheduled family-assistant check')
    expect(String(call.prompt)).toBe('Job: bin night\n\nDRAFT:\ndraft\n\nEVIDENCE:\nevidence')
    expect(call.telemetry.functionId).toBe('hearth.decision')
  })

  it('tells the chain plainly when no tool returned anything to check against', async () => {
    generateText.mockResolvedValue(answers({}))
    await decideWatcherPost({ label: 'x', draft: 'd', evidence: '' })
    expect(String(generateText.mock.calls[0][0].prompt)).toContain('EVIDENCE:\n(no tool results)')
  })

  it('holds an invented statement back, quoting it, and a draft that only says there is nothing new', async () => {
    generateText.mockResolvedValueOnce(answers({ invented: true, not_in_evidence: 'a time the evidence does not give', confidence: 0.8 }))
    const invented = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(invented).toEqual({
      decision: 'skip', confidence: 0.8, model: 'gemini:gemini-3.5-flash-lite',
      reason: 'the draft states something the evidence does not contain: a time the evidence does not give',
      // Named apart from the reason, so the tick can cut it from a checked draft.
      notInEvidence: 'a time the evidence does not give',
    })
    generateText.mockResolvedValueOnce(answers({ invented: true, confidence: 0.8 }))
    const unquoted = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(unquoted).toEqual({ decision: 'skip', confidence: 0.8, model: 'gemini:gemini-3.5-flash-lite', reason: 'the draft states something the evidence does not contain' })
    generateText.mockResolvedValueOnce(answers({ nothing_new: true, confidence: 1 }))
    const quiet = await decideWatcherPost({ label: 'x', draft: 'Nothing new.', evidence: 'e' })
    expect(quiet).toMatchObject({ decision: 'skip', confidence: 1, reason: 'the draft only says there is nothing new' })
  })

  it('holds the draft when the chain is not sure enough of its answers, the grey zone being its own line', async () => {
    generateText.mockResolvedValueOnce(answers({ confidence: CHAIN_POST_CONFIDENCE - 0.1 }))
    const d = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(d).toMatchObject({ decision: 'skip', reason: 'the judge was not sure enough of its answers' })
    generateText.mockResolvedValueOnce(answers({ confidence: CHAIN_POST_CONFIDENCE }))
    expect((await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })).decision).toBe('post')
  })

  it("lets a claim check that has passed every statement carry the chain's doubt and its unsure invention", async () => {
    const checked = { label: 'x', draft: 'd', evidence: 'e', verified: true }
    generateText.mockResolvedValueOnce(answers({ invented: true, confidence: 0.6 }))
    expect((await decideWatcherPost(checked)).decision).toBe('post')
    generateText.mockResolvedValueOnce(answers({ confidence: 0.5 }))
    expect((await decideWatcherPost(checked)).decision).toBe('post')
    // What it is sure of still overrides the check, and nothing new always holds it.
    generateText.mockResolvedValueOnce(answers({ invented: true, confidence: 0.9 }))
    expect((await decideWatcherPost(checked)).decision).toBe('skip')
    generateText.mockResolvedValueOnce(answers({ nothing_new: true, confidence: 0.5 }))
    expect((await decideWatcherPost(checked)).decision).toBe('skip')
  })

  it('is never asked for a verdict, so the instruction cannot be enforced through it', async () => {
    generateText.mockResolvedValue(answers({}))
    await decideWatcherPost({ label: 'Morning summary', draft: 'd', evidence: 'e' })
    const system = String(generateText.mock.calls[0][0].system)
    expect(system).toContain('whether the writer obeyed it is not asked')
    expect(system).toContain("was the writer's call to make")
    expect(system).toContain('a collection or event whose time has passed')
    expect(system).not.toMatch(/would not need|useful to the household|choose skip|if you choose/)
    const shape = generateText.mock.calls[0][0].output
    expect(JSON.stringify(shape)).not.toContain('"post"')
  })

  it('moves to the next model when the first returns no object', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockRejectedValueOnce(new Error('No object generated'))
      .mockResolvedValueOnce(answers({ invented: true, confidence: 0.8 }))
    const d = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(d.decision).toBe('skip')
    expect(d.model).toContain('openrouter')
  })

  it('records a judge that answers in prose as one that returned no object, and asks the next', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText.mockImplementationOnce(modelSays('It looks grounded to me.')).mockResolvedValueOnce(answers({}))
    const d = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(d.model).toContain('openrouter')
    const { structuredRecord } = await import('@/lib/model-events')
    expect((await structuredRecord(1)).get('gemini:gemini-3.5-flash-lite')).toEqual({ attempts: 1, noObject: 1 })
  })

  it('asks first the model that has been returning objects, whatever the chain order', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    await keepsAnsweringInProse('gemini:gemini-3.5-flash-lite')
    generateText.mockResolvedValue(answers({}))
    const d = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(d.model).toContain('openrouter')
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it("is over by the caller's deadline, and asks no model once it has passed", async () => {
    generateText.mockResolvedValue(answers({}))
    await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e', deadline: Date.now() + 10_000 })
    const { totalMs, stepMs } = generateText.mock.calls[0][0].timeout
    expect(totalMs).toBeGreaterThan(9_000)
    expect(totalMs).toBeLessThanOrEqual(10_000)
    expect(stepMs).toBe(30_000)
    await expect(decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e', deadline: Date.now() - 1 })).rejects.toThrow('Timed out before any model was asked')
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('has no clock of its own without a deadline, only one for each step', async () => {
    generateText.mockResolvedValue(answers({}))
    await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' })
    expect(generateText.mock.calls[0][0].timeout).toEqual({ stepMs: 30_000 })
  })
})

describe('isStructuredOutputError', () => {
  it('tells a structured-output failure apart from a plain error', async () => {
    expect(isStructuredOutputError(new Error('boom'))).toBe(false)
    generateText.mockImplementationOnce(modelSays('Not an object.'))
    const err = await decideWatcherPost({ label: 'x', draft: 'd', evidence: 'e' }).catch((e: unknown) => e)
    expect(isStructuredOutputError(err)).toBe(true)
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
    expect(String(generateText.mock.calls[0][0].prompt)).toContain('REPORT:\n2Up: $389.60')
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
    expect(rewrite).toContain('REPORT:\n2Up: $389.60 FARESAVER LISBON. Looks like a trip to Lisbon!')
    expect(rewrite).toContain('NOT SUPPORTED, remove wherever they appear:\n- a trip to Lisbon was booked')
    expect(rewrite).toContain('SUPPORTED, keep as written:\n- $389.60 to FARESAVER')
  })

  it("keeps no heading over nothing once the rewrite has cut a part's only bullet", async () => {
    const draft = '**Today**\n- After School Care, 3:00 pm – 6:00 pm\n\n**Heads up**\n- A payslip arrived.'
    generateText
      .mockResolvedValueOnce(out({ claims: ['After School Care is on today', 'a payslip arrived'] }))
      .mockResolvedValueOnce(out({ supported: false }))
      .mockResolvedValueOnce(out({ supported: true }))
      .mockResolvedValueOnce(out({ message: '**Today**\n\n**Heads up**\n- A payslip arrived.' }))
    const r = await reviewDraft({ label: 'Morning summary', draft, evidence: 'DATA ...' })
    expect(r.unsupported).toEqual(['After School Care is on today'])
    expect(r.message).toBe('**Heads up**\n- A payslip arrived.')
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

  it('asks the next model when the rewrite comes back empty with statements still supported in the report', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockResolvedValueOnce(out({ claims: ['Swimming is at 9 on Friday', "Logan and Meg Treeby are Winter's parents"] }))
      .mockResolvedValueOnce(out({ supported: true }))
      .mockResolvedValueOnce(out({ supported: false }))
      .mockResolvedValueOnce(out({ message: '' }))
      .mockResolvedValueOnce(out({ message: 'Swimming is at 9 on Friday.' }))
    const r = await reviewDraft({
      label: 'Morning summary',
      draft: "**Coming up**\n- Fri 30 Oct: swimming at 9 am.\n\n**Not sure about:**\nAre Logan and Meg Treeby Winter's parents?",
      evidence: 'DATA ...',
    })
    expect(r.unsupported).toEqual(["Logan and Meg Treeby are Winter's parents"])
    expect(r.message).toBe('Swimming is at 9 on Friday.')
    expect(generateText).toHaveBeenCalledTimes(5)
  })

  it('reports a rewrite that stays empty on every model as failed, not as nothing worth keeping, while statements are still supported', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or'
    generateText
      .mockResolvedValueOnce(out({ claims: ['Swimming is at 9 on Friday', 'a trip to Lisbon was booked'] }))
      .mockResolvedValueOnce(out({ supported: true }))
      .mockResolvedValueOnce(out({ supported: false }))
      .mockResolvedValueOnce(out({ message: '' }))
      .mockResolvedValueOnce(out({ message: '' }))
    const r = await reviewDraft({ label: 'x', draft: 'Swimming is at 9 on Friday. Looks like a trip to Lisbon!', evidence: 'DATA ...' })
    expect(r).toMatchObject({ unsupported: ['a trip to Lisbon was booked'], message: null, rewriteFailed: expect.stringMatching(/came back empty/) })
  })

  it('hands back what failed, not a throw, when the rewrite cannot finish', async () => {
    generateText
      .mockResolvedValueOnce(out({ claims: ['$389.60 to FARESAVER', 'a trip to Lisbon was booked'] }))
      .mockResolvedValueOnce(out({ supported: true }))
      .mockResolvedValueOnce(out({ supported: false }))
      .mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    const r = await reviewDraft({ label: 'x', draft: '2Up: $389.60 FARESAVER LISBON. Looks like a trip to Lisbon!', evidence: 'DATA ...' })
    expect(r).toMatchObject({ unsupported: ['a trip to Lisbon was booked'], message: null, rewriteFailed: expect.stringMatching(/timeout/i) })
  })

  it('asks for at most six claims, checks no more than that, and keeps the draft when they hold', async () => {
    generateText.mockResolvedValueOnce(out({ claims: Array.from({ length: 8 }, (_, i) => `claim ${i}`) }))
    for (let i = 0; i < 6; i++) generateText.mockResolvedValueOnce(out({ supported: true }))
    const r = await reviewDraft({ label: 'x', draft: 'A long report.', evidence: 'DATA ...' })
    expect(String(generateText.mock.calls[0][0].prompt)).toContain('at most 6 statements')
    expect(generateText).toHaveBeenCalledTimes(7)
    expect(r.claims).toHaveLength(6)
    expect(r.message).toBe('A long report.')
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

  it("gives the extract, every check and the rewrite only what is left before the caller's deadline", async () => {
    generateText
      .mockResolvedValueOnce(out({ claims: ['a trip to Lisbon was booked'] }))
      .mockResolvedValueOnce(out({ supported: false }))
      .mockResolvedValueOnce(out({ message: '' }))
    await reviewDraft({ label: 'x', draft: 'Looks like a trip to Lisbon!', evidence: 'DATA ...', deadline: Date.now() + 10_000 })
    expect(generateText).toHaveBeenCalledTimes(3)
    for (const [call] of generateText.mock.calls) {
      expect(call.timeout.totalMs).toBeLessThanOrEqual(10_000)
      expect(call.timeout.stepMs).toBe(30_000)
    }
    // Past it, nothing is asked at all.
    await expect(reviewDraft({ label: 'x', draft: 'Looks like a trip to Lisbon!', evidence: 'DATA ...', deadline: Date.now() - 1 })).rejects.toThrow(
      'Timed out before any model was asked',
    )
    expect(generateText).toHaveBeenCalledTimes(3)
  })
})

describe('dropEmptiedHeadings', () => {
  it('drops a heading the rewrite left over nothing, and keeps a title above the first part', () => {
    const draft = '**Morning brief**\n**Today**\n- After School Care, 3:00 pm – 6:00 pm\n\n**Heads up**\n- A payslip arrived.'
    const rewritten = '**Morning brief**\n**Today**\n\n**Heads up**\n- A payslip arrived.'
    expect(dropEmptiedHeadings(rewritten, draft)).toBe('**Morning brief**\n**Heads up**\n- A payslip arrived.')
  })

  it('drops an emptied last part too, and leaves a draft the rewrite did not empty alone', () => {
    const draft = '**Today**\n- Swimming, 9:00 am\n\n**Overdue**\n- HTL-344 Pay rates'
    expect(dropEmptiedHeadings('**Today**\n- Swimming, 9:00 am\n\n**Overdue**', draft)).toBe('**Today**\n- Swimming, 9:00 am')
    expect(dropEmptiedHeadings(draft, draft)).toBe(draft)
  })
})

describe('cutFromDraft', () => {
  const out = (o: unknown) => ({ ...reply(''), output: o })

  it('takes the statements it is given out of the draft, by the rewrite the claim check uses', async () => {
    generateText.mockResolvedValueOnce(out({ message: 'Bins out tonight.' }))
    const rest = await cutFromDraft({ label: 'Morning summary', draft: 'Bins out tonight. The swimming form is due Friday.', unsupported: ['the swimming form is due Friday'] })
    expect(rest).toBe('Bins out tonight.')
    expect(generateText).toHaveBeenCalledTimes(1)
    const call = generateText.mock.calls[0][0]
    expect(String(call.prompt)).toContain('REPORT:\nBins out tonight. The swimming form is due Friday.')
    expect(String(call.prompt)).toContain('NOT SUPPORTED, remove wherever they appear:\n- the swimming form is due Friday')
    expect(String(call.prompt)).not.toContain('SUPPORTED, keep as written')
    expect(String(call.system)).toContain('Everything else stays exactly as written')
  })

  it('answers null when nothing worth keeping is left, and throws when the rewrite cannot be made', async () => {
    generateText.mockResolvedValueOnce(out({ message: '' }))
    expect(await cutFromDraft({ label: 'x', draft: 'Due Friday.', unsupported: ['due Friday'] })).toBeNull()
    generateText.mockRejectedValue(new Error('No object generated'))
    await expect(cutFromDraft({ label: 'x', draft: 'Due Friday.', unsupported: ['due Friday'] })).rejects.toThrow('No object generated')
  })

  it("is over by the caller's deadline, and asks no model once it has passed", async () => {
    generateText.mockResolvedValueOnce(out({ message: 'Bins out tonight.' }))
    await cutFromDraft({ label: 'x', draft: 'd', unsupported: ['s'], deadline: Date.now() + 10_000 })
    expect(generateText.mock.calls[0][0].timeout.totalMs).toBeLessThanOrEqual(10_000)
    await expect(cutFromDraft({ label: 'x', draft: 'd', unsupported: ['s'], deadline: Date.now() - 1 })).rejects.toThrow('Timed out before any model was asked')
    expect(generateText).toHaveBeenCalledTimes(1)
  })
})

describe('what a scheduled run is told', () => {
  it('names the job, carries its instruction, and says how to stay quiet, report a problem or report', () => {
    const text = scheduledInstruction({ label: 'Bin night', instruction: 'Remind us to put the bins out.', repeat: 'always' }, 'Rowan')
    expect(text).toContain('Scheduled automation "Bin night" is due now.')
    expect(text).toContain('kept as a report for Rowan to read later')
    expect(text).toContain('Remind us to put the bins out.')
    expect(text).toContain('reply with exactly SKIP')
    expect(text).toContain('write PROBLEM:')
    expect(text).not.toContain('stops for good')
  })

  it('tells a watch that runs until it finds something that reporting ends it', () => {
    const text = scheduledInstruction({ label: 'Camp dates', instruction: 'Look for the camp dates.', repeat: 'until' }, 'Sam')
    expect(text).toContain('This check stops for good once it reports anything')
  })
})
