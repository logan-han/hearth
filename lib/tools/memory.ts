import { tool } from 'ai'
import { z } from 'zod'
import { addMemory, listMemories, deleteMemory, askQuestion, answerQuestion } from '../db/queries'
import { rankSimilar, DUPLICATE } from '../memory-match'
import type { ToolContext } from './context'

/** Facts one recall hands back; past this the model is told to narrow it. */
const RECALL_LIMIT = 100

export function memoryTools(ctx: ToolContext) {
  return {
    remember: tool({
      description:
        'Store a durable household fact so it survives beyond this conversation: routines, preferences, allergies, sizes, "bin night is Monday". ' +
        'Use it when someone asks you to remember something or corrects a Known fact; the nightly pass files everything else. ' +
        'A fact that is already Known is not stored again. When the new fact corrects an old one, pass the old id as replaces. ' +
        "Not for anything read in a notice, bill, booking or email, or in the assistant's own posts: put that to the family with unsure instead.",
      inputSchema: z.object({
        fact: z.string().describe('One self-contained fact, written so it makes sense months later'),
        replaces: z.number().int().optional().describe('Id of the Known fact this one supersedes, if any'),
      }),
      execute: async ({ fact, replaces }) => {
        // Quality is cheapest to control at write time: a rewording of a fact
        // already on file is turned away here, before it can crowd the context.
        const existing = await listMemories(500)
        const similar = rankSimilar(fact, existing.filter((m) => m.id !== replaces))
        const top = similar[0]
        if (!replaces && top && top.score >= DUPLICATE) {
          return { stored: false, already_known: { id: top.row.id, fact: top.row.content } }
        }
        const row = await addMemory(fact, ctx.member?.id ?? null, replaces ?? null)
        const overlapping = similar.map((s) => ({ id: s.row.id, fact: s.row.content }))
        return {
          id: row.id,
          stored: fact,
          ...(replaces ? { replaced: replaces } : {}),
          ...(overlapping.length
            ? { possibly_overlapping: overlapping, note: 'If one of these is now out of date, call forget with its id.' }
            : {}),
        }
      },
    }),

    recall: tool({
      description: 'List stored household facts. Useful when you need background the chat history no longer holds.',
      inputSchema: z.object({
        contains: z.string().optional().describe('Optional case-insensitive filter'),
      }),
      execute: async ({ contains }) => {
        // The filter runs over every current fact, not a newest page of them:
        // the oldest facts are often the most basic, and they are the first to
        // drop out of the few dozen the chat already sees.
        const rows = await listMemories(RECALL_LIMIT + 1, contains)
        return {
          memories: rows.slice(0, RECALL_LIMIT).map((m) => ({ id: m.id, fact: m.content })),
          ...(rows.length > RECALL_LIMIT
            ? { note: `Only the newest ${RECALL_LIMIT} are listed. Pass contains to reach older ones.` }
            : {}),
        }
      },
    }),

    forget: tool({
      description: 'Retire a stored household fact by id, when it is wrong or no longer true. It leaves the Known facts but is kept as history.',
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => {
        await deleteMemory(id)
        return { forgotten: id }
      },
    }),

    unsure: tool({
      description:
        'Put a would-be household fact to the family as a question instead of filing it: when the talk does not say who it is about, or it rests on a notice, bill, booking or email rather than on a family member saying so. ' +
        'It is asked once, in the morning brief and on Home, and filed only on a yes.',
      inputSchema: z.object({
        question: z
          .string()
          .describe('The question as the family will read it, e.g. "Who attends <school>? A tuition notice was in <name>\'s mail."'),
        fact: z.string().describe('The fact to file if the answer is yes, self-contained, as remember would take it'),
      }),
      execute: async ({ question, fact }) => {
        // A question about something already Known is not a question.
        const top = rankSimilar(fact, await listMemories(500))[0]
        if (top && top.score >= DUPLICATE) return { asked: false, already_known: { id: top.row.id, fact: top.row.content } }
        const { row, fresh } = await askQuestion({ question, candidate: fact })
        return fresh
          ? { asked: true, question_id: row.id }
          : { asked: false, already_asked: { question_id: row.id, question: row.question } }
      },
    }),

    answer_question: tool({
      description:
        'Settle one of the open questions in your context once a family member answers it. Pass fact for a yes or a correction, written as the fact to keep in their words; leave it out for a no.',
      inputSchema: z.object({
        id: z.number().int(),
        fact: z.string().optional().describe('The fact to keep, in the words of the answer; omit for a no'),
      }),
      execute: async ({ id, fact }) => {
        const settled = await answerQuestion(id, fact?.trim() || null, ctx.member?.id ?? null)
        if (!settled) return { error: `Question ${id} is not open.` }
        if (!settled.memory) return { dismissed: id }
        return {
          kept: settled.memory.content,
          memory_id: settled.memory.id,
          ...(settled.replaced ? { replaced: settled.replaced } : {}),
        }
      },
    }),
  }
}
