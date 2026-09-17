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
