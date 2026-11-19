import { tool } from 'ai'
import { z } from 'zod'
import { addHelper, listHelpers, helperNamed, deleteHelper, allowedMembers, addAutomation } from '../db/queries'
import { HELPER_TEMPLATES, templateNamed, roleInBrief, namesSomeone } from '../helpers'
import { isAssistantName, assistantName, timezone } from '../env'
import { cronAt, formatLocal, localToUtc } from '../cron'
import { tickGrid, nextTickOnOrAfter } from '../scheduler'
import { schedule } from './automation'
import type { ToolContext } from './context'
import { requireMember } from './context'

const HOUR_MS = 3_600_000

/**
 * When a handed-over job runs when no time is given: the scheduler's next
 * tick after this minute, or the top of the next hour before the scheduler
 * has shown its cadence.
 */
async function nextChance(now: Date): Promise<Date> {
  const soon = new Date(now.getTime() + 60_000)
  const grid = await tickGrid()
  return grid ? nextTickOnOrAfter(grid, soon) : new Date(Math.ceil(soon.getTime() / HOUR_MS) * HOUR_MS)
}

export function helperTools(ctx: ToolContext) {
  return {
    create_helper: tool({
      description:
        'Add a helper the family can hand jobs to by name: a specialist role Hearth plays, whose reports carry its name. ' +
        `${HELPER_TEMPLATES.map((t) => t.name).join(', ')} come ready-made, so give the name alone for those. Anything else needs a role, written as its standing instructions.`,
      inputSchema: z.object({
        name: z.string().describe('What the family will call it: one or two words, e.g. "Chef"'),
        role: z.string().optional().describe('Who it is and what it looks after; leave out for a ready-made one'),
      }),
      execute: async ({ name, role }) => {
        const clean = name.trim()
        if (!isAssistantName(clean)) return { error: "A helper's name is one or two words of letters, like Chef or Aunty Bot." }
        if (clean.toLowerCase() === assistantName().toLowerCase()) return { error: `${clean} is Hearth's own name. Choose another for the helper.` }
        // "Ask Sam to look into it" must never be taken for a job for a helper called Sam.
        if (namesSomeone(clean, await allowedMembers())) {
          return { error: `${clean} is what someone in the family is called, so a job meant for them could go to the helper. Choose another name.` }
        }
        const template = templateNamed(clean)
        const standing = role?.trim() || template?.role
        if (!standing) {
          return { error: `Say what ${clean} looks after: every helper needs a role, bar the ready-made ${HELPER_TEMPLATES.map((t) => t.name).join(', ')}.` }
        }
        const made = await addHelper({ name: clean, role: standing, createdBy: ctx.member?.id ?? null })
        if (!made) return { error: `There is already a helper called ${clean}.` }
        return {
          helper: made.name,
          role: made.role,
          note: 'hand_off gives it a job to do in the background, and its report carries its name. Asked to talk to it, take its role up yourself.',
        }
      },
    }),

    list_helpers: tool({
      description: 'The helpers the family can hand jobs to by name, with what each looks after, and the ready-made ones not yet added.',
      inputSchema: z.object({}),
      execute: async () => {
        const all = await listHelpers()
        const have = new Set(all.map((h) => h.name.toLowerCase()))
        return {
          helpers: all.map((h) => ({ name: h.name, role: h.role })),
          ready_to_add: HELPER_TEMPLATES.filter((t) => !have.has(t.name.toLowerCase())).map((t) => ({ name: t.name, role: roleInBrief(t.role) })),
        }
      },
    }),

    remove_helper: tool({
      description: 'Remove a helper. Jobs already handed to it still run, by Hearth itself.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const found = await helperNamed(name)
        if (!found || !(await deleteHelper(found.id))) return { error: `There is no helper called ${name}.` }
        return { removed: found.name }
      },
    }),

    hand_off: tool({
      description:
        'Give a helper a job to do in the background: something to look into, a plan to draft, a check to make. ' +
        'It runs at the next scheduler tick (normally the top of the hour) unless a time is given, as that helper, with read-only tools and the same checks as any scheduled run, ' +
        'and what it finds is kept as a report for you under its name (list_reports, Home). Say who has it and when it will be done.',
      inputSchema: z.object({
        helper: z.string().describe('Which helper, by name'),
        task: z.string().describe('The job, written as an instruction to the helper, with everything it needs to know: it will not see this conversation'),
        at: z.string().optional().describe(`When to do it, local ${timezone()} time as YYYY-MM-DDTHH:mm; defaults to the next tick`),
      }),
      execute: async ({ helper, task, at }) => {
        const found = await helperNamed(helper)
        if (!found) {
          const names = (await listHelpers()).map((h) => h.name)
          return { error: `There is no helper called ${helper}.${names.length ? ` The helpers are ${names.join(', ')}.` : ' create_helper adds one.'}` }
        }
        const job = task.trim()
        if (!job) return { error: 'Say what the job is.' }
        // The next tick is on the grid by its making; a time given has to be checked against it.
        let when: Date
        if (at) {
          let asked: Date
          try {
            asked = localToUtc(at)
          } catch {
            return { error: `"${at}" is not a time. Give it as YYYY-MM-DDTHH:mm in ${timezone()}.` }
          }
          if (asked.getTime() <= ctx.now.getTime()) return { error: `${formatLocal(asked)} has already passed.` }
          const checked = await schedule(cronAt(asked), ctx.now)
          if ('error' in checked) return checked
          // The moment asked, never the cron's next turn: a cron has no year.
          when = asked
        } else {
          when = await nextChance(ctx.now)
        }
        const row = await addAutomation({
          memberId: requireMember(ctx).id,
          label: `${found.name}: ${job.length > 60 ? `${job.slice(0, 59)}…` : job}`,
          cronExpr: cronAt(when),
          instruction: job,
          nextRunAt: when,
          repeat: 'once',
          helperId: found.id,
        })
        return {
          handed_to: found.name,
          task: job,
          runs_local: formatLocal(when),
          automation_id: row.id,
          note: `${found.name} leaves a report when it is done, or nothing if there is nothing to say. It is listed with your reminders until then.`,
        }
      },
    }),
  }
}
