/** Central env access. Throws only when a value is actually needed at runtime. */

export function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

export function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

/** Public base URL of the deployment, e.g. https://hearth.vercel.app (no trailing slash). */
export function appUrl(): string {
  const explicit = process.env.APP_URL
  if (explicit) return explicit.replace(/\/$/, '')
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL
  if (vercel) return `https://${vercel}`
  return 'http://localhost:3000'
}

/** Parse a comma/space separated list of ids into a Set of strings. */
export function idSet(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/**
 * The household's timezone, not the viewer's. Bin night, school pickup and a
 * 7pm reminder all mean Melbourne time whether you are reading this from the
 * kitchen or from an airport. Read through a function so a change made in the
 * dashboard applies without a redeploy.
 */
export function timezone(): string {
  return process.env.TIMEZONE || 'Australia/Melbourne'
}

/** Read at call time, like timezone(), so a dashboard change applies without a redeploy. */
export function ambientMode(): boolean {
  return (process.env.AMBIENT_MODE ?? 'off').toLowerCase() === 'on'
}

/** The language and spelling the bot replies in. The household's, not a constant. */
export function language(): string {
  return process.env.LANGUAGE || 'Australian English'
}

/** 'metric' unless the household explicitly chooses imperial. */
export function units(): 'metric' | 'imperial' {
  return (process.env.UNITS ?? '').toLowerCase() === 'imperial' ? 'imperial' : 'metric'
}

const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/**
 * How hard the model may think before answering, passed through as the
 * OpenAI-compatible `reasoning_effort`. Unset means the provider's default.
 * Gemini's compatibility layer silently ignores values it does not know and
 * cannot switch thinking off on Gemini 3 models, so treat a change here as
 * something to verify from token counts, not assume.
 */
export function reasoningLevel(): ReasoningLevel | undefined {
  const v = (process.env.LLM_REASONING ?? '').trim().toLowerCase()
  return (REASONING_LEVELS as readonly string[]).includes(v) ? (v as ReasoningLevel) : undefined
}
