import { tool } from 'ai'
import { z } from 'zod'
import {
  addProposal, pendingProposals, settleProposal, getProposal, proposalsAround, addFamilyEvent, listFamilyEvents,
} from '../db/queries'
import { localToUtc, localDateKey, resolveSpan, nextLocalMidnight } from '../cron'
import { timezone } from '../env'
import type { EventProposal } from '../db/schema'
import type { ToolContext } from './context'
import { FEED_LAG, ALL_DAY_END, LOCAL_DATETIME, whenLabel, spanLabel } from './familycal'

/**
 * Whether two differently-worded notices describe the same occasion is a
 * judgement call, and the model is better at it than any string heuristic.
 * So past the duplicates code can see for itself (see standingProposal), the
 * tools do only the deterministic half: gather what that local day already
 * holds, hand it over, and require an explicit second call for anything that
 * still wants to go ahead.
 */
async function sameDay(dayStart: Date) {
  // By the calendar, and anything on at any point that day, a camp that began earlier included.
  const dayEnd = nextLocalMidnight(dayStart)
  const events = (await listFamilyEvents(dayStart, dayEnd)).filter((e) => !e.cancelled)
  const proposals = (await pendingProposals()).filter((p) => p.startsAt < dayEnd && p.endsAt > dayStart)
  return { events, proposals }
}

/** A title as two notices of the same occasion would agree on it: case, spacing and punctuation aside. */
export const sameTitle = (a: string, b: string) => {
  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return norm(a) === norm(b)
}

/** The message a source names, without the date added after a slash for a message holding several events. */
const messageOf = (source: string) => source.split('/')[0]

/**
 * The proposal already standing for an occasion, found in code before
 * anything is asked: the one from the same source; the one from the same
 * message for the same day (the date suffix written one morning and not the
 * next); or the one with the same title on the same day that is still
 * waiting or was turned down. A sweep reading the same mail every morning,
 * or two clients reading the same notice, then finds the proposal there is
 * rather than making another, and a notice the family said no to is not put
 * to them again.
 */
export async function standingProposal(input: { title: string; startsAt: Date; source?: string | null }, now: Date = new Date()): Promise<EventProposal | undefined> {
  const day = localDateKey(input.startsAt)
  const dayStart = localToUtc(day)
  const rows = await proposalsAround({ source: input.source ?? null, from: dayStart, to: nextLocalMidnight(dayStart) })
  const onDay = (p: EventProposal) => localDateKey(p.startsAt) === day
  // Waiting and still worth an answer, or turned down: either way already put to the family.
  const standing = (p: EventProposal) => (p.status === 'pending' && p.endsAt > now) || p.status === 'rejected'
  const source = input.source?.trim()
  return (
    (source ? rows.find((p) => p.source === source) : undefined) ??
    (source ? rows.find((p) => p.source && messageOf(p.source) === messageOf(source) && onDay(p)) : undefined) ??
    rows.find((p) => onDay(p) && standing(p) && sameTitle(p.title, input.title))
  )
}

/** Why a proposal is no longer waiting, in words a client can pass on. */
function settledReason(p: EventProposal): string {
  switch (p.status) {
    case 'accepted':
      return `"${p.title}" was already accepted and is on the family calendar.`
    case 'rejected':
      return `"${p.title}" was turned down, so it is not waiting for a yes any more.`
    case 'expired':
      return `"${p.title}" was on ${whenLabel(p.startsAt, p.allDay)}, which has passed.`
    case 'superseded':
      return `"${p.title}" reached the family calendar another way, so there is nothing to add.`
    default:
      return `"${p.title}" is not waiting for a yes.`
  }
}

/**
 * What accepting a proposal came to, said so a caller never has to guess:
 * the event was added; or it was not yet, because the same day already holds
 * something that may be the same occasion, named here with the exact call
 * that adds it anyway; or it could not be, and why. Nothing in between: an
 * accept never leaves a proposal quietly still waiting.
 */
export type AcceptResult =
  | { status: 'added'; proposal_id: number; event_id: number; title: string; when: string; note: string }
  | {
      status: 'needs_confirmation'
      proposal_id: number
      title: string
      when: string
      reason: string
      clashes: { event_id: number; title: string; when: string; location: string | null }[]
      /** The call that adds it anyway, once it is judged a different occasion. */
      to_confirm: { tool: 'accept_event_proposal'; arguments: { proposal_id: number; confirmed_distinct: true } }
      /** The call that settles it, if it is the same occasion as one of the clashes. */
      if_same: { tool: 'reject_event_proposal'; arguments: { proposal_id: number } }
    }
  | { status: 'failed'; proposal_id: number; reason: string; error: string }

const failed = (id: number, reason: string): AcceptResult => ({ status: 'failed', proposal_id: id, reason, error: reason })

/**
 * Accept a proposal for whoever is asking, from an MCP client or Home. A
 * same-day event on the calendar stops it once, named, until the caller says
 * it is a different occasion; only then is the proposal claimed (so a
 * repeated yes cannot add it twice) and the event added.
 */
export async function acceptProposal(id: number, opts: { confirmedDistinct?: boolean; memberId: number | null; now?: Date }): Promise<AcceptResult> {
  const now = opts.now ?? new Date()
  const p = await getProposal(id)
  if (!p) return failed(id, `There is no proposal ${id}.`)
  if (p.status !== 'pending') return failed(id, settledReason(p))
  if (p.endsAt <= now) return failed(id, settledReason({ ...p, status: 'expired' }))

  const day = await sameDay(localToUtc(localDateKey(p.startsAt)))
  // The very same event, already there, is not a clash to weigh: there is nothing to add.
  const already = day.events.find((e) => e.startsAt.getTime() === p.startsAt.getTime() && sameTitle(e.title, p.title))
  if (already) return failed(id, `"${p.title}" is already on the family calendar (event ${already.id}), so there is nothing to add. Reject the proposal to settle it.`)
  if (!opts.confirmedDistinct && day.events.length) {
    const clashes = day.events.map((e) => ({ event_id: e.id, title: e.title, when: spanLabel(e.startsAt, e.endsAt, e.allDay), location: e.location }))
    return {
      status: 'needs_confirmation',
      proposal_id: id,
      title: p.title,
      when: spanLabel(p.startsAt, p.endsAt, p.allDay),
      reason:
        `Not added yet: the family calendar already has ${clashes.map((c) => `"${c.title}" (${c.when})`).join(', ')} that day. ` +
        'If that is the same occasion under another name, reject this proposal instead; if it is a different one, accept again with confirmed_distinct.',
      clashes,
      to_confirm: { tool: 'accept_event_proposal', arguments: { proposal_id: id, confirmed_distinct: true } },
      if_same: { tool: 'reject_event_proposal', arguments: { proposal_id: id } },
    }
  }

  // Claim first, so a repeated yes cannot add the event twice.
  const row = await settleProposal(id, 'accepted')
  if (!row) {
    const now2 = await getProposal(id)
    return failed(id, now2 ? settledReason(now2) : `There is no proposal ${id}.`)
  }
  const event = await addFamilyEvent({
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    allDay: row.allDay,
    createdBy: opts.memberId,
  })
  return { status: 'added', proposal_id: id, event_id: event.id, title: row.title, when: spanLabel(row.startsAt, row.endsAt, row.allDay), note: FEED_LAG }
}

export function proposalTools(ctx: ToolContext) {
  return {
    propose_family_event: tool({
      description:
        'Put forward an event you found in an email, a notice or a page, for someone to confirm before it reaches the shared calendar. Use this instead of add_family_event whenever the event came from a document rather than from a person asking you directly. ' +
        'Say where it came from in the description, in words: the sender and subject, or a link the message carries, so anyone can check the details later. A message id is not that; it goes in source. ' +
        'Proposing what is already proposed is safe: the same source, the same message on the same day, or the same title on the same day comes back as the proposal already standing, never a second one.',
      inputSchema: z.object({
        title: z.string(),
        start: LOCAL_DATETIME,
        end: LOCAL_DATETIME.optional().describe(`Defaults to one hour after start. ${ALL_DAY_END}`),
        all_day: z.boolean().default(false),
        location: z.string().optional(),
        description: z
          .string()
          .optional()
          .describe('The details in words, opening with where this came from, e.g. "From <sender>, \\"<subject>\\": ...". Never an id or a token.'),
        source: z
          .string()
          .optional()
          .describe(
            'Stable id of the message or page this came from, as <provider>:<id>, e.g. "google:<message id>" or "microsoft:<message id>". Stops the same thing being proposed twice. ' +
              'When one message holds several events, add the event date after a slash, e.g. "microsoft:<message id>/2026-10-05", so each can be proposed.',
          ),
        confirmed_distinct: z
          .boolean()
          .default(false)
          .describe(
            'Set only on a second call, after judging the same-day list this tool returned and finding this is genuinely a different occasion',
          ),
      }),
      execute: async ({ title, start, end, all_day, location, description, source, confirmed_distinct }) => {
        // Read as add_family_event will read it once accepted: a date alone
        // is all day, and an all-day end is a whole local day on at least.
        const { startsAt, endsAt, allDay } = resolveSpan({ start, end, allDay: all_day })

        // What code can see is the same occasion is settled here, before any
        // judgement is asked for: a second sweep over the same mail finds the
        // proposal the first one made.
        const standing = await standingProposal({ title, startsAt, source }, ctx.now)
        if (standing) {
          return standing.status === 'pending'
            ? {
                already_proposed: true,
                proposal_id: standing.id,
                title: standing.title,
                start_local: whenLabel(standing.startsAt, standing.allDay),
                next_step: 'This is already waiting on a yes as this proposal; say so rather than proposing it again.',
              }
            : { skipped: true, proposal_id: standing.id, reason: `Already proposed as #${standing.id} (${standing.status}). ${settledReason(standing)}` }
        }

        // The same occasion reaches several mailboxes under different
        // subjects, so a source id alone cannot stop a duplicate. When that
        // day already holds anything, the model judges before this goes ahead.
        if (!confirmed_distinct) {
          const known = await sameDay(localToUtc(localDateKey(startsAt)))
          if (known.events.length || known.proposals.length) {
            return {
              not_proposed_yet: true,
              that_day_already_has: {
                on_calendar: known.events.map((e) => ({
                  id: e.id, title: e.title, start_local: whenLabel(e.startsAt, e.allDay), location: e.location,
                })),
                awaiting_yes: known.proposals.map((p) => ({ proposal_id: p.id, title: p.title })),
              },
              next_step:
                'Judge whether your find is one of these under another name, as the same notice lands in several mailboxes. ' +
                'If it is, say it is already covered instead of proposing. Only if it is genuinely a different occasion, call again with confirmed_distinct: true.',
            }
          }
        }

        const row = await addProposal({
          memberId: ctx.member?.id ?? null,
          title, description, location, startsAt, endsAt, allDay, source,
        })
        return {
          proposal_id: row.id,
          title: row.title,
          start_local: whenLabel(row.startsAt, row.allDay),
          all_day: row.allDay,
          location: row.location,
          next_step: 'Show this to the family and ask whether to add it. Do not add it yourself.',
        }
      },
    }),

    list_event_proposals: tool({
      description: 'Show events waiting for someone to confirm before they go on the family calendar.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await pendingProposals()
        return {
          timezone: timezone(),
          proposals: rows.map((r) => ({
            id: r.id,
            title: r.title,
            start_local: whenLabel(r.startsAt, r.allDay),
            all_day: r.allDay,
            location: r.location,
          })),
        }
      },
    }),

    accept_event_proposal: tool({
      description:
        'Add a proposed event to the shared family calendar, once a person has said yes to it. The result says what happened in `status`: ' +
        'added; needs_confirmation, when the same day already has something on the calendar that may be the same occasion (each named in clashes, ' +
        'with the exact call to add it anyway in to_confirm and the one to settle it as a duplicate in if_same); or failed, with the reason.',
      inputSchema: z.object({
        proposal_id: z.number().int(),
        confirmed_distinct: z
          .boolean()
          .default(false)
          .describe('Set only on a second call, after a needs_confirmation result, once the named same-day events are judged different occasions'),
      }),
      execute: async ({ proposal_id, confirmed_distinct }) =>
        acceptProposal(proposal_id, { confirmedDistinct: confirmed_distinct, memberId: ctx.member?.id ?? null, now: ctx.now }),
    }),

    reject_event_proposal: tool({
      description: 'Discard a proposed event the family does not want on the calendar, or one that turned out to be on it already.',
      inputSchema: z.object({ proposal_id: z.number().int() }),
      execute: async ({ proposal_id }) => {
        const row = await settleProposal(proposal_id, 'rejected')
        return row ? { rejected: true, title: row.title } : { error: `Proposal ${proposal_id} is not pending.` }
      },
    }),
  }
}
