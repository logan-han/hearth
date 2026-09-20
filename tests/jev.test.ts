import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import { chainHealth } from '@/lib/model-events'

const { systemOne, construct } = vi.hoisted(() => ({ systemOne: vi.fn(), construct: vi.fn() }))
vi.mock('@typesafe-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@typesafe-ai/sdk')>()
  class TypeSafeClient {
    systemOne = systemOne
    constructor(config: unknown) {
      construct(config)
    }
  }
  return { ...actual, TypeSafeClient }
})

const { APIError } = await import('@typesafe-ai/sdk')
const { jevConfigured, jevModel, jevSlot, resetJevClient, wantsAssistant, claimsChange, checkClaims, decidePost, THRESHOLDS } =
  await import('@/lib/jev')

let client: PGlite

const noul = (p: number) => ({ type: 'noul', noul: p })
const pick = (supported: number, rest = 1 - supported) => ({
  type: 'choice',
  choice: supported >= 0.5 ? 'supported' : 'not_in_evidence',
  confidence: Math.max(supported, rest),
  probabilities: { supported, contradicted: 0, not_in_evidence: rest },
})
const answer = (answers: Record<string, unknown>) => ({ model: 'jev-1.13.0', answers, usage: { input_tokens: 120, output_tokens: 0 } })

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.TYPESAFE_API_KEY = 'ts-test-key'
  delete process.env.TYPESAFE_DEFAULT_MODEL
  resetJevClient()
  client = (await freshDb()).client
})
afterEach(async () => {
  delete process.env.TYPESAFE_API_KEY
  await closeDb(client)
})

describe('configuration', () => {
  it('is on with a key and off without one', () => {
    expect(jevConfigured()).toBe(true)
    delete process.env.TYPESAFE_API_KEY
    expect(jevConfigured()).toBe(false)
  })

  it('runs jev-latest unless a version is pinned, and names its slot after the model', () => {
    expect(jevModel()).toBe('jev-latest')
    expect(jevSlot()).toBe('jev:jev-latest')
    process.env.TYPESAFE_DEFAULT_MODEL = 'jev-1.13.0'
    expect(jevSlot()).toBe('jev:jev-1.13.0')
  })

  it('builds one client per key and model, with a short timeout, and a fresh one when the key changes', async () => {
    systemOne.mockResolvedValue(answer({ forAssistant: noul(0.9) }))
    await wantsAssistant({ chatId: '-1', conversation: [], message: 'Ada: hi' })
    await wantsAssistant({ chatId: '-1', conversation: [], message: 'Ada: hi' })
    expect(construct).toHaveBeenCalledTimes(1)
    expect(construct.mock.calls[0][0]).toMatchObject({ apiKey: 'ts-test-key', defaultModel: 'jev-latest' })
    expect((construct.mock.calls[0][0] as { timeout: number }).timeout).toBeLessThanOrEqual(15_000)
    process.env.TYPESAFE_API_KEY = 'ts-rotated'
    await wantsAssistant({ chatId: '-1', conversation: [], message: 'Ada: hi' })
    expect(construct).toHaveBeenCalledTimes(2)
    expect(construct.mock.calls[1][0]).toMatchObject({ apiKey: 'ts-rotated' })
  })

  it('refuses to call without a key, naming the setting', async () => {
    delete process.env.TYPESAFE_API_KEY
    await expect(wantsAssistant({ chatId: '-1', conversation: [], message: 'Ada: hi' })).rejects.toThrow(/TYPESAFE_API_KEY/)
    expect(systemOne).not.toHaveBeenCalled()
  })
})

describe('the ambient gate', () => {
  const input = { chatId: '-100', conversation: ['Sam: that movie was so bad', 'Hearth: Noted.'], message: 'Ada: anyone know the wifi password?' }

  it('sends the conversation and the message as named state, and asks one noul', async () => {
    systemOne.mockResolvedValue(answer({ forAssistant: noul(0.9) }))
    expect(await wantsAssistant(input)).toBe(true)
    expect(systemOne).toHaveBeenCalledTimes(1)
    const req = systemOne.mock.calls[0][0]
    expect(req.state).toEqual({ conversation: input.conversation, message: input.message })
    expect(req.questions.forAssistant.type).toBe('noul')
    expect(JSON.stringify(req.questions.forAssistant.instructions)).toContain('`message`')
    expect(Object.keys(req.questions)).toEqual(['forAssistant'])
  })

  it('draws the line at the gate threshold', async () => {
    systemOne.mockResolvedValue(answer({ forAssistant: noul(THRESHOLDS.gateReply) }))
    expect(await wantsAssistant(input)).toBe(true)
    systemOne.mockResolvedValue(answer({ forAssistant: noul(THRESHOLDS.gateReply - 0.01) }))
    expect(await wantsAssistant(input)).toBe(false)
  })

  it('logs the probability behind the call', async () => {
    systemOne.mockResolvedValue(answer({ forAssistant: noul(0.42) }))
    await wantsAssistant(input)
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('p(for assistant)=0.42 -> stay_silent'))
  })
})

describe('the reply check', () => {
  it('reads a change reported as made off one noul, at its own threshold', async () => {
    systemOne.mockResolvedValue(answer({ claimsChange: noul(THRESHOLDS.claimsChange) }))
    expect(await claimsChange({ reply: 'Done, replaced it.', chatId: '-1' })).toBe(true)
    expect(systemOne.mock.calls[0][0].state).toEqual({ reply: 'Done, replaced it.' })
    expect(systemOne.mock.calls[0][0].questions.claimsChange.type).toBe('noul')
    systemOne.mockResolvedValue(answer({ claimsChange: noul(0.3) }))
    expect(await claimsChange({ reply: 'The dentist is Thursday. Move it?', chatId: '-1' })).toBe(false)
  })

  it('clips a long reply rather than sending the lot', async () => {
    systemOne.mockResolvedValue(answer({ claimsChange: noul(0.1) }))
    await claimsChange({ reply: 'x'.repeat(5_000), chatId: '-1' })
    expect((systemOne.mock.calls[0][0].state as { reply: string }).reply).toHaveLength(2_000)
  })
})

describe('the claim checks', () => {
  it('asks nothing when there is nothing to check', async () => {
    expect(await checkClaims({ label: 'x', claims: [], evidence: 'e' })).toEqual([])
    expect(systemOne).not.toHaveBeenCalled()
  })

  it('checks every statement against the evidence in one call, and cuts on the supported probability', async () => {
    systemOne.mockResolvedValue(answer({ c0: pick(0.93), c1: pick(0.2), c2: pick(THRESHOLDS.claimSupported) }))
    const out = await checkClaims({
      label: '2Up transactions',
      claims: ['$389.60 was paid to FARESAVER LISBON', 'a trip to Lisbon was booked', 'the payment was on Tue 26 Aug'],
      evidence: 'DATA: FARESAVER LISBON $389.60 Tue 26 Aug',
    })
    expect(out.map((c) => c.supported)).toEqual([true, false, true])
    expect(out[0]).toEqual({ claim: '$389.60 was paid to FARESAVER LISBON', supported: true, p: 0.93 })
    expect(systemOne).toHaveBeenCalledTimes(1)
    const req = systemOne.mock.calls[0][0]
    expect(req.state).toEqual({ evidence: 'DATA: FARESAVER LISBON $389.60 Tue 26 Aug' })
    expect(Object.keys(req.questions)).toEqual(['c0', 'c1', 'c2'])
    // The checker sees one statement and the evidence, never the draft.
    expect(req.questions.c1.type).toBe('choice')
    expect(req.questions.c1.instructions.statement).toBe('a trip to Lisbon was booked')
    expect(Object.keys(req.questions.c1.criteria)).toEqual(['supported', 'contradicted', 'not_in_evidence'])
    expect(JSON.stringify(req)).not.toContain('Looks like')
  })
})

describe('the post decision', () => {
  const input = { label: 'Morning brief', draft: 'Bins out tonight.', evidence: 'INSTRUCTION: remind about bins' }

  it('posts when nothing in the draft is missing from the evidence, with the probability behind it', async () => {
    systemOne.mockResolvedValue(answer({ invented: noul(0.07), nothingNew: noul(0.02) }))
    expect(await decidePost(input)).toEqual({ decision: 'post', confidence: 0.93, model: 'jev:jev-latest' })
    const req = systemOne.mock.calls[0][0]
    expect(req.state).toEqual({ draft: input.draft, evidence: input.evidence })
    expect(Object.keys(req.questions).sort()).toEqual(['invented', 'nothingNew'])
    expect(JSON.stringify(req.questions.invented.instructions)).toContain('Which items the draft chose to mention is not the question')
  })

  it('skips a draft that states what the evidence does not, and says so', async () => {
    systemOne.mockResolvedValue(answer({ invented: noul(THRESHOLDS.postInvented), nothingNew: noul(0.1) }))
    const d = await decidePost(input)
    expect(d).toMatchObject({ decision: 'skip', confidence: THRESHOLDS.postInvented, model: 'jev:jev-latest' })
    expect(d.reason).toMatch(/evidence does not contain/)
  })

  it('skips a draft that only says there is nothing new', async () => {
    systemOne.mockResolvedValue(answer({ invented: noul(0.1), nothingNew: noul(0.88) }))
    expect(await decidePost(input)).toMatchObject({ decision: 'skip', confidence: 0.88, reason: expect.stringContaining('nothing new') })
  })

  it('leaves the grey zone to the caller: a post below the tick line is still a post, at its probability', async () => {
    systemOne.mockResolvedValue(answer({ invented: noul(0.4), nothingNew: noul(0.1) }))
    expect(await decidePost(input)).toMatchObject({ decision: 'post', confidence: 0.6 })
  })
})

describe('the trace', () => {
  const langfuse = globalThis as unknown as { __hearthLangfuse?: { forceFlush: () => Promise<void> } | null }
  afterEach(() => {
    langfuse.__hearthLangfuse = null
  })

  it('reports each call as a generation once tracing is live, with the answers and the tokens', async () => {
    langfuse.__hearthLangfuse = { forceFlush: async () => {} }
    systemOne.mockResolvedValue(answer({ forAssistant: noul(0.9) }))
    expect(await wantsAssistant({ chatId: '-1', conversation: [], message: 'Ada: hi' })).toBe(true)
    expect(systemOne).toHaveBeenCalledTimes(1)
  })
})

describe('the record', () => {
  it('lands each call in the chain health under the Jev slot, by purpose', async () => {
    systemOne.mockResolvedValue(answer({ forAssistant: noul(0.9) }))
    await wantsAssistant({ chatId: '-1', conversation: [], message: 'Ada: hi' })
    systemOne.mockResolvedValue(answer({ invented: noul(0.1), nothingNew: noul(0.1) }))
    await decidePost({ label: 'x', draft: 'd', evidence: 'e' })
    const health = await chainHealth(1)
    const jev = health.slots.find((s) => s.slot === 'jev:jev-latest')
    expect(jev).toMatchObject({ answered: 2, failed: 0 })
  })

  it('records a failure with the status in front, rethrows it, and leaves the trace name on the error', async () => {
    systemOne.mockRejectedValue(new APIError(429, {}, new Headers(), 'rate limited'))
    await expect(claimsChange({ reply: 'done', chatId: '-1' })).rejects.toThrow('HTTP 429: rate limited')
    systemOne.mockRejectedValue(new APIError(401, {}, new Headers(), '401 invalid key'))
    await expect(claimsChange({ reply: 'done', chatId: '-1' })).rejects.toThrow('401 invalid key')
    systemOne.mockRejectedValue(new Error('fetch failed'))
    await expect(claimsChange({ reply: 'done', chatId: '-1' })).rejects.toThrow('fetch failed')
    const health = await chainHealth(1)
    const jev = health.slots.find((s) => s.slot === 'jev:jev-latest')
    expect(jev?.failed).toBe(3)
    expect(jev?.reasons.map((r) => r.kind).sort()).toEqual(['other', 'rate limited', 'refused'])
    expect(console.error).toHaveBeenCalledWith('[jev] hearth.claim failed:', 'HTTP 429: rate limited')
  })
})
