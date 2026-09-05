import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { recordModelEvent } from './model-events'

export type ModelSlot = { name: string; model: LanguageModel }

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** Every model env var accepts a comma-separated list, tried left to right. */
function modelList(value: string | undefined, fallback = ''): string[] {
  return (value ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function slots(opts: {
  label: string
  baseURL: string
  apiKey: string
  models: string[]
  headers?: Record<string, string>
}): ModelSlot[] {
  if (!opts.apiKey || opts.models.length === 0) return []
  const provider = createOpenAICompatible({
    name: opts.label,
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    headers: opts.headers,
    // Without this the provider only logs a warning when a JSON schema is
    // requested and never sends response_format, so structured decisions
    // (watcher post-or-skip, the ambient gate) would silently degrade to prose.
    supportsStructuredOutputs: true,
  })
  return opts.models.map((id) => ({ name: `${opts.label}:${id}`, model: provider(id) }))
}

/**
 * Tier 1: any OpenAI-compatible endpoint. This is the local-first slot, so a
 * self-hosted model takes priority over anything metered once it is running.
 */
export function localSlots(): ModelSlot[] {
  const baseURL = process.env.LLM_BASE_URL
  if (!baseURL) return []
  return slots({
    label: 'local',
    baseURL,
    // Many self-hosted servers ignore the key but the SDK still wants one.
    apiKey: process.env.LLM_API_KEY || 'not-needed',
    models: modelList(process.env.LLM_MODEL),
  })
}

/** Tier 2: Gemini through its OpenAI-compatible surface. Generous free quota. */
export function geminiSlots(): ModelSlot[] {
  return slots({
    label: 'gemini',
    baseURL: process.env.GEMINI_BASE_URL || GEMINI_BASE_URL,
    apiKey: process.env.GEMINI_API_KEY ?? '',
    models: modelList(process.env.GEMINI_MODEL, 'gemini-3.5-flash-lite,gemini-3.5-flash'),
  })
}

/** Tier 3: OpenRouter, the widest catalogue and the last resort. */
export function openrouterSlots(): ModelSlot[] {
  return slots({
    label: 'openrouter',
    baseURL: OPENROUTER_BASE_URL,
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    models: modelList(process.env.OPENROUTER_MODEL, 'minimax/minimax-m2.7:free'),
    headers: {
      'HTTP-Referer': process.env.APP_URL ?? 'https://github.com/logan-han/hearth',
      'X-Title': 'Hearth',
    },
  })
}

export type TierName = 'self-hosted' | 'gemini' | 'openrouter'

export const TIERS: { name: TierName; label: string; slots: () => ModelSlot[] }[] = [
  { name: 'self-hosted', label: 'Self-hosted LLM', slots: localSlots },
  { name: 'gemini', label: 'Google Gemini', slots: geminiSlots },
  { name: 'openrouter', label: 'OpenRouter', slots: openrouterSlots },
]

/** Self-hosted first by default: it is the only one that keeps data at home. */
const DEFAULT_ORDER: TierName[] = ['self-hosted', 'gemini', 'openrouter']

/**
 * Which providers to try, in order. `LLM_ORDER` overrides the default; any tier
 * left out of it is appended rather than dropped, so a typo cannot silently
 * disable a provider that is otherwise configured.
 */
export function tierOrder(): TierName[] {
  const seen = new Set<TierName>()
  for (const raw of (process.env.LLM_ORDER ?? '').split(',')) {
    const name = raw.trim().toLowerCase() as TierName
    // A repeated name would otherwise put the same tier in the chain twice.
    if (DEFAULT_ORDER.includes(name)) seen.add(name)
  }
  return [...seen, ...DEFAULT_ORDER.filter((t) => !seen.has(t))]
}

/**
 * The ordered list of models to try. Each tier contributes zero or more slots
 * depending on what is configured, so an unconfigured tier simply drops out.
 */
export function modelChain(): ModelSlot[] {
  const byName = new Map(TIERS.map((t) => [t.name, t]))
  return tierOrder().flatMap((name) => byName.get(name)?.slots() ?? [])
}

/** The chain as the dashboard shows it: tiers in order, with their models. */
export function describeChain(): { name: TierName; label: string; models: string[]; configured: boolean }[] {
  const byName = new Map(TIERS.map((t) => [t.name, t]))
  return tierOrder().map((name) => {
    const tier = byName.get(name)!
    const models = tier.slots().map((s) => s.name.split(':').slice(1).join(':'))
    return { name, label: tier.label, models, configured: models.length > 0 }
  })
}

/** The single cheapest model, used for the yes/no ambient gate. */
export function gateSlot(): ModelSlot | null {
  return modelChain()[0] ?? null
}

/**
 * Run `fn` against each model in turn, returning the first success. Every
 * failure mode collapses to the same behaviour: rate limit, timeout, provider
 * outage, or a model that cannot drive tools all just move to the next slot.
 * Each attempt is recorded, so the System page can say which slots fail, why,
 * and how often the chain fell through to a later one.
 */
export async function withModelFallback<T>(
  fn: (slot: ModelSlot) => Promise<T>,
  chain: ModelSlot[] = modelChain(),
  purpose = 'model',
): Promise<T> {
  if (chain.length === 0) {
    throw new Error(
      'No LLM configured: set GEMINI_API_KEY, OPENROUTER_API_KEY, or LLM_BASE_URL + LLM_MODEL',
    )
  }
  let lastError: unknown
  for (const slot of chain) {
    const started = Date.now()
    try {
      const out = await fn(slot)
      await recordModelEvent({ slot: slot.name, purpose, outcome: 'answered', ms: Date.now() - started })
      return out
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[model] ${slot.name} failed:`, message)
      await recordModelEvent({ slot: slot.name, purpose, outcome: 'failed', ms: Date.now() - started, error: message })
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
