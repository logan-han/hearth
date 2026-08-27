import { describe, it, expect, beforeEach, vi } from 'vitest'
import { tierOrder, describeChain, modelChain, TIERS } from '@/lib/model'

beforeEach(() => {
  vi.restoreAllMocks()
  for (const k of ['LLM_ORDER', 'LLM_BASE_URL', 'LLM_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL']) {
    delete process.env[k]
  }
})

describe('tierOrder', () => {
  it('puts the self-hosted tier first by default, being the only private one', () => {
    expect(tierOrder()).toEqual(['self-hosted', 'gemini', 'openrouter'])
  })

  it('honours an explicit order', () => {
    process.env.LLM_ORDER = 'openrouter,gemini,self-hosted'
    expect(tierOrder()).toEqual(['openrouter', 'gemini', 'self-hosted'])
  })

  it('appends anything left out rather than dropping it', () => {
    process.env.LLM_ORDER = 'openrouter'
    expect(tierOrder()).toEqual(['openrouter', 'self-hosted', 'gemini'])
  })

  it('ignores a name it does not recognise, so a typo cannot disable a provider', () => {
    process.env.LLM_ORDER = 'nonsense,gemini'
    expect(tierOrder()).toEqual(['gemini', 'self-hosted', 'openrouter'])
  })

  it('tolerates spacing and case', () => {
    process.env.LLM_ORDER = ' OpenRouter , GEMINI '
    expect(tierOrder().slice(0, 2)).toEqual(['openrouter', 'gemini'])
  })

  it('never repeats a tier even when it is named twice', () => {
    process.env.LLM_ORDER = 'gemini,gemini'
    const order = tierOrder()
    expect(new Set(order).size).toBe(order.length)
  })

  it('falls back to the default when the value is empty', () => {
    process.env.LLM_ORDER = '   '
    expect(tierOrder()).toEqual(['self-hosted', 'gemini', 'openrouter'])
  })
})

describe('the chain follows the order', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'k'
    process.env.GEMINI_MODEL = 'gem-a'
    process.env.OPENROUTER_API_KEY = 'sk-or'
    process.env.OPENROUTER_MODEL = 'or-a'
  })

  it('resolves models in the configured tier order', () => {
    process.env.LLM_ORDER = 'openrouter,gemini'
    expect(modelChain().map((s) => s.name)).toEqual(['openrouter:or-a', 'gemini:gem-a'])
  })

  it('skips a tier with no key rather than failing', () => {
    process.env.LLM_ORDER = 'self-hosted,gemini,openrouter'
    expect(modelChain().map((s) => s.name)).toEqual(['gemini:gem-a', 'openrouter:or-a'])
  })
})

describe('describeChain', () => {
  it('reports every tier, including the ones not set up', () => {
    const shown = describeChain()
    expect(shown).toHaveLength(TIERS.length)
    expect(shown.every((t) => !t.configured)).toBe(true)
  })

  it('marks a configured tier and lists its models in order', () => {
    process.env.GEMINI_API_KEY = 'k'
    process.env.GEMINI_MODEL = 'fast,slow'
    const gemini = describeChain().find((t) => t.name === 'gemini')!
    expect(gemini).toMatchObject({ configured: true, models: ['fast', 'slow'], label: 'Google Gemini' })
  })

  it('calls the self-hosted tier what it is', () => {
    expect(describeChain().find((t) => t.name === 'self-hosted')!.label).toBe('Self-hosted LLM')
  })
})
