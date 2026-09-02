import { generateText, Output } from 'ai'
import { z } from 'zod'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { geminiSlots, openrouterSlots } from '@/lib/model'

/* ------------------------------------------------------- deterministic */

const MONEY = /\$\s?\d[\d,]*(?:\.\d{2})?/g
const norm = (s: string) => s.replace(/[\s,]/g, '')

/** Every dollar figure in the reply must appear somewhere in what the tools returned. */
export function figuresGrounded(text: string, context: string): { ok: boolean; missing: string[] } {
  const have = new Set((context.match(MONEY) ?? []).map(norm))
  const missing = [...new Set((text.match(MONEY) ?? []).map(norm))].filter((f) => !have.has(f))
  return { ok: missing.length === 0, missing }
}

/** Working shown, or a thinking block, in what the family would read. */
const LEAK = /<think>|\b(?:now|and now|here(?:'s| is)) (?:the |my )?(?:post|answer|reply|summary|brief)\s*:|^\s*(?:okay|ok|alright|let me|first,? i(?:'ll| will)?)\b/im
export const noLeak = (text: string) => !LEAK.test(text)

/** A place, trip or plan read into a payee string. */
export const TRIP_TALK = /\b(?:trip|flights?|holiday|travel(?:l?ing)?|book(?:ed|ing)?\s+(?:a|the|flights?|to)|going to seattle|in seattle)\b/i

/** A clock time or a dated weekday, which a reply about an unknown appointment must not contain. */
export const CLOCK_TIME = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i

/* ------------------------------------------------------------- judges */

type Judge = { name: string; model: LanguageModel }

/**
 * Judges are deliberately not from the Gemini family that answers most of
 * Hearth's turns, because judges favour their own family: OpenRouter's paid
 * MiniMax slot leads, Gemini is the fallback when it is down, and
 * EVAL_JUDGE_MODEL=provider:model pins one. A judge that fails is a missing
 * score, never a failed case; the deterministic checks carry the verdict.
 */
export function judgeCandidates(): Judge[] {
  const explicit = process.env.EVAL_JUDGE_MODEL
  if (explicit) {
    const [provider, ...rest] = explicit.split(':')
    const id = rest.join(':')
    if (provider === 'gemini') {
      const slot = geminiSlots().find((s) => s.name.endsWith(`:${id}`))
      if (slot) return [slot]
    }
    if (provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
      const p = createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        supportsStructuredOutputs: true,
      })
      return [{ name: `openrouter:${id}`, model: p(id) }]
    }
    throw new Error(`EVAL_JUDGE_MODEL=${explicit} is not a configured provider`)
  }
  const candidates: Judge[] = []
  const openrouter = openrouterSlots()
  if (openrouter.length) candidates.push(openrouter.at(-1)!)
  const gemini = geminiSlots()
  if (gemini.length) candidates.push(gemini.at(-1)!)
  return candidates
}

async function withJudge<T>(fn: (judge: Judge) => Promise<T>): Promise<(T & { judge: string }) | null> {
  for (const judge of judgeCandidates()) {
    try {
      return { ...(await fn(judge)), judge: judge.name }
    } catch (err) {
      console.warn(`[evals] judge ${judge.name} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
  }
  console.warn('[evals] no judge could score this case; deterministic checks only')
  return null
}

const groundednessSchema = z.object({
  claims: z.array(
    z.object({
      text: z.string(),
      supported: z.boolean().describe('true only if the sources state this'),
    }),
  ),
})

/**
 * FACTS-style: split the reply into information-bearing claims and decide
 * each one against the sources only. Hedges and statements of what is not
 * known are not claims, so "purpose not recorded" is never penalised.
 */
export async function judgeGroundedness(input: { answer: string; context: string }) {
  const out = await withJudge(async (judge) => {
    const r = await generateText({
      model: judge.model,
      system: [
        "You grade a family assistant's reply against the sources it had.",
        'Extract each information-bearing claim in the reply: names, figures, dates, purposes, events, where something is.',
        'Mark supported true only if the sources state it. Do not use outside knowledge and do not give credit for plausibility.',
        'Hedges, offers to look something up, questions back to the person, and statements of what is not known are not claims and must be left out.',
      ].join(' '),
      prompt: `SOURCES:\n${input.context}\n\nREPLY:\n${input.answer}`,
      output: Output.object({ schema: groundednessSchema, name: 'groundedness' }),
      temperature: 0,
      // Thinking models spend output tokens before the object; leave them room.
      maxOutputTokens: 2000,
    })
    const claims = r.output.claims
    const unsupported = claims.filter((c) => !c.supported).map((c) => c.text)
    return { score: claims.length === 0 ? 1 : (claims.length - unsupported.length) / claims.length, claims: claims.length, unsupported }
  })
  return out ?? { score: undefined, claims: 0, unsupported: [] as string[], judge: 'unavailable' }
}

const usefulnessSchema = z.object({
  useful: z.enum(['yes', 'partly', 'no']),
  reason: z.string(),
})

/** Groundedness alone rewards evasive replies, so usefulness is scored separately. */
export async function judgeUsefulness(input: { task: string; answer: string }) {
  const out = await withJudge(async (judge) => {
    const r = await generateText({
      model: judge.model,
      system:
        'You grade whether a family assistant did the job it was asked, in a Telegram chat. ' +
        'yes: the person got what they needed, or a clear statement of what is not known plus a sensible next step. ' +
        'partly: something useful but incomplete or padded. no: unhelpful, evasive without reason, or off the point.',
      prompt: `TASK:\n${input.task}\n\nREPLY:\n${input.answer}`,
      output: Output.object({ schema: usefulnessSchema, name: 'usefulness' }),
      temperature: 0,
      maxOutputTokens: 1000,
    })
    return { score: r.output.useful === 'yes' ? 1 : r.output.useful === 'partly' ? 0.5 : 0, reason: r.output.reason }
  })
  return out ?? { score: undefined, reason: 'judge unavailable', judge: 'unavailable' }
}

/* ------------------------------------------------------------ summary */

export type Score = { case: string; hard: 'pass' | 'fail'; groundedness?: number; usefulness?: number; model?: string; note?: string }
const scores: Score[] = []
export const record = (s: Score) => scores.push(s)

export function printSummary(title: string) {
  if (scores.length === 0) return
  const rows = scores.splice(0)
  const line = (s: Score) =>
    `${s.hard === 'pass' ? 'PASS' : 'FAIL'}  ${s.case.padEnd(44)} g=${s.groundedness === undefined ? ' -  ' : s.groundedness.toFixed(2)} u=${s.usefulness === undefined ? ' -  ' : s.usefulness.toFixed(2)}  ${s.model ?? ''}${s.note ? `  ${s.note}` : ''}`
  console.log(`\n== ${title} ==\n${rows.map(line).join('\n')}\n`)
}

/** Soft thresholds fail the run only when EVAL_STRICT is set; otherwise they are reported. */
export const strict = () => process.env.EVAL_STRICT === '1'
