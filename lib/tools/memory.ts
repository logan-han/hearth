import { tool } from 'ai'
import { z } from 'zod'
import { addMemory, listMemories, deleteMemory } from '../db/queries'
import type { ToolContext } from './context'

export function memoryTools(ctx: ToolContext) {
  return {
    remember: tool({
      description:
        'Store a durable fact about the household so it survives beyond this conversation: routines, preferences, allergies, sizes, "bin night is Monday". ' +
        'Use it proactively, in the same turn a fact appears, without being asked. Not for one-off chatter or anything already known.',
      inputSchema: z.object({
        fact: z.string().describe('One self-contained fact, written so it makes sense months later'),
      }),
      execute: async ({ fact }) => {
        const row = await addMemory(fact, ctx.member?.id ?? null)
        return { id: row.id, stored: fact }
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
      description: 'Delete a stored household fact by id, when it is wrong or no longer true.',
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => {
        await deleteMemory(id)
        return { deleted: id }
      },
    }),
  }
}
