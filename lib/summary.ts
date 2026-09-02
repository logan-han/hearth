import { generateText } from 'ai'
import { withModelFallback } from './model'
import { chatSummary, setChatSummary, messagesAfter, CONTEXT_WINDOW } from './db/queries'
import { traced, callTelemetry } from './telemetry'
import { cleanReply } from './agent'

/**
 * The rolling summary of a chat. The model sees the newest messages verbatim
 * and everything older as this summary, so a fact from last week is still in
 * reach without dragging the whole transcript into every call. It is updated
 * after the reply has gone out, once enough older talk has piled up.
 */

/** Older messages that must be waiting before a summary run is worth a call. */
export const SUMMARISE_BATCH = 6
const MESSAGE_CHARS = 500

const SUMMARY_PROMPT = [
  'You keep the running summary of one family chat for an assistant that will read it later.',
  'FOLD the new messages into the summary so it stays one short account of what has been said.',
  'KEEP: names, dates, times, amounts, places, decisions, requests still open, and corrections, where the newest statement wins.',
  'DROP: greetings, reactions, chatter, and anything the assistant itself said unless it was a commitment or a fact it looked up.',
  'NEVER add anything the messages do not say, and never guess at a purpose, place or plan.',
  'FORMAT: plain lines, under 150 words, oldest first. Reply with the summary alone.',
].join('\n')

/**
 * Summarise whatever is older than the raw window and not yet covered, if
 * there is enough of it. Returns whether a summary was written.
 */
export async function maybeSummarise(chatId: string): Promise<boolean> {
  const current = await chatSummary(chatId)
  const rows = await messagesAfter(chatId, current.through)
  const older = rows.slice(0, Math.max(0, rows.length - CONTEXT_WINDOW))
  if (older.length < SUMMARISE_BATCH) return false

  const transcript = older
    .map((m) => `${m.role === 'assistant' ? 'Hearth' : (m.authorName ?? 'Someone')}: ${m.content.slice(0, MESSAGE_CHARS)}`)
    .join('\n')

  const text = await withModelFallback((slot) =>
    traced({ traceName: 'hearth.summary', sessionId: chatId, tags: ['summary'], metadata: { model: slot.name } }, () =>
      generateText({
        model: slot.model,
        system: SUMMARY_PROMPT,
        prompt: `${current.summary ? `RUNNING SUMMARY SO FAR:\n${current.summary}\n\n` : ''}NEW MESSAGES TO FOLD IN:\n${transcript}`,
        temperature: 0.2,
        maxOutputTokens: 500,
        timeout: { stepMs: 30_000 },
        telemetry: callTelemetry('hearth.summary'),
      }),
    ).then((r) => {
      const cleaned = cleanReply(r.text).text
      if (!cleaned) throw new Error(`${slot.name} returned no summary`)
      return cleaned
    }),
  )

  await setChatSummary(chatId, text, older[older.length - 1].id)
  return true
}
