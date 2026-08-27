import { tool } from 'ai'
import { z } from 'zod'
import {
  addProposal, pendingProposals, settleProposal, proposalForSource, addFamilyEvent, listFamilyEvents,
} from '../db/queries'
import { localToUtc, formatLocal, localDateKey } from '../cron'
import { timezone } from '../env'
import type { ToolContext } from './context'

const LOCAL_DATETIME = z
  .string()
  .describe(`Local ${timezone()} time as YYYY-MM-DDTHH:mm (or YYYY-MM-DD for all-day)`)

/**
 * Whether two differently-worded notices describe the same occasion is a
 * judgement call, and the model is better at it than any string heuristic.
 * The tools therefore do only the deterministic half: gather what that local
 * day already holds, hand it over, and require an explicit second call for
 * anything that still wants to go ahead.
 */
async function sameDay(chatId: string, dayStart: Date) {
  const dayEnd = new Date(dayStart.getTime() + 86_400_000)
  const events = (await listFamilyEvents(dayStart, dayEnd)).filter((e) => !e.cancelled)
  const proposals = (await pendingProposals(chatId)).filter((p) => p.startsAt >= dayStart && p.startsAt < dayEnd)
  return { events, proposals }
}

export function proposalTools(ctx: ToolContext) {
  return {
    propose_family_event: tool({
      description:
        'Put forward an event you found in an email, a photographed notice, or a message, for someone to confirm before it reaches the shared calendar. Use this instead of add_family_event whenever the event came from a document rather than from a person asking you directly. ' +
        'Put the source link in the description when there is one, so anyone can check the details later.',
      inputSchema: z.object({
        title: z.string(),
        start: LOCAL_DATETIME,
        end: LOCAL_DATETIME.optional().describe('Defaults to one hour after start'),
        all_day: z.boolean().default(false),
        location: z.string().optional(),
        description: z.string().optional(),
        source: z
          .string()
          .optional()
          .describe(
            'Stable id of where this came from, e.g. "google:18f2ab" for an email. Stops the same thing being proposed twice.',
          ),
        confirmed_distinct: z
          .boolean()
          .default(false)
          .describe(
            'Set only on a second call, after judging the same-day list this tool returned and finding this is genuinely a different occasion',
          ),
      }),
      execute: async ({ title, start, end, all_day, location, description, source, confirmed_distinct }) => {
        if (source) {
          const seen = await proposalForSource(source)
          if (seen) {
            return { skipped: true, reason: `Already proposed as #${seen.id} (${seen.status}).` }
          }
        }

        // The same occasion reaches several mailboxes under different
        // subjects, so a source id alone cannot stop a duplicate. When that
        // day already holds anything, the model judges before this goes ahead.
        if (!confirmed_distinct) {
          const known = await sameDay(ctx.chatId, localToUtc(start.trim().slice(0, 10)))
          if (known.events.length || known.proposals.length) {
            return {
              not_proposed_yet: true,
              that_day_already_has: {
                on_calendar: known.events.map((e) => ({
                  id: e.id, title: e.title, start_local: formatLocal(e.startsAt), location: e.location,
                })),
                awaiting_yes: known.proposals.map((p) => ({ proposal_id: p.id, title: p.title })),
              },
              next_step:
                'Judge whether your find is one of these under another name — the same notice lands in several mailboxes. ' +
                'If it is, say it is already covered instead of proposing. Only if it is genuinely a different occasion, call again with confirmed_distinct: true.',
            }
          }
        }

        const startsAt = localToUtc(start)
        const endsAt = end
          ? localToUtc(end)
          : new Date(startsAt.getTime() + (all_day ? 24 : 1) * 60 * 60 * 1000)

        const row = await addProposal({
          chatId: ctx.chatId,
          memberId: ctx.member?.id ?? null,
          title, description, location, startsAt, endsAt, allDay: all_day, source,
        })
        return {
          proposal_id: row.id,
          title,
          start_local: formatLocal(startsAt),
          all_day,
          location,
          next_step: 'Show this to the family and ask whether to add it. Do not add it yourself.',
        }
      },
    }),

    list_event_proposals: tool({
      description: 'Show events waiting for someone to confirm before they go on the family calendar.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await pendingProposals(ctx.chatId)
        return {
          timezone: timezone(),
          proposals: rows.map((r) => ({
            id: r.id,
            title: r.title,
            start_local: formatLocal(r.startsAt),
            all_day: r.allDay,
            location: r.location,
          })),
        }
      },
    }),

    accept_event_proposal: tool({
      description:
        'Add a proposed event to the shared family calendar, once a person has said yes to it.',
      inputSchema: z.object({
        proposal_id: z.number().int(),
        confirmed_distinct: z
          .boolean()
          .default(false)
          .describe('Set only on a second call, after judging that the same-day calendar entries are different occasions'),
      }),
      execute: async ({ proposal_id, confirmed_distinct }) => {
        // A yes should not double up something that reached the calendar
        // through another path in the meantime; the model judges first.
        if (!confirmed_distinct) {
          const waiting = (await pendingProposals(ctx.chatId)).find((p) => p.id === proposal_id)
          if (waiting) {
            const known = await sameDay(ctx.chatId, localToUtc(localDateKey(waiting.startsAt)))
            if (known.events.length) {
              return {
                held: true,
                that_day_already_has: known.events.map((e) => ({
                  id: e.id, title: e.title, start_local: formatLocal(e.startsAt), location: e.location,
                })),
                next_step:
                  'If one of these is the same occasion, reject the proposal and say it is already on the calendar. ' +
                  'Only if it is genuinely a different occasion, accept again with confirmed_distinct: true.',
              }
            }
          }
        }
        // Claim first, so a repeated "yes" cannot add the event twice.
        const row = await settleProposal(proposal_id, 'accepted')
        if (!row) return { error: `Proposal ${proposal_id} is not waiting for an answer.` }

        const event = await addFamilyEvent({
          title: row.title,
          description: row.description,
          location: row.location,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          allDay: row.allDay,
          createdBy: ctx.member?.id ?? null,
        })
        ctx.notices.push(`Added to the family calendar: **${row.title}** — ${formatLocal(row.startsAt)}`)
        return { added: true, event_id: event.id, title: row.title }
      },
    }),

    reject_event_proposal: tool({
      description: 'Discard a proposed event the family does not want on the calendar.',
      inputSchema: z.object({ proposal_id: z.number().int() }),
      execute: async ({ proposal_id }) => {
        const row = await settleProposal(proposal_id, 'rejected')
        return row ? { rejected: true, title: row.title } : { error: `Proposal ${proposal_id} is not pending.` }
      },
    }),
  }
}
