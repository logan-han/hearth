import { tool } from 'ai'
import { z } from 'zod'
import {
  addAutomation,
  listAutomations,
  deleteAutomation,
  setAutomationEnabled,
  getAutomation,
} from '../db/queries'
import { nextRun, isValidCron, formatLocal } from '../cron'
import { timezone } from '../env'
import type { ToolContext } from './context'

export function automationTools(ctx: ToolContext) {
  return {
    create_automation: tool({
      description:
        `Schedule a recurring instruction that runs on its own and posts to this chat. Times are ${timezone()}. ` +
        'Examples: "every Monday 7pm remind us to put the bins out" -> cron "0 19 * * 1"; ' +
        '"weekday mornings at 7am summarise today" -> "0 7 * * 1-5".',
      inputSchema: z.object({
        label: z.string().describe('Short name, e.g. "bin night"'),
        cron: z
          .string()
          .describe('Standard 5-field cron: minute hour day-of-month month day-of-week (0=Sunday)'),
        instruction: z
          .string()
          .describe('What to do when it fires, written as an instruction to yourself'),
      }),
      execute: async ({ label, cron, instruction }) => {
        if (!isValidCron(cron)) return { error: `"${cron}" is not a valid 5-field cron expression.` }
        const next = nextRun(cron)
        if (!next) return { error: `"${cron}" will never fire again.` }

        const row = await addAutomation({
          chatId: ctx.chatId,
          memberId: ctx.member?.id ?? null,
          label,
          cronExpr: cron,
          instruction,
          nextRunAt: next,
        })
        return { id: row.id, label, cron, next_run_local: formatLocal(next), timezone: timezone() }
      },
    }),

    list_automations: tool({
      description: 'List the scheduled automations for this chat.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listAutomations(ctx.chatId)
        return {
          timezone: timezone(),
          automations: rows.map((a) => ({
            id: a.id,
            label: a.label,
            cron: a.cronExpr,
            instruction: a.instruction,
            enabled: a.enabled,
            next_run_local: a.enabled ? formatLocal(a.nextRunAt) : null,
          })),
        }
      },
    }),

    delete_automation: tool({
      description: 'Permanently delete a scheduled automation by id.',
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) =>
        (await deleteAutomation(id)) ? { deleted: id } : { error: `No automation ${id}.` },
    }),

    pause_automation: tool({
      description: 'Pause or resume a scheduled automation without deleting it.',
      inputSchema: z.object({ id: z.number().int(), enabled: z.boolean() }),
      execute: async ({ id, enabled }) => {
        const existing = await getAutomation(id)
        if (!existing) return { error: `No automation ${id}.` }
        // A paused automation's next_run_at goes stale, so recompute on resume.
        const next = enabled ? nextRun(existing.cronExpr) : null
        const row = await setAutomationEnabled(id, enabled, next ?? undefined)
        if (!row) return { error: `No automation ${id}.` }
        return { id, enabled, next_run_local: next ? formatLocal(next) : null }
      },
    }),
  }
}
