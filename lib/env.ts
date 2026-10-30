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

const DEFAULT_TIMEZONE = 'Australia/Melbourne'
let zoneChecked: { value: string; zone: string | null } | null = null

/**
 * The household's timezone, not the viewer's. Bin night, school pickup and a
 * 7pm reminder all mean Melbourne time whether you are reading this from the
 * kitchen or from an airport. Read through a function so a change made in the
 * dashboard applies without a redeploy. A value no clock knows falls back to
 * the default rather than throwing from every date on every page, including
 * the Settings page that would fix it.
 */
export function timezone(): string {
  const value = process.env.TIMEZONE?.trim()
  if (!value) return DEFAULT_TIMEZONE
  if (zoneChecked?.value !== value) {
    zoneChecked = { value, zone: canonicalTimeZone(value) }
    if (!zoneChecked.zone) console.warn(`[env] TIMEZONE "${value}" is not a time zone; using ${DEFAULT_TIMEZONE}`)
  }
  return zoneChecked.zone ?? DEFAULT_TIMEZONE
}

/**
 * A zone's own name, as Google, Graph, Postgres and the weather all expect it
 * ('australia/perth' is Australia/Perth), or null when it is no zone. An
 * offset such as +10:00 is refused: it knows nothing of daylight saving, and
 * Postgres reads its sign the other way round.
 */
export function canonicalTimeZone(value: string): string | null {
  try {
    const zone = new Intl.DateTimeFormat('en', { timeZone: value.trim() }).resolvedOptions().timeZone
    return /^[+-]/.test(zone) ? null : zone
  } catch {
    return null
  }
}

/** True for a zone Intl can format in, such as Australia/Melbourne; see canonicalTimeZone. */
export function isTimeZone(value: string): boolean {
  return canonicalTimeZone(value) !== null
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

const DEFAULT_NAME = 'Hearth'

/**
 * A name the bot can be called by and answer to: one or two words of letters,
 * so it can open a message ("Pip, ...") and be found there again without
 * catching ordinary words or punctuation.
 */
export function isAssistantName(value: string): boolean {
  return /^\p{L}[\p{L}'-]*(?: \p{L}[\p{L}'-]*)?$/u.test(value.trim()) && value.trim().length <= 24
}

/** What the bot calls itself; Hearth unless the household has named it. A name that would not pass is not used. */
export function assistantName(): string {
  const value = process.env.ASSISTANT_NAME?.trim()
  return value && isAssistantName(value) ? value : DEFAULT_NAME
}

/** How the bot talks in the chat, in the household's own words; empty for the plain default. */
export function assistantPersona(): string {
  return (process.env.ASSISTANT_PERSONA ?? '').trim().slice(0, 300)
}

/**
 * Whether a message opens by calling a name, the way a member speaks to
 * someone across the room: "Pip, ...", "Pip: ...", "Pip?", or a greeting
 * first, "hey Pip what's on". A bare "Pip is great" is talk about it, not to
 * it, and so is the name anywhere later in the message.
 */
export function opensWithName(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  if (!escaped) return false
  const called = `@?${escaped}`
  return new RegExp(
    `^\\s*(?:(?:hey|hi|hello|ok|okay|oi|yo)[\\s,]+${called}(?=$|[\\s,:;!?.])|${called}\\s*(?=$|[,:;!?]))`,
    'iu',
  ).test(text)
}
