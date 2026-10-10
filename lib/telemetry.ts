import { AsyncLocalStorage } from 'node:async_hooks'
import type { LangfuseSpanProcessor } from '@langfuse/otel'
import type { PropagateAttributesParams } from '@langfuse/tracing'
import { describeError } from './errors'

/**
 * Langfuse tracing for every model call, switched on by the presence of the
 * Langfuse keys and otherwise inert. instrumentation.ts registers it once per
 * server start. The OpenTelemetry modules are imported lazily, so a deployment
 * without keys, and the test suite, never load them.
 */

/**
 * The processor lives on globalThis, not in this module. Next bundles
 * instrumentation.ts separately from the route handlers, so a module-level
 * variable set at register() is null inside every route: spans still arrived
 * (the OpenTelemetry provider is process-wide) but `traced()` saw no processor
 * and skipped the trace name, session and user, and the flush was a no-op.
 */
const slot = globalThis as unknown as { __hearthLangfuse?: LangfuseSpanProcessor | null }

function processor(): LangfuseSpanProcessor | null {
  return slot.__hearthLangfuse ?? null
}

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
  if (processor()) return true
  if (!telemetryConfigured()) return false
  const [{ registerOTel }, { LangfuseSpanProcessor }, { LangfuseVercelAiSdkIntegration }, { registerTelemetry }] =
    await Promise.all([import('@vercel/otel'), import('@langfuse/otel'), import('@langfuse/vercel-ai-sdk'), import('ai')])
  const created = new LangfuseSpanProcessor({
    // An empty line copied from .env.example means unset, not a label of ''.
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.VERCEL_ENV || 'development',
    release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
  })
  registerOTel({ serviceName: 'hearth', spanProcessors: [created] })
  registerTelemetry(new LangfuseVercelAiSdkIntegration())
  slot.__hearthLangfuse = created
  console.info('[telemetry] Langfuse tracing on')
  return true
}

/** What a run says about itself on its root observation: what it was given, what came of it, and how. */
export type RunNote = {
  input?: unknown
  output?: unknown
  /** Shape only, always kept: an outcome, a decision and its confidence, counts, models. */
  metadata?: Record<string, unknown>
  /** Metadata that quotes the family's content, such as a held draft's reason: kept only with input and output. */
  detail?: Record<string, unknown>
  level?: 'DEFAULT' | 'WARNING' | 'ERROR'
}

type ActiveRun = { name: string; note: (n: RunNote) => void }

/** On globalThis for the same reason as the processor: whichever bundle opened the run, the code inside it finds it. */
const runSlot = globalThis as unknown as { __hearthRuns?: AsyncLocalStorage<ActiveRun> }
const runs = (runSlot.__hearthRuns ??= new AsyncLocalStorage<ActiveRun>())

/**
 * Run `fn` with trace attributes attached, or plainly when tracing is off.
 * Inside a run the trace keeps the run's name: each call setting its own
 * named a chat turn's trace after the claim check or the summary that
 * happened to come last, and every brief's after its post decision.
 */
export async function traced<T>(attrs: PropagateAttributesParams, fn: () => Promise<T>): Promise<T> {
  if (!processor()) return fn()
  const { propagateAttributes } = await import('@langfuse/tracing')
  const run = runs.getStore()
  return propagateAttributes(run ? { ...attrs, traceName: run.name } : attrs, fn)
}

/**
 * One piece of work as a trace of its own: a chat turn, a watcher run, the
 * nightly pass. Every model call made inside nests under one root observation
 * named `name`, and what the work was given and what came of it go on that
 * root through noteRun(). Without it a tick's runs shared the request's trace,
 * and whether a draft was posted, cut or held back was only in a log that
 * Vercel keeps for an hour. Plainly `fn()` when tracing is off, or when the
 * tracing modules cannot be loaded; `fn` runs exactly once either way.
 */
export async function traceRun<T>(name: string, attrs: Omit<PropagateAttributesParams, 'traceName'>, fn: () => Promise<T>): Promise<T> {
  if (!processor()) return fn()
  let modules: [typeof import('@langfuse/tracing'), typeof import('@opentelemetry/api')]
  try {
    modules = await Promise.all([import('@langfuse/tracing'), import('@opentelemetry/api')])
  } catch (err) {
    console.warn('[telemetry] run not traced:', describeError(err))
    return fn()
  }
  const [{ propagateAttributes, startActiveObservation }, { context, ROOT_CONTEXT }] = modules
  // A root context, so the run starts a trace rather than joining the request's.
  return context.with(ROOT_CONTEXT, () =>
    propagateAttributes({ ...attrs, traceName: name }, () =>
      startActiveObservation(name, (observation) => {
        const keep = recordContent()
        const note = ({ input, output, metadata, detail, level }: RunNote) => {
          const meta = { ...metadata, ...(keep ? detail : {}) }
          observation.update({
            ...(level ? { level } : {}),
            ...(Object.keys(meta).length ? { metadata: meta } : {}),
            ...(keep && input !== undefined ? { input } : {}),
            ...(keep && output !== undefined ? { output } : {}),
          })
        }
        return runs.run({ name, note }, fn)
      }),
    ),
  )
}

/**
 * Say something about the run in progress on its root observation; nothing
 * outside a run, and nothing that could fail the work it describes. Input and
 * output are content, kept only while LANGFUSE_RECORD_CONTENT allows.
 */
export function noteRun(note: RunNote): void {
  try {
    runs.getStore()?.note(note)
  } catch (err) {
    console.warn('[telemetry] could not note the run:', describeError(err))
  }
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
  const active = processor()
  if (!active) return
  try {
    await active.forceFlush()
  } catch (err) {
    console.warn('[telemetry] flush failed:', describeError(err))
  }
}
