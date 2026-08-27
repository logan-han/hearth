import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  withModelFallback, modelChain, localSlots, geminiSlots, openrouterSlots, gateSlot,
  type ModelSlot,
} from '@/lib/model'

const slot = (name: string): ModelSlot => ({ name, model: {} as ModelSlot['model'] })

const ENV_KEYS = [
  'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE_URL',
  'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('tiers', () => {
  it('contribute nothing when unconfigured', () => {
    expect(modelChain()).toHaveLength(0)
    expect(localSlots()).toHaveLength(0)
    expect(geminiSlots()).toHaveLength(0)
    expect(openrouterSlots()).toHaveLength(0)
    expect(gateSlot()).toBeNull()
  })

  it('need a base URL and a model for the local tier', () => {
    process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1'
    expect(localSlots()).toHaveLength(0)
    process.env.LLM_MODEL = 'qwen3'
    expect(localSlots().map((s) => s.name)).toEqual(['local:qwen3'])
  })

  it('does not require an API key for a self-hosted endpoint', () => {
    process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1'
    process.env.LLM_MODEL = 'qwen3'
    expect(localSlots()).toHaveLength(1)
  })

  it('gives Gemini a sensible default pair of models', () => {
    process.env.GEMINI_API_KEY = 'k'
    expect(geminiSlots().map((s) => s.name)).toEqual([
      'gemini:gemini-3.5-flash-lite',
      'gemini:gemini-3.5-flash',
    ])
  })

  it('expands a comma-separated model list in order', () => {
    process.env.GEMINI_API_KEY = 'k'
    process.env.GEMINI_MODEL = ' a , b ,, c '
    expect(geminiSlots().map((s) => s.name)).toEqual(['gemini:a', 'gemini:b', 'gemini:c'])
  })

  it('drops a tier whose key is missing even when models are named', () => {
    process.env.GEMINI_MODEL = 'gemini-3.5-flash'
    process.env.OPENROUTER_MODEL = 'minimax/minimax-m3:free'
    expect(modelChain()).toHaveLength(0)
  })
})

describe('modelChain ordering', () => {
  it('runs local, then Gemini, then OpenRouter', () => {
    process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1'
    process.env.LLM_MODEL = 'qwen3'
    process.env.GEMINI_API_KEY = 'k'
    process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite'
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    process.env.OPENROUTER_MODEL = 'minimax/minimax-m3:free'
    expect(modelChain().map((s) => s.name)).toEqual([
      'local:qwen3',
      'gemini:gemini-3.5-flash-lite',
      'openrouter:minimax/minimax-m3:free',
    ])
  })

  it('gates on the first slot in the chain', () => {
    process.env.GEMINI_API_KEY = 'k'
    process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite'
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    expect(gateSlot()?.name).toBe('gemini:gemini-3.5-flash-lite')
  })

  it('promotes Gemini to first when there is no local endpoint', () => {
    process.env.GEMINI_API_KEY = 'k'
    process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite'
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    expect(modelChain()[0].name).toBe('gemini:gemini-3.5-flash-lite')
  })
})

describe('withModelFallback', () => {
  it('returns the first success without touching later slots', async () => {
    const fn = vi.fn(async (s: ModelSlot) => s.name)
    await expect(withModelFallback(fn, [slot('a'), slot('b')])).resolves.toBe('a')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('walks the whole chain until one works', async () => {
    const fn = vi.fn(async (s: ModelSlot) => {
      if (s.name !== 'third') throw new Error(`${s.name} unavailable`)
      return 'ok'
    })
    await expect(
      withModelFallback(fn, [slot('first'), slot('second'), slot('third')]),
    ).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('treats a rate limit like any other failure and moves on', async () => {
    const fn = vi.fn(async (s: ModelSlot) => {
      if (s.name === 'gemini') throw new Error('429 RESOURCE_EXHAUSTED: quota exceeded')
      return 'answered by openrouter'
    })
    await expect(withModelFallback(fn, [slot('gemini'), slot('openrouter')])).resolves.toBe(
      'answered by openrouter',
    )
  })

  it('rethrows the last error when every model fails', async () => {
    const fn = vi.fn(async (s: ModelSlot) => {
      throw new Error(`${s.name} down`)
    })
    await expect(withModelFallback(fn, [slot('a'), slot('b')])).rejects.toThrow('b down')
  })

  it('names the env vars when nothing is configured', async () => {
    await expect(withModelFallback(async () => 'x', [])).rejects.toThrow(/GEMINI_API_KEY/)
  })

  it('retries an empty completion on the next model', async () => {
    const fn = vi.fn(async (s: ModelSlot) => {
      const text = s.name === 'gemini' ? '' : 'a real answer'
      if (!text) throw new Error(`${s.name} returned no text`)
      return text
    })
    await expect(withModelFallback(fn, [slot('gemini'), slot('openrouter')])).resolves.toBe(
      'a real answer',
    )
  })
})
