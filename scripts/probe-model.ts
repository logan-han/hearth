/**
 * Probe a model with a real tool call before putting it in the chain.
 *
 *   npm run probe -- openrouter minimax/minimax-m3
 *   npm run probe -- gemini gemini-3.5-flash-lite
 *   npm run probe -- self-hosted qwen3
 *
 * Reads the provider's key from .env.local. Every model in the chain must
 * drive tools and answer a typed choice (the ambient gate and the claimed-
 * action check rely on it), so both are exercised. Exits 1 when the model
 * never called the tool.
 */
import { loadEnvLocal } from '../lib/load-env'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, tool, stepCountIs, Output } from 'ai'
import { z } from 'zod'
import { GEMINI_BASE_URL, OPENROUTER_BASE_URL } from '../lib/model'

loadEnvLocal()

const [provider = '', model = ''] = process.argv.slice(2)
const endpoints: Record<string, { baseURL: string | undefined; apiKey: string | undefined }> = {
  openrouter: { baseURL: OPENROUTER_BASE_URL, apiKey: process.env.OPENROUTER_API_KEY },
  gemini: { baseURL: process.env.GEMINI_BASE_URL || GEMINI_BASE_URL, apiKey: process.env.GEMINI_API_KEY },
  'self-hosted': { baseURL: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY || 'not-needed' },
}
const endpoint = endpoints[provider]
if (!endpoint || !model) {
  console.error('usage: npm run probe -- <openrouter|gemini|self-hosted> <model id>')
  process.exit(2)
}
if (!endpoint.baseURL || !endpoint.apiKey) {
  console.error(`No endpoint or key configured for ${provider} in .env.local`)
  process.exit(2)
}

const llm = createOpenAICompatible({ name: provider, baseURL: endpoint.baseURL, apiKey: endpoint.apiKey, supportsStructuredOutputs: true })(model)

const started = Date.now()
const r = await generateText({
  model: llm,
  system: 'You are a household assistant. Anything about the family calendar comes from the tool, never from memory.',
  prompt: 'What is on the family calendar on 30 September 2026?',
  tools: {
    list_family_events: tool({
      description: 'List events on the shared family calendar within a date range.',
      inputSchema: z.object({ from: z.string(), to: z.string() }),
      execute: async () => ({ events: [{ id: 15, title: 'Scouts Cuboree', start_local: 'Wed, 30 Sept 2026', all_day: true }] }),
    }),
  },
  stopWhen: stepCountIs(3),
  maxOutputTokens: 300,
})
const toolMs = Date.now() - started
const calledTool = r.steps.some((s) => s.toolCalls.some((c) => c.toolName === 'list_family_events'))

const choiceStarted = Date.now()
let choice: string | null = null
let choiceError: string | null = null
try {
  const c = await generateText({
    model: llm,
    system: 'You read one reply from a household assistant and say whether it reports a change as already made.',
    prompt: 'REPLY:\nGot it. Replaced the 30 Sep vacation care with Scouts Cuboree.\n\nDoes the reply report a change as already made?',
    output: Output.choice({ options: ['claims_change', 'no_change_claimed', 'unsure'], name: 'claim' }),
    maxOutputTokens: 64,
    temperature: 0,
  })
  choice = c.output ?? `(prose: ${c.text.slice(0, 60)})`
} catch (err) {
  choiceError = err instanceof Error ? err.message.slice(0, 160) : String(err)
}

console.log(`${provider}:${model}`)
console.log(`  tool call:     ${calledTool ? 'yes' : 'NO'} (${toolMs} ms, ${r.steps.length} step${r.steps.length === 1 ? '' : 's'})`)
console.log(`  answer:        ${r.text.replace(/\s+/g, ' ').slice(0, 160) || '(empty)'}`)
console.log(`  typed choice:  ${choiceError ? `FAILED: ${choiceError}` : `${choice} (${Date.now() - choiceStarted} ms)`}`)
console.log(`  tokens:        ${r.usage.inputTokens ?? '?'} in / ${r.usage.outputTokens ?? '?'} out`)
if (!calledTool) process.exit(1)
