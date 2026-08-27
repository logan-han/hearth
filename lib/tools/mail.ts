import { tool } from 'ai'
import { z } from 'zod'
import { clientFor, clientsFor } from '../providers'
import { NotConnectedError } from '../providers/token'
import { createDraft, getDraft, markDraft, connectionsFor, allowedMembers, strangersIn, pendingDrafts } from '../db/queries'
import { readCursor, writeCursor } from './cursor'
import type { ToolContext } from './context'
import { requireMember } from './context'
import type { Provider } from '../oauth/providers'

const providerEnum = z.enum(['google', 'microsoft'])

async function linkedProviders(memberId: number): Promise<Provider[]> {
  const conns = await connectionsFor(memberId)
  return conns.map((c) => c.provider as Provider)
}

export function mailTools(ctx: ToolContext) {
  return {
    list_email: tool({
      description:
        "List or search the asker's own linked mailbox(es). A search spans the whole mailbox — archived mail included — " +
        'so an email that is not in the inbox is still findable. Searches every linked account unless a provider is given.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Optional search terms, e.g. "from:school" or "invoice". Omit for the latest inbox mail.'),
        limit: z.number().int().min(1).max(20).default(8),
        provider: providerEnum.optional().describe('Restrict to one account'),
        everywhere: z
          .boolean()
          .optional()
          .describe('Search beyond the inbox (archive and other folders). Defaults to on whenever a query is given.'),
      }),
      execute: async ({ query, limit, provider, everywhere }) => {
        const member = requireMember(ctx)
        const clients = provider ? [clientFor(member.id, provider)] : await clientsFor(member.id)
        if (clients.length === 0) return { error: 'No email account linked. Send /connect to link one.' }
        const scope = (everywhere ?? Boolean(query)) ? ('all' as const) : ('inbox' as const)

        const out = await Promise.all(
          clients.map(async (c) => {
            try {
              return { provider: c.provider, messages: await c.listMail({ query, limit, scope }) }
            } catch (e) {
              return { provider: c.provider, error: describe(e) }
            }
          }),
        )
        return { accounts: out }
      },
    }),

    new_mail: tool({
      description:
        'Email that has arrived since this chat last checked. Advances its own marker per person, so the same ' +
        'message is never reported twice — built for scheduled sweeps. Returns empty lists when there is nothing new. ' +
        "Acts on the asker's own mailbox(es); set everyone for a family-wide sweep across every linked member.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(30).default(10).describe('Per mailbox'),
        everyone: z
          .boolean()
          .default(false)
          .describe('Sweep every family member with a linked mailbox, for a shared chat'),
      }),
      execute: async ({ limit, everyone }) => {
        // A family-wide sweep reads several people's mail into one room, so the
        // same house rule as live questions applies: not in front of strangers.
        if (everyone && (await strangersIn(ctx.chatId)).length > 0) {
          return { error: 'Not while someone unrecognised is in this chat. An admin can vouch for them with /allow.' }
        }
        const members = everyone ? await allowedMembers() : [requireMember(ctx)]
        const max = limit ?? 10

        const accounts: object[] = []
        for (const member of members) {
          const clients = await clientsFor(member.id)
          for (const c of clients) {
            try {
              const key = `mail_cursor:${ctx.chatId}:${member.id}:${c.provider}`
              const cursor = await readCursor(key)
              // The first look reaches back only a few hours, so switching a
              // sweep on does not replay the whole inbox into the chat.
              const since = cursor ? new Date(cursor.at) : new Date(ctx.now.getTime() - 6 * 3600_000)

              // Sweeps announce arrivals, so only the inbox counts here.
              const found = await c.listMail({ limit: max + 10, scope: 'inbox' })
              const seen = new Set(cursor?.ids ?? [])
              // A message with an unparseable date is kept: the remembered ids
              // still stop it repeating, and dropping it would lose real mail.
              const fresh = found
                .filter((m) => {
                  if (seen.has(m.id)) return false
                  const at = new Date(m.date)
                  return Number.isNaN(at.getTime()) || at >= since
                })
                .slice(0, max)

              if (fresh.length > 0) {
                const stamps = fresh.map((m) => new Date(m.date).getTime()).filter((t) => !Number.isNaN(t))
                const newest = stamps.length ? new Date(Math.max(...stamps)).toISOString() : ctx.now.toISOString()
                await writeCursor(key, newest, fresh.map((m) => m.id), cursor)
              } else if (!cursor) {
                await writeCursor(key, ctx.now.toISOString(), [], null)
              }

              accounts.push({
                member: member.name,
                provider: c.provider,
                first_check: !cursor,
                messages: fresh.map(({ id, from, subject, snippet, date }) => ({ id, from, subject, snippet, date })),
              })
            } catch (e) {
              accounts.push({ member: member.name, provider: c.provider, error: describe(e) })
            }
          }
        }
        if (accounts.length === 0) {
          return { error: everyone ? 'Nobody has linked a mailbox yet. Send /connect to link one.' : 'No email account linked. Send /connect to link one.' }
        }
        return { accounts }
      },
    }),

    read_email: tool({
      description:
        'Read the full body of one email by its id, as returned by list_email or new_mail. ' +
        "For a message found in another family member's mailbox (a family sweep), pass of: their name.",
      inputSchema: z.object({
        id: z.string(),
        provider: providerEnum,
        of: z.string().optional().describe("Family member the mailbox belongs to; omit for the asker's own"),
      }),
      execute: async ({ id, provider, of }) => {
        const member = requireMember(ctx)
        try {
          let owner = member
          if (of && of.trim().toLowerCase() !== member.name.trim().toLowerCase()) {
            const target = (await allowedMembers()).find(
              (m) => m.name.trim().toLowerCase() === of.trim().toLowerCase(),
            )
            if (!target) return { error: `No family member called "${of}".` }
            // Reading someone else's mail follows the same house rule as the
            // family sweep: never in front of strangers.
            if ((await strangersIn(ctx.chatId)).length > 0) {
              return { error: 'Not while someone unrecognised is in this chat. An admin can vouch for them with /allow.' }
            }
            owner = target
          }
          return await clientFor(owner.id, provider).readMail(id)
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    draft_email: tool({
      description:
        'Prepare an outbound email and show it to the family for approval. ALWAYS use this before send_email. Never send without an explicit human "yes" in a later message.',
      inputSchema: z.object({
        to: z.array(z.string()).min(1).describe('Recipient email addresses'),
        cc: z.array(z.string()).optional(),
        subject: z.string(),
        body: z.string().describe('Plain text body'),
        provider: providerEnum.optional().describe('Which linked account to send from'),
      }),
      execute: async ({ to, cc, subject, body, provider }) => {
        const member = requireMember(ctx)
        const linked = await linkedProviders(member.id)
        if (linked.length === 0) return { error: 'No email account linked. Send /connect to link one.' }
        const from = provider && linked.includes(provider) ? provider : linked[0]

        // A new draft to the same people is a revision: supersede the old one,
        // or every rewrite leaves another "pending" behind and "send it" has a
        // pile to choose from.
        const addressees = (list: string[]) => list.map((s) => s.trim().toLowerCase()).sort().join(',')
        const superseded: number[] = []
        for (const d of await pendingDrafts(ctx.chatId)) {
          if (d.memberId === member.id && addressees(d.recipients.split(',')) === addressees(to)) {
            if (await markDraft(d.id, 'cancelled')) superseded.push(d.id)
          }
        }

        const draft = await createDraft({
          chatId: ctx.chatId,
          memberId: member.id,
          provider: from,
          to,
          cc,
          subject,
          body,
        })
        return {
          draft_id: draft.id,
          from,
          to,
          cc: cc ?? [],
          subject,
          body,
          ...(superseded.length ? { superseded } : {}),
          next_step:
            'Show this draft verbatim and ask the sender to confirm. Only call send_email after they reply yes.',
        }
      },
    }),

    send_email: tool({
      description:
        'Send a previously drafted email. Only call this after the member who asked has explicitly confirmed the draft in a later message.',
      inputSchema: z.object({
        draft_id: z.number().int(),
        confirmed: z
          .boolean()
          .describe('Must be true, and only when the member has said yes to this exact draft'),
      }),
      execute: async ({ draft_id, confirmed }) => {
        const member = requireMember(ctx)
        if (!confirmed) return { error: 'Not sent: confirmation flag was false.' }

        const draft = await getDraft(draft_id)
        if (!draft) return { error: `No draft ${draft_id}.` }
        if (draft.memberId !== member.id) {
          return { error: 'Only the member who drafted this email can send it.' }
        }
        if (draft.status !== 'pending') return { error: `Draft ${draft_id} is already ${draft.status}.` }

        // Claim first: if two confirmations race, only one wins the send.
        if (!(await markDraft(draft_id, 'sent'))) {
          return { error: `Draft ${draft_id} was already handled.` }
        }
        try {
          await clientFor(member.id, draft.provider as Provider).sendMail({
            to: draft.recipients.split(',').map((s) => s.trim()).filter(Boolean),
            cc: draft.cc?.split(',').map((s) => s.trim()).filter(Boolean),
            subject: draft.subject,
            body: draft.body,
          })
          return { sent: true, to: draft.recipients, subject: draft.subject }
        } catch (e) {
          // Hand the draft back so the member can retry rather than lose it.
          await markDraft(draft_id, 'pending', 'sent')
          return { error: describe(e) }
        }
      },
    }),

    cancel_draft: tool({
      description: 'Discard a pending email draft the member decided against.',
      inputSchema: z.object({ draft_id: z.number().int() }),
      execute: async ({ draft_id }) => {
        requireMember(ctx)
        return (await markDraft(draft_id, 'cancelled'))
          ? { cancelled: true }
          : { error: `Draft ${draft_id} was not pending.` }
      },
    }),
  }
}

function describe(e: unknown): string {
  if (e instanceof NotConnectedError) {
    return `No ${e.provider} account linked. Send /connect to link one.`
  }
  return e instanceof Error ? e.message : String(e)
}
