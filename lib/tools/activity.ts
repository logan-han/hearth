import { tool } from 'ai'
import { z } from 'zod'
import { recentActivity } from '../db/queries'
import { formatLocal } from '../cron'
import type { ToolContext } from './context'
import { requireMember } from './context'

const VIA_WORDS: Record<string, string> = {
  watcher: 'on a schedule',
  mcp: 'through an MCP client',
  web: 'on Home',
}

/** A logged change as a caller is shown it. */
export function activityLine(a: { createdAt: Date; who: string | null; via: string; summary: string }): string {
  return `${formatLocal(a.createdAt)}: ${a.summary} (${a.who ?? 'Hearth'}, ${VIA_WORDS[a.via] ?? a.via})`
}

export function activityTools(ctx: ToolContext) {
  return {
    recent_activity: tool({
      description:
        'What Hearth has changed in your name lately, newest first: every calendar entry, list item, reminder, fact, draft and ticket made or changed through ' +
        'your MCP clients, on Home or by your scheduled jobs, with how and when. Use it for "what have you done today", "did you add the dentist", ' +
        'and before saying whether something was done.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(15),
      }),
      execute: async ({ limit }) => {
        // Your own record alone: another member's drafts and calendar are theirs to look back over.
        const rows = await recentActivity({ memberId: requireMember(ctx).id, limit })
        return rows.length
          ? { activity: rows.map((r) => activityLine(r)) }
          : { activity: [], note: 'Nothing has been changed in your name yet, or not in the last ninety days.' }
      },
    }),
  }
}
