import { and, desc, gte, inArray, lt, sql } from 'drizzle-orm'
import { db } from './db'
import { modelEvents } from './db/schema'

/**
 * What the chain actually did, call by call. Everything here is best effort:
 * a record that cannot be written must never cost the reply it describes.
 */
export type ModelOutcome = 'answered' | 'failed' | 'claim_retry'

export async function recordModelEvent(event: {
  slot: string
  purpose: string
  outcome: ModelOutcome
  ms?: number
  error?: string | null
}): Promise<void> {
  try {
    await db().insert(modelEvents).values({
      slot: event.slot,
      purpose: event.purpose,
      outcome: event.outcome,
      ms: Math.max(0, Math.round(event.ms ?? 0)),
      error: event.error ? event.error.slice(0, 300) : null,
    })
  } catch (err) {
    console.warn('[model] could not record an event:', err instanceof Error ? err.message : err)
  }
}

/** A structured call answered with prose, markdown or reasoning instead of the object asked for. */
const NO_OBJECT = /no object generated|no output generated|could not parse/i

/** Why a slot was skipped, in the few words the System page can show. */
export function failureKind(error: string | null | undefined): string {
  const e = error ?? ''
  if (/429|rate.?limit|quota|too many requests/i.test(e)) return 'rate limited'
  if (/timed? ?out|timeout|aborted/i.test(e)) return 'timed out'
  if (NO_OBJECT.test(e)) return 'no object'
  if (/returned no text/i.test(e)) return 'no reply'
  if (/5\d\d|unavailable|overloaded|internal/i.test(e)) return 'provider error'
  if (/401|403|api key|unauthori[sz]ed/i.test(e)) return 'refused'
  if (/tool|function/i.test(e)) return 'tool calling failed'
  return 'other'
}

export type SlotHealth = {
  slot: string
  answered: number
  failed: number
  /** Failure kinds with counts, most common first. */
  reasons: { kind: string; count: number }[]
  /** Median time to answer, or null when it never did. */
  medianMs: number | null
}

export type ChainHealth = {
  days: number
  slots: SlotHealth[]
  /** Chat replies sent back for reporting a change no tool made. */
  claimRetries: number
  calls: number
}

/** The last `days` days of events, folded per slot. */
export async function chainHealth(days = 7, now: Date = new Date()): Promise<ChainHealth> {
  const since = new Date(now.getTime() - days * 86_400_000)
  const rows = await db()
    .select({ slot: modelEvents.slot, outcome: modelEvents.outcome, ms: modelEvents.ms, error: modelEvents.error })
    .from(modelEvents)
    .where(gte(modelEvents.createdAt, since))
    .orderBy(desc(modelEvents.createdAt))
    .limit(20_000)

  const bySlot = new Map<string, { answered: number[]; failed: Map<string, number> }>()
  let claimRetries = 0
  let calls = 0
  for (const r of rows) {
    if (r.outcome === 'claim_retry') {
      claimRetries++
      continue
    }
    calls++
    const s = bySlot.get(r.slot) ?? { answered: [] as number[], failed: new Map<string, number>() }
    if (r.outcome === 'answered') s.answered.push(r.ms)
    else {
      const kind = failureKind(r.error)
      s.failed.set(kind, (s.failed.get(kind) ?? 0) + 1)
    }
    bySlot.set(r.slot, s)
  }

  const slots: SlotHealth[] = [...bySlot].map(([slot, s]) => {
    const sorted = [...s.answered].sort((a, b) => a - b)
    return {
      slot,
      answered: s.answered.length,
      failed: [...s.failed.values()].reduce((a, b) => a + b, 0),
      reasons: [...s.failed].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
      medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    }
  })
  return { days, slots, claimRetries, calls }
}

/** Keep a month. Older rows say nothing about the chain as it is now. */
export async function pruneModelEvents(days = 30, now: Date = new Date()): Promise<void> {
  try {
    await db().delete(modelEvents).where(and(lt(modelEvents.createdAt, new Date(now.getTime() - days * 86_400_000)), sql`true`))
  } catch (err) {
    console.warn('[model] could not prune events:', err instanceof Error ? err.message : err)
  }
}

/** The calls that ask for an object or a choice back rather than prose. */
export const STRUCTURED_PURPOSES = ['hearth.verify', 'hearth.decision', 'hearth.gate', 'hearth.claim'] as const

export type StructuredRecord = Map<string, { attempts: number; noObject: number }>

/**
 * How each slot has fared when asked for an object over the last `days`:
 * answers, and failures to produce one. Other failures (a rate limit, a
 * timeout) say nothing about structured output and are left out. Best effort:
 * a record that cannot be read is an empty one, and the chain runs as configured.
 */
export async function structuredRecord(days = 3, now: Date = new Date()): Promise<StructuredRecord> {
  const record: StructuredRecord = new Map()
  try {
    const since = new Date(now.getTime() - days * 86_400_000)
    const rows = await db()
      .select({ slot: modelEvents.slot, outcome: modelEvents.outcome, error: modelEvents.error })
      .from(modelEvents)
      .where(and(gte(modelEvents.createdAt, since), inArray(modelEvents.purpose, [...STRUCTURED_PURPOSES])))
      .limit(20_000)
    for (const r of rows) {
      const noObject = r.outcome === 'failed' && NO_OBJECT.test(r.error ?? '')
      if (r.outcome !== 'answered' && !noObject) continue
      const s = record.get(r.slot) ?? { attempts: 0, noObject: 0 }
      s.attempts++
      if (noObject) s.noObject++
      record.set(r.slot, s)
    }
  } catch (err) {
    console.warn('[model] could not read the structured-output record:', err instanceof Error ? err.message : err)
  }
  return record
}
