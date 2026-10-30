import { tool } from 'ai'
import { z } from 'zod'
import {
  addAutomation,
  listAutomations,
  deleteAutomation,
  setAutomationEnabled,
  getAutomation,
  REPEATS,
  type Repeat,
} from '../db/queries'
import { nextRun, isValidCron, formatLocal, localToUtc, cronAt } from '../cron'
import { tickGrid, fitsGrid, suggestAligned, describeGrid } from '../scheduler'
import { timezone } from '../env'
import { isBuiltinKind } from '../watchers'
import type { Automation } from '../db/schema'
import type { ToolContext } from './context'

/** How each way of repeating reads in a listing. */
export const REPEAT_WORDS: Record<Repeat, string> = {
  always: 'on its schedule',
  once: 'once, then it is gone',
  until: 'until it finds what it is waiting for, then it is gone',
}

/**
 * When a cron first fires, or why it cannot be used as it stands: one that
 * does not parse, never fires, or would not land on one of the scheduler's
 * ticks. An automation fires at the first tick on or after its time, so a
 * schedule the ticks cannot land on would quietly run late, or, if finer than
 * the ticks, at their pace. It is refused while the request is still a
 * conversation, with the nearest schedule that would work.
 */
/**
 * When a paused automation runs once it is resumed: on its schedule's next
 * turn, or for a one-off at its own time, straight away (at the next tick)
 * when that time went by while it was paused. Its cron has no year, and read
 * as a schedule it would come round again a year late.
 */
export function resumeAt(a: Pick<Automation, 'repeat' | 'cronExpr' | 'nextRunAt'>, now: Date = new Date()): Date | null {
  if (a.repeat === 'once') return a.nextRunAt > now ? a.nextRunAt : now
  return nextRun(a.cronExpr, now)
}

export async function schedule(cron: string, now: Date): Promise<{ next: Date } | { error: string; scheduler?: string; suggestion?: string }> {
  if (!isValidCron(cron)) return { error: `"${cron}" is not a valid 5-field cron expression.` }
  const next = nextRun(cron)
  if (!next) return { error: `"${cron}" will never fire again.` }
  const grid = await tickGrid()
  const fit = grid ? fitsGrid(grid, cron, now) : null
  if (grid && fit && !fit.fits) {
    const suggestion = suggestAligned(grid, cron, now)
    return {
      error:
        `The scheduler runs ${describeGrid(grid)}, and a schedule only fires on one of its ticks: ` +
        `"${cron}" is first due ${formatLocal(fit.due)} but would not run until ${formatLocal(fit.runs)}.` +
        (suggestion ? ` The nearest schedule that lines up is "${suggestion}"; offer it, or ask for a time on a tick.` : ' Ask for a time on a tick.'),
      scheduler: describeGrid(grid),
      ...(suggestion ? { suggestion } : {}),
    }
  }
  return { next }
}

export function automationTools(ctx: ToolContext) {
  return {
    create_automation: tool({
      description:
        `Schedule an instruction that runs on its own later and posts to this chat. Times are ${timezone()}. ` +
        'It fires only when the scheduler ticks, normally hourly on the hour, so put 0 in the minute field; ' +
        'a cron that would not land on a tick is refused, with the nearest one that does. ' +
        'repeat says how often: always (a schedule), once (a reminder or a job for later, then it is gone), or until ' +
        '(checks on a schedule until it finds what it is waiting for, posts it, then stops). ' +
        'Examples: "every Monday 7pm remind us to put the bins out" -> cron "0 19 * * 1"; ' +
        '"weekday mornings at 7am summarise today" -> "0 7 * * 1-5"; ' +
        '"remind me tomorrow at 5pm to call the plumber" -> at "<tomorrow>T17:00", repeat once; ' +
        '"let me know when the school emails the camp dates" -> cron "0 8-20 * * *", repeat until, ' +
        'instruction "Look for new mail from the school with the camp dates; post them when they arrive, otherwise SKIP".',
      inputSchema: z.object({
        label: z.string().describe('Short name, e.g. "bin night"'),
        cron: z
          .string()
          .optional()
          .describe('Standard 5-field cron: minute hour day-of-month month day-of-week (0=Sunday). Leave out when giving at.'),
        at: z
          .string()
          .optional()
          .describe(`For a one-off: the local ${timezone()} time as YYYY-MM-DDTHH:mm, in place of a cron. Implies repeat once.`),
        repeat: z
          .enum(REPEATS)
          .optional()
          .describe('always (the default with a cron), once (the default with at), or until'),
        instruction: z
          .string()
          .describe('What to do when it fires, written as an instruction to yourself'),
      }),
      execute: async ({ label, cron: given, at, repeat: asked, instruction }) => {
        const repeat: Repeat = asked ?? (at ? 'once' : 'always')
        let cron = given?.trim() ?? ''
        let when: Date | undefined
        if (at) {
          if (repeat !== 'once') return { error: 'A single time runs once. For a schedule that repeats, give a cron instead of at.' }
          try {
            when = localToUtc(at)
          } catch {
            return { error: `"${at}" is not a time. Give it as YYYY-MM-DDTHH:mm in ${timezone()}.` }
          }
          if (when.getTime() <= ctx.now.getTime()) return { error: `${formatLocal(when)} has already passed. Ask when it should be instead.` }
          cron = cronAt(when)
        }
        if (!cron) return { error: 'Give a cron for a schedule, or at for a single time.' }
        const checked = await schedule(cron, ctx.now)
        if ('error' in checked) return checked
        // A cron has no year, so a single time is kept as that very moment: the
        // cron's own next turn would be this year's date for one asked for next year.
        const next = when ?? checked.next

        const row = await addAutomation({
          chatId: ctx.chatId,
          memberId: ctx.member?.id ?? null,
          label,
          cronExpr: cron,
          instruction,
          nextRunAt: next,
          repeat,
          // Set up by a helper, it is that helper's job, and posts under its name.
          helperId: ctx.helper?.id ?? null,
        })
        return {
          id: row.id,
          label,
          ...(at ? {} : { cron }),
          repeat: REPEAT_WORDS[repeat],
          next_run_local: formatLocal(next),
          timezone: timezone(),
        }
      },
    }),

    list_automations: tool({
      description: 'List the scheduled automations for this chat: reminders, watchers, and jobs waiting to run once or until something happens.',
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
            ...(a.repeat !== 'always' ? { repeat: REPEAT_WORDS[a.repeat as Repeat] ?? a.repeat } : {}),
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
        const next = enabled ? resumeAt(existing) : null
        const row = await setAutomationEnabled(id, enabled, next ?? undefined)
        if (!row) return { error: `No automation ${id}.` }
        return { id, enabled, next_run_local: next ? formatLocal(next) : null }
      },
    }),
  }
}
