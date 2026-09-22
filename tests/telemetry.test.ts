import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { telemetryConfigured, recordContent, callTelemetry, traced, observed, flushTelemetry, setupTelemetry } from '@/lib/telemetry'

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

beforeEach(() => {
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
    expect(slot.__hearthLangfuse).toBeTruthy()

    slot.__hearthLangfuse = null
    process.env.VERCEL_ENV = 'preview'
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
    const out = await traced({ traceName: 'hearth.test', sessionId: 's1' }, async () => 'traced')
    expect(out).toBe('traced')
  })

  it('runs a hand-made observation plainly when tracing is off, without summarising', async () => {
    const summarise = vi.fn(() => ({ output: 'never' }))
    expect(await observed('hearth.gate', { model: 'jev-latest', input: { state: 's' } }, async () => 7, summarise)).toBe(7)
    expect(summarise).not.toHaveBeenCalled()
  })

  it('records a hand-made observation with its output and usage once a processor is live, keeping content on the switch', async () => {
    slot.__hearthLangfuse = { forceFlush: async () => {} }
    const summarise = vi.fn((out: number) => ({ output: { got: out }, usage: { input: 12, output: 0 } }))
    expect(await observed('hearth.gate', { model: 'jev-latest', input: { state: 's' } }, async () => 7, summarise)).toBe(7)
    expect(summarise).toHaveBeenCalledWith(7)
    process.env.LANGFUSE_RECORD_CONTENT = 'off'
    expect(await observed('hearth.gate', { model: 'jev-latest', input: { state: 's' } }, async () => 8, summarise)).toBe(8)
    // A failure inside the call is the caller's to handle, not swallowed by the observation.
    await expect(observed('hearth.gate', { model: 'jev-latest', input: null }, async () => { throw new Error('down') }, summarise)).rejects.toThrow('down')
  })

  it('omits usage details when the summary does not report any', async () => {
    slot.__hearthLangfuse = { forceFlush: async () => {} }
    const summarise = vi.fn(() => ({ output: 'ok' }))
    await expect(observed('hearth.gate', { model: 'jev-latest', input: {} }, async () => 1, summarise)).resolves.toBe(1)
    expect(summarise).toHaveBeenCalledWith(1)
  })

  it('reads the content switch case- and space-insensitively', () => {
    process.env.LANGFUSE_RECORD_CONTENT = ' OFF '
    expect(recordContent()).toBe(false)
    process.env.LANGFUSE_RECORD_CONTENT = 'anything else'
    expect(recordContent()).toBe(true)
  })
})
