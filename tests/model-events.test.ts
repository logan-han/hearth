import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { freshDb, closeDb } from './helpers/db'
import { db, __setDb } from '@/lib/db'
import { recordModelEvent, chainHealth, failureKind, pruneModelEvents } from '@/lib/model-events'
import { withModelFallback, type ModelSlot } from '@/lib/model'

const slot = (name: string): ModelSlot => ({ name, model: {} as ModelSlot['model'] })

let client: PGlite

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  client = (await freshDb()).client
})
afterEach(async () => {
  await closeDb(client)
  vi.restoreAllMocks()
})

describe('model events', () => {
  it('records each attempt the fallback makes, with the purpose and why a slot was skipped', async () => {
    const fn = vi.fn(async (s: ModelSlot) => {
      if (s.name === 'openrouter:minimax/minimax-m3:free') throw new Error('429 Too Many Requests')
      return `from ${s.name}`
    })
    await expect(withModelFallback(fn, [slot('openrouter:minimax/minimax-m3:free'), slot('openrouter:minimax/minimax-m3')], 'hearth.chat'))
      .resolves.toBe('from openrouter:minimax/minimax-m3')

    const health = await chainHealth(7)
    expect(health.calls).toBe(2)
    const free = health.slots.find((s) => s.slot === 'openrouter:minimax/minimax-m3:free')!
    const paid = health.slots.find((s) => s.slot === 'openrouter:minimax/minimax-m3')!
    expect(free).toMatchObject({ answered: 0, failed: 1, reasons: [{ kind: 'rate limited', count: 1 }], medianMs: null })
    expect(paid).toMatchObject({ answered: 1, failed: 0, reasons: [] })
    expect(paid.medianMs).toBeGreaterThanOrEqual(0)
  })

  it('counts replies sent back for an unmade change separately from calls', async () => {
    await recordModelEvent({ slot: 'gemini:x', purpose: 'hearth.chat', outcome: 'answered', ms: 1200 })
    await recordModelEvent({ slot: 'gemini:x', purpose: 'hearth.chat', outcome: 'claim_retry' })
    await recordModelEvent({ slot: 'gemini:x', purpose: 'hearth.chat', outcome: 'answered', ms: 800 })
    const health = await chainHealth(7)
    expect(health.claimRetries).toBe(1)
    expect(health.calls).toBe(2)
    expect(health.slots[0]).toMatchObject({ slot: 'gemini:x', answered: 2, medianMs: 1200 })
  })

  it('folds failure messages into a few kinds, most common first', async () => {
    expect(failureKind('429 quota exceeded')).toBe('rate limited')
    expect(failureKind('The operation timed out')).toBe('timed out')
    expect(failureKind('gemini:x returned no text')).toBe('no reply')
    expect(failureKind('502 Bad Gateway')).toBe('provider error')
    expect(failureKind('401 invalid api key')).toBe('refused')
    expect(failureKind('model does not support tool use')).toBe('tool calling failed')
    expect(failureKind('something odd')).toBe('other')
    expect(failureKind(null)).toBe('other')

    for (const e of ['429', '429 again', 'timed out']) {
      await recordModelEvent({ slot: 's', purpose: 'hearth.gate', outcome: 'failed', error: e })
    }
    const [s] = (await chainHealth(7)).slots
    expect(s.reasons).toEqual([{ kind: 'rate limited', count: 2 }, { kind: 'timed out', count: 1 }])
  })

  it('looks back the asked number of days and prunes what is older than a month', async () => {
    await recordModelEvent({ slot: 'old', purpose: 'hearth.chat', outcome: 'answered', ms: 5 })
    await db().execute(sql`update model_events set created_at = now() - interval '40 days' where slot = 'old'`)
    await recordModelEvent({ slot: 'new', purpose: 'hearth.chat', outcome: 'answered', ms: 5 })
    expect((await chainHealth(7)).slots.map((s) => s.slot)).toEqual(['new'])
    expect((await chainHealth(60)).slots.map((s) => s.slot).sort()).toEqual(['new', 'old'])
    await pruneModelEvents(30)
    expect((await chainHealth(60)).slots.map((s) => s.slot)).toEqual(['new'])
  })

  it('never lets a failed record cost the reply', async () => {
    __setDb(null)
    delete process.env.DATABASE_URL
    await expect(recordModelEvent({ slot: 's', purpose: 'p', outcome: 'answered' })).resolves.toBeUndefined()
    await expect(pruneModelEvents()).resolves.toBeUndefined()
    await expect(withModelFallback(async () => 'still answers', [slot('a')])).resolves.toBe('still answers')
  })
})
