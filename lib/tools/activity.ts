import { tool } from 'ai'
import { z } from 'zod'
import { recentActivity } from '../db/queries'
import { formatLocal } from '../cron'
import type { ToolContext } from './context'

const VIA_WORDS: Record<string, string> = {
  chat: 'asked in the chat',
  watcher: 'on a schedule',
  sweep: 'in the nightly memory pass',
  mcp: 'through an MCP client',
  web: 'on Home',
}

/** A logged change as the model is shown it, and as /activity lists it. */
export function activityLine(a: { createdAt: Date; who: string | null; via: string; summary: string }): string {
  const who = a.who ?? (a.via === 'chat' || a.via === 'mcp' ? 'someone' : 'Hearth')
  return `${formatLocal(a.createdAt)}: ${a.summary} (${who}, ${VIA_WORDS[a.via] ?? a.via})`
}

export function activityTools(ctx: ToolContext) {
  return {
    recent_activity: tool({
      description:
        'What has been changed in this chat lately, newest first: every calendar entry, list item, reminder, fact, draft and ticket the bot made or changed, with who asked and when. ' +
        'Use it for "what have you done today", "did you add the dentist", "who put that on the list", and before saying whether something was done.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(15),
      }),
      execute: async ({ limit }) => {
        // This chat's alone: another chat's drafts and personal calendar are its own business.
        const rows = await recentActivity({ chatId: ctx.chatId, limit })
        return rows.length
          ? { activity: rows.map((r) => activityLine(r)) }
          : { activity: [], note: 'Nothing has been changed in this chat yet, or not in the last ninety days.' }
      },
    }),
  }
}
