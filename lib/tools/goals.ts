import { tool } from 'ai'
import { z } from 'zod'
import {
  createGoal, getGoal, updateGoal, goalsIn, closeGoal, reopenGoal, addGoalUpdate, goalUpdatesFor,
  addGoalSteps, goalStepsOf, markGoalSteps, addAutomation, deleteAutomation, getAutomation, syncAutomation,
} from '../db/queries'
import type { Goal } from '../db/schema'
import { schedule } from './automation'
import { formatLocal, formatLocalDate, localDateKey, localToUtc } from '../cron'
import { timezone } from '../env'
import type { ToolContext } from './context'

/**
 * Goals are what the household is working towards over weeks: a trip saved
 * for, a party planned, a house readied for sale. Each has a plan of steps of
 * its own, ticked off in the chat or on Home; a record of progress in the
 * family's words; and a check-in that brings it back to the chat on a
 * schedule until it is done or dropped. That last is what keeps a goal moving
 * when nobody is thinking about it. A goal set in a member's own chat is
 * theirs: nothing about it reaches a group, Home shows it to them alone, and
 * its steps are never one of the household's shared lists.
 */

/** Sunday at 7pm: the week's end, when a household looks at the week ahead. */
export const DEFAULT_CHECK_IN = '0 19 * * 0'

const DAY_MS = 86_400_000

const isGroup = (chatId: string) => chatId.startsWith('-')

/**
 * What a check-in runs: a custom automation like any other, read-only, with
 * the post checked against goal_status. Everything it says comes from there,
 * so the instruction names the goal by id and says what to pick out of it.
 */
export function checkInInstruction(goal: { id: number; title: string }): string {
  return (
    `Check in on goal ${goal.id}, "${goal.title}". Call goal_status with id ${goal.id}. ` +
    'If it says the goal is no longer active, reply SKIP. Otherwise post a short check-in: the progress so far as goal_status gives it ' +
    '(steps done out of all of them, and the latest update with who gave it), the next open step, and the days left to the target date when there is one. ' +
    'End with one question that would move it forward, such as who will take the next step.'
  )
}

/**
 * What the check-in is called where everyone can see it, among Home's
 * reminders: a group's goal by its name, a member's own by nothing that
 * gives it away.
 */
const checkInLabel = (goal: { title: string; chatId: string }) => (isGroup(goal.chatId) ? `Goal check-in: ${goal.title}` : 'Goal check-in')

/**
 * Whether what this run reads is read by one member alone: their own chat
 * with the bot, or their MCP client. A group's turn is read by the room, and
 * so is a scheduled run in a group, which posts what it finds there whoever
 * set it up.
 */
const readAlone = (ctx: Pick<ToolContext, 'chatId' | 'via'>) => ctx.via === 'mcp' || !isGroup(ctx.chatId)

/** The goals this run may see: the room's own, and where one member alone reads it, theirs from anywhere. */
export function goalScope(ctx: Pick<ToolContext, 'chatId' | 'member' | 'via'>) {
  return readAlone(ctx) ? { chatId: ctx.chatId, memberId: ctx.member?.id ?? null } : { chatId: ctx.chatId }
}

export function canSee(goal: Goal, ctx: Pick<ToolContext, 'chatId' | 'member' | 'via'>): boolean {
  if (goal.chatId === ctx.chatId) return true
  return readAlone(ctx) && ctx.member != null && goal.memberId === ctx.member.id
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A YYYY-MM-DD that is a real day, or null. */
function realDate(value: string): string | null {
  if (!ISO_DATE.test(value)) return null
  const at = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value ? value : null
}

/** Whole days from today to a YYYY-MM-DD, by the calendar: negative once it has passed. */
export function daysUntil(date: string, now: Date): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${localDateKey(now)}T00:00:00Z`)) / DAY_MS)
}

const targetWords = (date: string) => formatLocalDate(localToUtc(date))

/** Where a goal stands, as list_goals and the context give it: enough to talk about, with the id for more. */
export async function goalSummary(goal: Goal, now: Date) {
  const [steps, [latest]] = await Promise.all([goalStepsOf(goal.id), goalUpdatesFor(goal.id, 1)])
  const next = steps.find((st) => !st.done)
  return {
    goal_id: goal.id,
    title: goal.title,
    ...(goal.targetDate ? { target_date: targetWords(goal.targetDate), days_left: daysUntil(goal.targetDate, now) } : {}),
    steps_done: steps.filter((st) => st.done).length,
    steps_total: steps.length,
    ...(next ? { next_step: next.content } : {}),
    ...(latest ? { latest_update: `${latest.note} (${latest.who ?? 'someone'}, ${formatLocalDate(latest.createdAt)})` } : {}),
  }
}

export function goalTools(ctx: ToolContext) {
  /** The goal by id, if this run may see it, or why not. */
  async function visible(id: number): Promise<Goal | { error: string }> {
    const goal = await getGoal(id)
    return goal && canSee(goal, ctx) ? goal : { error: `No goal ${id} here.` }
  }

  return {
    create_goal: tool({
      description:
        'Start a goal the household is working towards over weeks: a trip to save for, a party to plan, a house to ready for sale, a training plan. ' +
        'Give its plan as steps, each one thing a person can do, in order: they are ticked off with update_goal, or on Home. ' +
        'A check-in then brings it back to this chat each week (Sunday 7pm unless asked otherwise) with the progress and the next step, until it is done or dropped. ' +
        'Draft the steps yourself when they are not given, from what the goal needs, and show them in your reply.',
      inputSchema: z.object({
        title: z.string().describe('Short name, e.g. "Bali trip in March"'),
        outcome: z.string().optional().describe('What done looks like, in their words, e.g. "$6,000 saved and flights booked"'),
        target_date: z.string().optional().describe(`The day it should be done by, YYYY-MM-DD in ${timezone()}, when there is one`),
        steps: z.array(z.string()).default([]).describe('The plan, in order: each step one thing a person can do'),
        check_in: z
          .string()
          .optional()
          .describe('A 5-field cron for the check-in, on the hour; defaults to Sunday 7pm. "none" for no check-in.'),
      }),
      execute: async ({ title, outcome, target_date, steps, check_in }) => {
        const name = title.trim()
        if (!name) return { error: 'A goal needs a name.' }
        const target = target_date ? realDate(target_date.trim()) : null
        if (target_date && !target) return { error: `"${target_date}" is not a date. Give it as YYYY-MM-DD.` }
        if (target && daysUntil(target, ctx.now) < 0) return { error: `${targetWords(target)} has already passed. Ask when it should be done by instead.` }

        // The check-in is checked before anything is made, so a refused
        // schedule leaves no half-made goal behind.
        const cron = check_in?.trim() || DEFAULT_CHECK_IN
        const checked = cron.toLowerCase() === 'none' ? null : await schedule(cron, ctx.now)
        if (checked && 'error' in checked) return checked

        const goal = await createGoal({ chatId: ctx.chatId, memberId: ctx.member?.id ?? null, title: name, outcome: outcome?.trim() || null, targetDate: target })
        const planned = (await addGoalSteps(goal.id, steps)).map((st) => st.content)
        if (checked) {
          const automation = await addAutomation({
            chatId: ctx.chatId,
            memberId: ctx.member?.id ?? null,
            label: checkInLabel(goal),
            cronExpr: cron,
            instruction: checkInInstruction(goal),
            nextRunAt: checked.next,
          })
          await updateGoal(goal.id, { automationId: automation.id })
        }
        return {
          goal_id: goal.id,
          title: name,
          ...(target ? { target_date: targetWords(target), days_left: daysUntil(target, ctx.now) } : {}),
          steps: planned,
          check_in: checked ? `next ${formatLocal(checked.next)}, then on that schedule` : 'none',
          note: 'Tick steps off, add more, log progress, change the target or close it with update_goal.',
        }
      },
    }),

    list_goals: tool({
      description: 'The goals in progress here, each with its progress, its next step and the days left to its target date.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await goalsIn(goalScope(ctx))
        if (rows.length === 0) return { goals: [], note: 'No goals in progress here. create_goal starts one.' }
        return { goals: await Promise.all(rows.map((g) => goalSummary(g, ctx.now))) }
      },
    }),

    goal_status: tool({
      description: 'One goal in full: what done looks like, the target date and days left, every step done and still open, the latest progress, and when it next checks in.',
      inputSchema: z.object({ id: z.number().int() }),
      execute: async ({ id }) => {
        const goal = await visible(id)
        if ('error' in goal) return goal
        const [steps, updates, check] = await Promise.all([
          goalStepsOf(goal.id),
          goalUpdatesFor(goal.id, 5),
          goal.automationId ? getAutomation(goal.automationId) : Promise.resolve(undefined),
        ])
        return {
          goal_id: goal.id,
          title: goal.title,
          status: goal.status,
          ...(goal.outcome ? { outcome: goal.outcome } : {}),
          started: formatLocalDate(goal.createdAt),
          ...(goal.targetDate ? { target_date: targetWords(goal.targetDate), days_left: daysUntil(goal.targetDate, ctx.now) } : {}),
          ...(goal.closedAt ? { closed: formatLocalDate(goal.closedAt) } : {}),
          steps: {
            done: steps.filter((st) => st.done).length,
            total: steps.length,
            open: steps.filter((st) => !st.done).map((st) => st.content),
            finished: steps.filter((st) => st.done).map((st) => st.content),
          },
          updates: updates.map((u) => ({ note: u.note, who: u.who ?? 'someone', when: formatLocalDate(u.createdAt) })),
          check_in: check?.enabled ? formatLocal(check.nextRunAt) : 'none',
        }
      },
    }),

    update_goal: tool({
      description:
        'Change a goal: tick steps off (or back on) by what they say, add steps, log progress in their words ("booked the venue"), move or clear its target date, rename it, ' +
        'or close it as done or dropped (which ends its check-ins), or reopen one.',
      inputSchema: z.object({
        id: z.number().int(),
        steps_done: z.array(z.string()).optional().describe('Steps to tick off, by a word or two of each: "venue" ticks "Book the venue"'),
        steps_undone: z.array(z.string()).optional().describe('Steps to put back as still to do'),
        new_steps: z.array(z.string()).optional().describe('Steps to add to the end of the plan'),
        progress: z.string().optional().describe("What has happened, in their words, to keep on the goal's record"),
        status: z.enum(['active', 'done', 'dropped']).optional().describe('done once achieved, dropped once no longer wanted, active to reopen one'),
        title: z.string().optional(),
        outcome: z.string().optional(),
        target_date: z.string().optional().describe('YYYY-MM-DD, or "none" to clear it'),
      }),
      execute: async ({ id, steps_done, steps_undone, new_steps, progress, status, title, outcome, target_date }) => {
        const goal = await visible(id)
        if ('error' in goal) return goal
        const target = target_date === undefined ? undefined : target_date.trim().toLowerCase() === 'none' ? null : realDate(target_date.trim())
        if (target_date !== undefined && target === null && target_date.trim().toLowerCase() !== 'none') {
          return { error: `"${target_date}" is not a date. Give it as YYYY-MM-DD, or "none" to clear it.` }
        }
        const changed: string[] = []
        const name = title?.trim() || undefined
        if (name !== undefined || outcome !== undefined || target !== undefined) {
          await updateGoal(goal.id, {
            ...(name !== undefined ? { title: name } : {}),
            ...(outcome !== undefined ? { outcome: outcome.trim() || null } : {}),
            ...(target !== undefined ? { targetDate: target } : {}),
          })
          if (name !== undefined) changed.push(`renamed to "${name}"`)
          if (outcome !== undefined) changed.push('what done looks like')
          if (target !== undefined) changed.push(target ? `target ${targetWords(target)}` : 'target cleared')
          // The check-in asks after the goal by name, and a group's is labelled with it.
          if (name !== undefined && goal.automationId) {
            const check = await getAutomation(goal.automationId)
            if (check) {
              await syncAutomation(check.id, {
                label: checkInLabel({ title: name, chatId: goal.chatId }),
                cronExpr: check.cronExpr,
                instruction: checkInInstruction({ id: goal.id, title: name }),
              })
            }
          }
        }
        const ticked = steps_done?.length ? await markGoalSteps(goal.id, steps_done, true) : []
        const unticked = steps_undone?.length ? await markGoalSteps(goal.id, steps_undone, false) : []
        const added = new_steps?.length ? await addGoalSteps(goal.id, new_steps) : []
        if (ticked.length) changed.push(`ticked off ${ticked.map((st) => st.content).join(', ')}`)
        if (unticked.length) changed.push(`put back ${unticked.map((st) => st.content).join(', ')}`)
        if (added.length) changed.push(`added ${added.map((st) => st.content).join(', ')}`)
        if (progress?.trim()) {
          await addGoalUpdate(goal.id, progress, ctx.member?.id ?? null)
          changed.push('progress noted')
        }
        if (status === 'done' || status === 'dropped') {
          const closed = await closeGoal(goal.id, status)
          if (!closed) return { error: `Goal ${id} is already ${goal.status}.`, ...(changed.length ? { changed } : {}) }
          // Nothing left to check in on.
          if (goal.automationId) await deleteAutomation(goal.automationId)
          changed.push(status === 'done' ? 'marked done, check-ins ended' : 'dropped, check-ins ended')
        } else if (status === 'active' && goal.status !== 'active') {
          await reopenGoal(goal.id)
          const checked = await schedule(DEFAULT_CHECK_IN, ctx.now)
          if ('next' in checked) {
            const automation = await addAutomation({
              chatId: goal.chatId,
              memberId: goal.memberId,
              label: checkInLabel({ title: name ?? goal.title, chatId: goal.chatId }),
              cronExpr: DEFAULT_CHECK_IN,
              instruction: checkInInstruction({ id: goal.id, title: name ?? goal.title }),
              nextRunAt: checked.next,
            })
            await updateGoal(goal.id, { automationId: automation.id })
          }
          changed.push('reopened, with check-ins on Sundays at 7pm')
        }
        const missed = [...(steps_done ?? []), ...(steps_undone ?? [])].length > 0 && ticked.length + unticked.length === 0
        if (changed.length === 0) {
          return {
            error: missed
              ? 'No step matched. goal_status lists them as they are written.'
              : 'Nothing to change: give steps to tick off or add, progress, a status, a title, an outcome or a target date.',
          }
        }
        return { goal_id: goal.id, title: name ?? goal.title, changed, ...(missed ? { note: 'No step matched what was given to tick; goal_status lists them.' } : {}) }
      },
    }),
  }
}
