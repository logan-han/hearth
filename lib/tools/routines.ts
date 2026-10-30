import { tool } from 'ai'
import { z } from 'zod'
import { listRoutines, routineNamed, saveRoutine, deleteRoutine } from '../db/queries'
import { formatLocalDate } from '../cron'
import type { ToolContext } from './context'

/**
 * Routines are how the household teaches the bot something once: "the Sunday
 * reset", "getting ready for a school term". After doing it together in the
 * chat, a member says to keep it, and the steps are written down as
 * instructions; from then on the routine's name is enough, in a message or on
 * a schedule. Running one hands the steps back to the turn, which carries
 * them out with whatever tools it has: a scheduled run reads and proposes,
 * and leaves to a person anything that would need their yes.
 */

const MAX_STEPS = 20

/** Steps as they are kept: one instruction a line, numbered when read back. */
const asLines = (steps: string[]) => steps.map((s) => s.trim()).filter(Boolean).slice(0, MAX_STEPS)
const numbered = (kept: string) => kept.split('\n').map((s, i) => `${i + 1}. ${s}`)

export function routineTools(ctx: ToolContext) {
  return {
    save_routine: tool({
      description:
        'Keep something the household does the same way each time as a routine, to run again by its name: after doing it together ("keep that as the Sunday reset"), or when told the steps. ' +
        'Write each step as an instruction to yourself, with the lists, people, amounts and places that make it repeatable, in the order they are done. Saving under a name already kept replaces its steps.',
      inputSchema: z.object({
        name: z.string().describe('What it will be called, e.g. "Sunday reset"'),
        steps: z.array(z.string()).min(1).describe('The steps in order, each one instruction'),
      }),
      execute: async ({ name, steps }) => {
        const clean = name.trim()
        const kept = asLines(steps)
        if (!clean) return { error: 'A routine needs a name.' }
        if (kept.length === 0) return { error: 'A routine needs at least one step.' }
        const { row, replaced } = await saveRoutine({ name: clean, steps: kept.join('\n'), createdBy: ctx.member?.id ?? null })
        return {
          routine: row.name,
          steps: numbered(row.steps),
          ...(replaced ? { replaced: true } : {}),
          note: `Run it by name any time ("do the ${row.name}"), or on a schedule with create_automation.`,
        }
      },
    }),

    run_routine: tool({
      description:
        'Fetch a kept routine\'s steps to carry out now, when someone asks for it by name. Then do each step in order with your tools, and report what was done; ' +
        'skip a step that does not apply today and say so. Anything that needs a yes (an email, an invitation) is drafted or proposed, never done outright.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const found = await routineNamed(name)
        if (!found) {
          const names = (await listRoutines()).map((r) => r.name)
          return { error: `No routine called "${name}".${names.length ? ` The routines are: ${names.join(', ')}.` : ' None are kept yet.'}` }
        }
        return {
          routine: found.name,
          steps: numbered(found.steps),
          next_step: 'Carry these out now, in order, with your tools, then say what was done and what was skipped.',
        }
      },
    }),

    list_routines: tool({
      description: 'The routines the household has kept, each with its steps.',
      inputSchema: z.object({}),
      execute: async () => {
        const all = await listRoutines()
        return all.length
          ? { routines: all.map((r) => ({ name: r.name, steps: numbered(r.steps), kept: formatLocalDate(r.updatedAt) })) }
          : { routines: [], note: 'None kept yet. After doing something together, ask to keep it as a routine.' }
      },
    }),

    delete_routine: tool({
      description: 'Forget a kept routine by name.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const found = await routineNamed(name)
        if (!found || !(await deleteRoutine(found.id))) return { error: `No routine called "${name}".` }
        return { deleted: found.name }
      },
    }),
  }
}
