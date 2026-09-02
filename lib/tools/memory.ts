import { tool } from 'ai'
import { z } from 'zod'
import { addMemory, listMemories, deleteMemory } from '../db/queries'
import { rankSimilar, DUPLICATE } from '../memory-match'
import type { ToolContext } from './context'

export function memoryTools(ctx: ToolContext) {
  return {
    remember: tool({
      description:
        'Store a durable household fact so it survives beyond this conversation: routines, preferences, allergies, sizes, "bin night is Monday". ' +
        'Use it when someone asks you to remember something or corrects a Known fact; the nightly pass files everything else. ' +
        'A fact that is already Known is not stored again. When the new fact corrects an old one, pass the old id as replaces.',
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
        const rows = await listMemories()
        const needle = contains?.toLowerCase()
        return {
          memories: rows
            .filter((m) => !needle || m.content.toLowerCase().includes(needle))
            .map((m) => ({ id: m.id, fact: m.content })),
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
  }
}
