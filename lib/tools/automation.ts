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
import { tickGrid, fitsGrid, suggestAligned, describeGrid } from '../scheduler'
import { timezone } from '../env'
import { isBuiltinKind } from '../watchers'
import type { ToolContext } from './context'

export function automationTools(ctx: ToolContext) {
  return {
    create_automation: tool({
      description:
        `Schedule a recurring instruction that runs on its own and posts to this chat. Times are ${timezone()}. ` +
        'It fires only when the scheduler ticks, normally hourly on the hour, so put 0 in the minute field; ' +
        'a cron that would not land on a tick is refused, with the nearest one that does. ' +
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

        // An automation fires at the first tick on or after its time, so a
        // schedule the ticks cannot land on would quietly run late, or, if
        // finer than the ticks, at their pace. Refuse it while the request is
        // still a conversation, with the nearest schedule that would work.
        const grid = await tickGrid()
        const fit = grid ? fitsGrid(grid, cron, ctx.now) : null
        if (grid && fit && !fit.fits) {
          const suggestion = suggestAligned(grid, cron, ctx.now)
          return {
            error:
              `The scheduler runs ${describeGrid(grid)}, and a schedule only fires on one of its ticks: ` +
              `"${cron}" is first due ${formatLocal(fit.due)} but would not run until ${formatLocal(fit.runs)}.` +
              (suggestion ? ` The nearest schedule that lines up is "${suggestion}"; offer it, or ask for a time on a tick.` : ' Ask for a time on a tick.'),
            scheduler: describeGrid(grid),
            ...(suggestion ? { suggestion } : {}),
          }
        }

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
        const [rows, grid] = await Promise.all([listAutomations(ctx.chatId), tickGrid()])
        return {
          timezone: timezone(),
          /** When these can fire at all; null until the scheduler has shown its cadence. */
          scheduler: grid ? describeGrid(grid) : null,
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
      description:
        'Permanently delete a scheduled automation by id. The built-in watchers (the morning brief, the money snapshot) cannot be deleted, only paused.',
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => {
        const existing = await getAutomation(id)
        // Only this chat's, the ones list_automations shows: another chat's is
        // someone else's to manage, there or from the admin pages.
        if (existing?.chatId !== ctx.chatId) return { error: `No automation ${id} in this chat.` }
        // Built in means the tick would only put it back; a pause is the off switch.
        if (isBuiltinKind(existing.kind)) {
          return { error: `"${existing.label}" is built in and cannot be deleted. Pause it with pause_automation if it is not wanted.` }
        }
        return (await deleteAutomation(id)) ? { deleted: id } : { error: `No automation ${id}.` }
      },
    }),

    pause_automation: tool({
      description: 'Pause or resume a scheduled automation without deleting it.',
      inputSchema: z.object({ id: z.number().int(), enabled: z.boolean() }),
      execute: async ({ id, enabled }) => {
        const existing = await getAutomation(id)
        if (existing?.chatId !== ctx.chatId) return { error: `No automation ${id} in this chat.` }
        // A paused automation's next_run_at goes stale, so recompute on resume.
        const next = enabled ? nextRun(existing.cronExpr) : null
        const row = await setAutomationEnabled(id, enabled, next ?? undefined)
        if (!row) return { error: `No automation ${id}.` }
        return { id, enabled, next_run_local: next ? formatLocal(next) : null }
      },
    }),
  }
}
