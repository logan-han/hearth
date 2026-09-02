import { describe, it, expect, beforeEach } from 'vitest'
import { telemetryConfigured, recordContent, callTelemetry, traced, flushTelemetry, setupTelemetry } from '@/lib/telemetry'

beforeEach(() => {
  delete process.env.LANGFUSE_PUBLIC_KEY
  delete process.env.LANGFUSE_SECRET_KEY
  delete process.env.LANGFUSE_RECORD_CONTENT
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
})
