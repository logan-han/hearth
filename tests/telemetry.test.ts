import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { context, ROOT_CONTEXT } from '@opentelemetry/api'
import { telemetryConfigured, recordContent, callTelemetry, traced, traceRun, noteRun, flushTelemetry, setupTelemetry } from '@/lib/telemetry'

/** The processor lives on globalThis, where instrumentation.ts and the routes both find it. */
const slot = globalThis as unknown as { __hearthLangfuse?: { forceFlush: () => Promise<void> } | null }

// setupTelemetry dynamic-imports these on the configured path; mocked so a real
// exporter is never started, rather than registering a process-wide OTel SDK.
const otel = vi.hoisted(() => ({
  registerOTel: vi.fn(),
  LangfuseSpanProcessor: vi.fn(function LangfuseSpanProcessor() {
    return { forceFlush: async () => {} }
  }),
  LangfuseVercelAiSdkIntegration: vi.fn(function LangfuseVercelAiSdkIntegration() {
    return {}
  }),
  registerTelemetry: vi.fn(),
}))
vi.mock('@vercel/otel', () => ({ registerOTel: otel.registerOTel }))
vi.mock('@langfuse/otel', () => ({ LangfuseSpanProcessor: otel.LangfuseSpanProcessor }))
vi.mock('@langfuse/vercel-ai-sdk', () => ({ LangfuseVercelAiSdkIntegration: otel.LangfuseVercelAiSdkIntegration }))
vi.mock('ai', () => ({ registerTelemetry: otel.registerTelemetry }))

// traced() and traceRun() import these once a processor is live; mocked so a
// test sees what would reach Langfuse, not only that the call came back.
const tracing = vi.hoisted(() => {
  const observation = { update: vi.fn() }
  return {
    observation,
    propagateAttributes: vi.fn(async (_attrs: unknown, fn: () => Promise<unknown>) => fn()),
    startActiveObservation: vi.fn((_name: string, fn: (o: typeof observation) => unknown) => fn(observation)),
  }
})
vi.mock('@langfuse/tracing', () => ({ propagateAttributes: tracing.propagateAttributes, startActiveObservation: tracing.startActiveObservation }))

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.LANGFUSE_PUBLIC_KEY
  delete process.env.LANGFUSE_SECRET_KEY
  delete process.env.LANGFUSE_RECORD_CONTENT
  delete process.env.LANGFUSE_TRACING_ENVIRONMENT
  delete process.env.VERCEL_ENV
  slot.__hearthLangfuse = null
})
afterEach(() => {
  slot.__hearthLangfuse = null
  vi.restoreAllMocks()
})

describe('telemetry', () => {
  it('is off without both Langfuse keys', async () => {
    expect(telemetryConfigured()).toBe(false)
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    expect(telemetryConfigured()).toBe(false)
    process.env.LANGFUSE_SECRET_KEY = 'sk'
    expect(telemetryConfigured()).toBe(true)
  })

  it('does nothing at setup without keys, and stays inert', async () => {
    expect(await setupTelemetry()).toBe(false)
    await expect(flushTelemetry()).resolves.toBeUndefined()
  })

  it('runs the wrapped call plainly when tracing is off', async () => {
    let ran = false
    const out = await traced({ traceName: 'x' }, async () => {
      ran = true
      return 42
    })
    expect(out).toBe(42)
    expect(ran).toBe(true)
    expect(tracing.propagateAttributes).not.toHaveBeenCalled()
  })

  it('records content unless told not to', () => {
    expect(recordContent()).toBe(true)
    expect(callTelemetry('hearth.chat')).toEqual({ functionId: 'hearth.chat', recordInputs: true, recordOutputs: true })
    process.env.LANGFUSE_RECORD_CONTENT = 'off'
    expect(callTelemetry('hearth.chat')).toEqual({ functionId: 'hearth.chat', recordInputs: false, recordOutputs: false })
  })

  it('treats an existing processor as already set up, whatever the keys say', async () => {
    slot.__hearthLangfuse = { forceFlush: async () => {} }
    expect(await setupTelemetry()).toBe(true)
  })

  it('registers Langfuse tracing once both keys are set, choosing the environment label in order', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    process.env.LANGFUSE_SECRET_KEY = 'sk'

    expect(await setupTelemetry()).toBe(true)
    expect(otel.LangfuseSpanProcessor).toHaveBeenLastCalledWith(expect.objectContaining({ environment: 'development' }))
    expect(otel.registerOTel).toHaveBeenLastCalledWith(expect.objectContaining({ serviceName: 'hearth' }))
    expect(otel.registerTelemetry).toHaveBeenCalledTimes(1)
    // The AI SDK reports its own calls through Langfuse's integration, not some other.
    expect(otel.registerTelemetry.mock.calls[0][0]).toBe(otel.LangfuseVercelAiSdkIntegration.mock.results[0].value)
    expect(slot.__hearthLangfuse).toBeTruthy()

    slot.__hearthLangfuse = null
    process.env.VERCEL_ENV = 'preview'
    await setupTelemetry()
    expect(otel.LangfuseSpanProcessor).toHaveBeenLastCalledWith(expect.objectContaining({ environment: 'preview' }))

    // The empty line .env.example ships is no label.
    slot.__hearthLangfuse = null
    process.env.LANGFUSE_TRACING_ENVIRONMENT = ''
    await setupTelemetry()
    expect(otel.LangfuseSpanProcessor).toHaveBeenLastCalledWith(expect.objectContaining({ environment: 'preview' }))

    slot.__hearthLangfuse = null
    process.env.LANGFUSE_TRACING_ENVIRONMENT = 'staging'
    await setupTelemetry()
    expect(otel.LangfuseSpanProcessor).toHaveBeenLastCalledWith(expect.objectContaining({ environment: 'staging' }))
  })

  it('flushes the processor at the end of a run, and only warns when that fails', async () => {
    const forceFlush = vi.fn(async () => {})
    slot.__hearthLangfuse = { forceFlush }
    await flushTelemetry()
    expect(forceFlush).toHaveBeenCalledTimes(1)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    slot.__hearthLangfuse = { forceFlush: async () => { throw new Error('exporter down') } }
    await expect(flushTelemetry()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[telemetry] flush failed:', 'exporter down')
  })

  it('propagates trace attributes around the call once a processor is live', async () => {
    slot.__hearthLangfuse = { forceFlush: async () => {} }
    let inside = false
    tracing.propagateAttributes.mockImplementationOnce(async (_attrs, fn) => {
      inside = true
      try {
        return await fn()
      } finally {
        inside = false
      }
    })
    const attrs = { traceName: 'hearth.test', sessionId: 's1', userId: '111' }
    let ranInside = false
    const out = await traced(attrs, async () => {
      ranInside = inside
      return 'traced'
    })
    expect(out).toBe('traced')
    // The call itself runs within the attributes, so every span it opens carries them.
    expect(ranInside).toBe(true)
    expect(tracing.propagateAttributes).toHaveBeenCalledWith(attrs, expect.any(Function))
  })

  it('reads the content switch case- and space-insensitively', () => {
    process.env.LANGFUSE_RECORD_CONTENT = ' OFF '
    expect(recordContent()).toBe(false)
    process.env.LANGFUSE_RECORD_CONTENT = 'anything else'
    expect(recordContent()).toBe(true)
  })
})

describe('runs', () => {
  const live = () => {
    slot.__hearthLangfuse = { forceFlush: async () => {} }
  }

  it('does the work plainly when tracing is off, and a note then goes nowhere', async () => {
    const out = await traceRun('hearth.chat', { sessionId: 's1' }, async () => {
      noteRun({ input: 'hello', output: 'hi' })
      return 'answered'
    })
    expect(out).toBe('answered')
    expect(tracing.startActiveObservation).not.toHaveBeenCalled()
    expect(tracing.propagateAttributes).not.toHaveBeenCalled()
  })

  it('opens a trace of its own, named once, and notes what came of it on its root', async () => {
    live()
    const withContext = vi.spyOn(context, 'with')
    const out = await traceRun('hearth.watcher', { sessionId: '-100', tags: ['watcher'] }, async () => {
      noteRun({ input: 'DATA', metadata: { writer: 'gemini:flash-lite' } })
      noteRun({ output: 'Bins out tonight.', metadata: { outcome: 'held back' }, detail: { reason: 'a time' }, level: 'WARNING' })
      return 7
    })
    expect(out).toBe(7)
    // A root context: the run is not one more part of the request that ran it.
    expect(withContext.mock.calls[0][0]).toBe(ROOT_CONTEXT)
    expect(tracing.propagateAttributes).toHaveBeenCalledWith({ sessionId: '-100', tags: ['watcher'], traceName: 'hearth.watcher' }, expect.any(Function))
    expect(tracing.startActiveObservation).toHaveBeenCalledWith('hearth.watcher', expect.any(Function))
    expect(tracing.observation.update).toHaveBeenNthCalledWith(1, { metadata: { writer: 'gemini:flash-lite' }, input: 'DATA' })
    expect(tracing.observation.update).toHaveBeenNthCalledWith(2, {
      level: 'WARNING', metadata: { outcome: 'held back', reason: 'a time' }, output: 'Bins out tonight.',
    })
  })

  it('keeps the family\'s words out of a run when content is off, and its shape in', async () => {
    live()
    process.env.LANGFUSE_RECORD_CONTENT = 'off'
    await traceRun('hearth.chat', {}, async () => {
      noteRun({ input: 'my payslip', output: 'filed', metadata: { outcome: 'posted' }, detail: { reason: 'quotes the draft' } })
      noteRun({ input: 'only content' })
    })
    expect(tracing.observation.update).toHaveBeenNthCalledWith(1, { metadata: { outcome: 'posted' } })
    expect(tracing.observation.update).toHaveBeenNthCalledWith(2, {})
  })

  it('names the trace for the run, whatever a call inside it calls itself', async () => {
    live()
    await traceRun('hearth.chat', { sessionId: 's1' }, () => traced({ traceName: 'hearth.claim', sessionId: 's1', tags: ['claim'] }, async () => 'checked'))
    expect(tracing.propagateAttributes).toHaveBeenLastCalledWith({ traceName: 'hearth.chat', sessionId: 's1', tags: ['claim'] }, expect.any(Function))
    // Outside a run a call names its own trace, as before.
    await traced({ traceName: 'hearth.gate' }, async () => 'quiet')
    expect(tracing.propagateAttributes).toHaveBeenLastCalledWith({ traceName: 'hearth.gate' }, expect.any(Function))
  })

  it('cuts a metadata value Langfuse would drop for its length, rather than lose it', async () => {
    live()
    const label = 'x'.repeat(250)
    await traced({ traceName: 'hearth.decision', metadata: { label, model: 'g' } }, async () => 'ok')
    expect(tracing.propagateAttributes).toHaveBeenLastCalledWith({ traceName: 'hearth.decision', metadata: { label: 'x'.repeat(200), model: 'g' } }, expect.any(Function))
    await traceRun('hearth.watcher', { metadata: { label } }, async () => 'ok')
    expect(tracing.propagateAttributes).toHaveBeenLastCalledWith({ traceName: 'hearth.watcher', metadata: { label: 'x'.repeat(200) } }, expect.any(Function))
  })

  it('never lets a note fail the work it describes', async () => {
    live()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    tracing.observation.update.mockImplementationOnce(() => {
      throw new Error('span already ended')
    })
    await expect(traceRun('hearth.sweep', {}, async () => {
      noteRun({ output: 'SKIP' })
      return 'done'
    })).resolves.toBe('done')
    expect(warn).toHaveBeenCalledWith('[telemetry] could not note the run:', 'span already ended')
  })

  it('does the work once, untraced, when the tracing modules will not load', async () => {
    vi.resetModules()
    vi.doMock('@opentelemetry/api', () => {
      throw new Error('cannot load the OpenTelemetry API')
    })
    try {
      const fresh = await import('@/lib/telemetry')
      live()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const work = vi.fn(async () => 'done')
      await expect(fresh.traceRun('hearth.chat', {}, work)).resolves.toBe('done')
      expect(work).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith('[telemetry] run not traced:', expect.any(String))
    } finally {
      vi.doUnmock('@opentelemetry/api')
      vi.resetModules()
    }
  })
})
