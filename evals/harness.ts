export type ToolCall = { tool: string; input: unknown }
export type Stubs = Record<string, (input: never) => unknown>

/**
 * The real tool set with some tools answering from a recording. Every call is
 * logged, so an eval can assert that the model reached for the right tool as
 * well as what it said afterwards.
 */
export function withRecorded<T extends Record<string, unknown>>(tools: T, stubs: Stubs, calls: ToolCall[]): T {
  const out: Record<string, unknown> = {}
  for (const [name, t] of Object.entries(tools)) {
    const real = t as { execute?: (input: unknown, options: unknown) => unknown }
    out[name] = {
      ...(t as object),
      execute: async (input: unknown, options: unknown) => {
        calls.push({ tool: name, input })
        const stub = stubs[name]
        return stub ? stub(input as never) : real.execute?.(input, options)
      },
    }
  }
  return out as T
}

export const called = (calls: ToolCall[], tool: string) => calls.filter((c) => c.tool === tool)

/** Is any model configured at all? Without one the evals have nothing to run against. */
export function liveChainConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.LLM_BASE_URL)
}

/**
 * Data for a writer in an eval, as plain lines rather than JSON. A model
 * copies what it is given, and JSON escapes what it holds: a subject line
 * with a quotation mark in it once reached the family as \"...\", backslashes
 * and all, and so did a quoted sender name. Plain lines have nothing to
 * escape, so there is nothing to copy wrongly. The shape is YAML's without
 * its quoting rules: `key: value`, a nested block indented two spaces under
 * its key, a list item behind a dash, and (none) for an empty list, an empty
 * object, a null or an empty string, so an empty flags list still says in
 * words that nothing was flagged.
 */
const NONE = '(none)'
const STEP = '  '

export function plainData(value: unknown): string {
  return render(value, '').join('\n')
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date)

const isEmpty = (v: unknown) =>
  (Array.isArray(v) && v.length === 0) || (isRecord(v) && Object.values(v).every((x) => x === undefined))

function scalar(v: unknown): string {
  if (v === null || v === undefined || v === '') return NONE
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/** A prefix and its text; a text of several lines continues indented under the first. */
function lead(pad: string, prefix: string, text: string): string[] {
  const [first, ...rest] = text.split('\n')
  return [`${pad}${prefix}${first}`, ...rest.map((line) => `${pad}${STEP}${line}`)]
}

function render(value: unknown, pad: string): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${NONE}`]
    return value.flatMap((item) => {
      if (!isRecord(item) && !Array.isArray(item)) return lead(pad, '- ', scalar(item))
      const [head, ...rest] = render(item, pad + STEP)
      return [`${pad}- ${head.trimStart()}`, ...rest]
    })
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return [`${pad}${NONE}`]
    return entries.flatMap(([key, v]) => {
      if (isRecord(v) || Array.isArray(v)) {
        return isEmpty(v) ? [`${pad}${key}: ${NONE}`] : [`${pad}${key}:`, ...render(v, pad + STEP)]
      }
      return lead(pad, `${key}: `, scalar(v))
    })
  }
  return lead(pad, '', scalar(value))
}
