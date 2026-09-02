import type { LangfuseSpanProcessor } from '@langfuse/otel'
import type { PropagateAttributesParams } from '@langfuse/tracing'

/**
 * Langfuse tracing for every model call, switched on by the presence of the
 * Langfuse keys and otherwise inert. instrumentation.ts registers it once per
 * server start. The OpenTelemetry modules are imported lazily, so a deployment
 * without keys, and the test suite, never load them.
 */

let processor: LangfuseSpanProcessor | null = null

export function telemetryConfigured(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)
}

/**
 * Traces carry prompts and replies by default, which for this app means the
 * family's messages and mail. LANGFUSE_RECORD_CONTENT=off keeps only the shape
 * of each call: model, tools, tokens, timing, decisions.
 */
export function recordContent(): boolean {
  return (process.env.LANGFUSE_RECORD_CONTENT ?? 'on').trim().toLowerCase() !== 'off'
}

export async function setupTelemetry(): Promise<boolean> {
  if (processor) return true
  if (!telemetryConfigured()) return false
  const [{ registerOTel }, { LangfuseSpanProcessor }, { LangfuseVercelAiSdkIntegration }, { registerTelemetry }] =
    await Promise.all([import('@vercel/otel'), import('@langfuse/otel'), import('@langfuse/vercel-ai-sdk'), import('ai')])
  processor = new LangfuseSpanProcessor({
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.VERCEL_ENV ?? 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
  })
  registerOTel({ serviceName: 'hearth', spanProcessors: [processor] })
  registerTelemetry(new LangfuseVercelAiSdkIntegration())
  console.info('[telemetry] Langfuse tracing on')
  return true
}

/** Run `fn` with trace attributes attached, or plainly when tracing is off. */
export async function traced<T>(attrs: PropagateAttributesParams, fn: () => Promise<T>): Promise<T> {
  if (!processor) return fn()
  const { propagateAttributes } = await import('@langfuse/tracing')
  return propagateAttributes(attrs, fn)
}

/** Per-call settings for generateText: a name for the call, and whether content is kept. */
export function callTelemetry(functionId: string) {
  const keep = recordContent()
  return { functionId, recordInputs: keep, recordOutputs: keep }
}

/**
 * A serverless function ends with its response, and spans still sitting in
 * the batch would go with it. Called at the end of every background run.
 */
export async function flushTelemetry(): Promise<void> {
  if (!processor) return
  try {
    await processor.forceFlush()
  } catch (err) {
    console.warn('[telemetry] flush failed:', err instanceof Error ? err.message : err)
  }
}
