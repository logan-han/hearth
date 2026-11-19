import { tool } from 'ai'
import { z } from 'zod'
import { clientFor, clientsFor, type MailFile, type MailSummary } from '../providers'
import { NotConnectedError, ReconnectNeededError } from '../providers/token'
import { parseIcs, describeIcs } from '../ics-parse'
import { createDraft, getDraft, markDraft, connectionsFor, pendingDrafts } from '../db/queries'
import { currentCursor, stageCursor } from './cursor'
import type { ToolContext } from './context'
import { requireMember, connectPage } from './context'
import { providerConfig, type Provider } from '../oauth/providers'
import { describeError } from '../errors'
import { timezone } from '../env'
import { UnconfirmedError } from '../deadline'

export const providerEnum = z.enum(['google', 'microsoft'])

/**
 * A recipient as both providers take one: a bare address. A line break could
 * start a header of its own in the message Gmail is sent (a hidden Bcc, say),
 * a comma would split the stored list, and Graph wants the address alone.
 */
const ADDRESS = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/

/** A mailbox as the family names it, owner first. The provider is an id for read_email, not a name. */
const mailboxName = (owner: string, provider: Provider) => `${owner}'s ${providerConfig(provider).mailbox}`

/** The accounts a member linked, and which of them they linked to be read only. */
async function linkedProviders(memberId: number): Promise<{ all: Provider[]; writable: Provider[] }> {
  const conns = await connectionsFor(memberId)
  return {
    all: conns.map((c) => c.provider as Provider),
    writable: conns.filter((c) => !c.readOnly).map((c) => c.provider as Provider),
  }
}

/** Why nothing can be written from an account its owner linked to be read only, and how they would allow it. */
export const readOnlyRefusal = (provider: Provider) =>
  `Your ${providerConfig(provider).label} account is linked read-only, so nothing is drafted, sent or put on its calendar through it. ` +
  `You can allow it again on Hearth's Connect page: ${connectPage()}.`

/** What a member is told when they have nothing linked to read or write through. */
export const nothingLinked = (what: 'email account' | 'calendar') => `No ${what} linked. Link one on Hearth's Connect page: ${connectPage()}.`

export function mailTools(ctx: ToolContext) {
  return {
    list_email: tool({
      description:
        "List or search your own linked mailbox(es). A search spans the whole mailbox, archived mail included, " +
        'so an email that is not in the inbox is still findable. Searches every linked account unless a provider is given.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Optional search terms, e.g. "from:<sender>" or a word from the subject. Omit for the latest inbox mail.'),
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
        if (clients.length === 0) return { error: nothingLinked('email account') }
        const scope = (everywhere ?? Boolean(query)) ? ('all' as const) : ('inbox' as const)

        const out = await Promise.all(
          clients.map(async (c) => {
            try {
              return { mailbox: mailboxName(member.name, c.provider), provider: c.provider, messages: await c.listMail({ query, limit, scope }) }
            } catch (e) {
              return { mailbox: mailboxName(member.name, c.provider), provider: c.provider, error: describeAccountError(e) }
            }
          }),
        )
        return { accounts: out }
      },
    }),

    new_mail: tool({
      description:
        'Email that has arrived in your own mailbox(es) since this client last asked. Each MCP key, each scheduled job and the morning brief ' +
        'keep markers of their own, so the same message is never reported twice to the same reader and one reader never spends what another has not seen. ' +
        'Returns empty lists when there is nothing new. Only the newest `limit` are listed; the rest are counted in more_not_shown and will not be listed again, ' +
        'so ask for a higher limit up front if they matter.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(30).default(10).describe('Per mailbox'),
      }),
      execute: async ({ limit }) => newMail(ctx, limit ?? 10),
    }),

    read_email: tool({
      description:
        'Read the full body of one of your emails by its id, as returned by list_email or new_mail, with its attachments listed by filename.',
      inputSchema: z.object({
        id: z.string(),
        provider: providerEnum,
      }),
      execute: async ({ id, provider }) => {
        const member = requireMember(ctx)
        try {
          const mail = await clientFor(member.id, provider).readMail(id)
          return mail.attachments?.length
            ? { ...mail, note: 'Read an attachment with read_attachment, giving this email id, the provider and the filename as listed.' }
            : mail
        } catch (e) {
          return { error: describeAccountError(e) }
        }
      },
    }),

    read_attachment: tool({
      description:
        'Read a file attached to one of your emails: the email id and provider from list_email or new_mail, and the filename as read_email lists it. ' +
        'A PDF or a text file comes back as its text, a calendar file as its events. An image cannot be read this way yet.',
      inputSchema: z.object({
        email_id: z.string(),
        provider: providerEnum,
        filename: z.string().describe("The attachment's filename, exactly as read_email listed it"),
      }),
      execute: async ({ email_id, provider, filename }) => {
        const member = requireMember(ctx)
        try {
          const file = await clientFor(member.id, provider).readAttachment(email_id, filename)
          return await fileToText(file)
        } catch (e) {
          return { error: describeAccountError(e) }
        }
      },
    }),

    draft_email: tool({
      description:
        'Prepare an outbound email from your own account and show it for approval. ALWAYS use this before send_email, and never send without an explicit human "yes" to the draft.',
      inputSchema: z.object({
        to: z.array(z.string()).min(1).describe('Recipient email addresses'),
        cc: z.array(z.string()).optional(),
        subject: z.string(),
        body: z.string().describe('Plain text body'),
        provider: providerEnum.optional().describe('Which linked account to send from'),
      }),
      execute: async ({ to, cc, subject, body, provider }) => {
        const member = requireMember(ctx)
        const notAddress = [...to, ...(cc ?? [])].find((a) => !ADDRESS.test(a.trim()))
        if (notAddress !== undefined) {
          return { error: `"${notAddress}" is not an email address. Give each recipient as a bare address, like name@example.com.` }
        }
        const linked = await linkedProviders(member.id)
        if (linked.all.length === 0) return { error: nothingLinked('email account') }
        // An account its owner linked to be read only is never written from, and is not swapped for another unasked.
        if (provider && linked.all.includes(provider) && !linked.writable.includes(provider)) return { error: readOnlyRefusal(provider) }
        if (linked.writable.length === 0) return { error: readOnlyRefusal(linked.all[0]) }
        const from = provider && linked.writable.includes(provider) ? provider : linked.writable[0]

        // A new draft to the same people is a revision: supersede the old one,
        // or every rewrite leaves another "pending" behind and "send it" has a
        // pile to choose from.
        const addressees = (list: string[]) => list.map((s) => s.trim().toLowerCase()).sort().join(',')
        const superseded: number[] = []
        for (const d of await pendingDrafts(member.id)) {
          if (addressees(d.recipients.split(',')) === addressees(to)) {
            if (await markDraft(d.id, 'cancelled')) superseded.push(d.id)
          }
        }

        const draft = await createDraft({
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
            'Show this draft verbatim and ask the sender to confirm. Only call send_email after they say yes to it.',
        }
      },
    }),

    send_email: tool({
      description:
        'Send a previously drafted email. Only call this after the member who asked has explicitly said yes to this exact draft.',
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
        // Made read-only since the draft was written, the account sends nothing.
        if ((await connectionsFor(member.id)).some((c) => c.provider === draft.provider && c.readOnly)) {
          return { error: readOnlyRefusal(draft.provider as Provider) }
        }
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
          // A send that ran out of time may have gone all the same, and a
          // draft handed back could then go twice. It stays claimed. A timeout
          // before it, on the token, is a send never made, and goes back below.
          if (e instanceof UnconfirmedError) {
            return {
              error:
                'The send took too long to be confirmed, so it may or may not have gone. ' +
                'Check the Sent folder before drafting it again.',
              maybe_done: true,
            }
          }
          // Hand the draft back so the member can retry rather than lose it.
          await markDraft(draft_id, 'pending', 'sent')
          return { error: describeAccountError(e) }
        }
      },
    }),

    cancel_draft: tool({
      description: 'Discard a pending email draft the member decided against.',
      inputSchema: z.object({ draft_id: z.number().int() }),
      execute: async ({ draft_id }) => {
        const member = requireMember(ctx)
        const draft = await getDraft(draft_id)
        if (!draft || draft.memberId !== member.id) return { error: `No draft ${draft_id} of yours.` }
        return (await markDraft(draft_id, 'cancelled'))
          ? { cancelled: true }
          : { error: `Draft ${draft_id} was not pending.` }
      },
    }),
  }
}

/**
 * What has arrived in the member's own mailboxes since this reader last
 * looked, on markers of the reader's own (ctx.cursorScope): an MCP key, a
 * scheduled job, the morning brief. The moves are staged, not made, and
 * whoever delivers the result commits them, so a look that reaches nobody
 * leaves the mail new.
 */
export async function newMail(ctx: ToolContext, max: number): Promise<Record<string, unknown>> {
  const member = requireMember(ctx)
  const clients = await clientsFor(member.id)
  if (clients.length === 0) return { error: nothingLinked('email account') }
  // The address each of their mailboxes is, so mail that only copies them in says so.
  const own = new Map((await connectionsFor(member.id)).map((conn) => [conn.provider, conn.email]))
  const accounts: object[] = []
  for (const c of clients) {
    try {
      const key = `mail_cursor:${ctx.cursorScope ?? 'own'}:${member.id}:${c.provider}`
      const cursor = await currentCursor(ctx, key)
      // The first look reaches back only a few hours, so a new reader does
      // not replay the whole inbox.
      const since = cursor ? new Date(cursor.at) : new Date(ctx.now.getTime() - 6 * 3600_000)

      // Only the inbox counts here, and only what arrived since the last look:
      // the newest few of a fortnight would cut a busy day's older mail out unseen.
      const found = await c.listMail({ limit: MAIL_WINDOW, scope: 'inbox', since })
      const seen = new Set(cursor?.ids ?? [])
      // A message with an unparseable date is kept: the remembered ids
      // still stop it repeating, and dropping it would lose real mail.
      const fresh = found.filter((m) => {
        if (seen.has(m.id)) return false
        const at = new Date(m.date)
        return Number.isNaN(at.getTime()) || at >= since
      })
      // Newest first. What does not fit is said as a count rather than
      // dropped without a word; the cursor still moves past it, so a busy
      // inbox never leaves tomorrow's brief reading yesterday's mail.
      const shown = fresh.slice(0, max)
      const unshown = fresh.length - shown.length

      // Staged, not written: the move is made once this result reaches someone.
      if (fresh.length > 0) {
        const stamps = fresh.map((m) => new Date(m.date).getTime()).filter((t) => !Number.isNaN(t))
        const newest = stamps.length ? new Date(Math.max(...stamps)).toISOString() : ctx.now.toISOString()
        stageCursor(ctx, key, newest, fresh.map((m) => m.id), cursor)
      } else if (!cursor) {
        stageCursor(ctx, key, ctx.now.toISOString(), [], null)
      }

      accounts.push({
        mailbox: mailboxName(member.name, c.provider),
        provider: c.provider,
        first_check: !cursor,
        messages: shown.map((m) => arrival(m, own.get(c.provider))),
        ...(unshown > 0
          ? { more_not_shown: unshown, ...(found.length >= MAIL_WINDOW ? { more_not_shown_is_at_least: true } : {}) }
          : {}),
      })
    } catch (e) {
      accounts.push({ mailbox: mailboxName(member.name, c.provider), provider: c.provider, error: describeAccountError(e) })
    }
  }
  return { accounts }
}

/** What a member is told when one of their linked accounts fails: not linked, its link expired, or the error itself. */
export function describeAccountError(e: unknown): string {
  if (e instanceof NotConnectedError) {
    return `No ${e.provider} account linked. Link one on Hearth's Connect page: ${connectPage()}.`
  }
  if (e instanceof ReconnectNeededError) {
    return `The ${e.provider} link has expired or been revoked. Link it again on Hearth's Connect page: ${connectPage()}.`
  }
  return describeError(e)
}

/** How much new mail one look reads per mailbox; the most a provider hands back in one page. */
const MAIL_WINDOW = 50

/** The recipients in one address header, each name kept with its address. */
const recipients = (list: string) =>
  list
    .split(/(?<=>|@[^\s,;<>]+)\s*[,;]\s*/)
    .map((r) => r.trim())
    .filter(Boolean)

/** The bare addresses in one, lower-cased for comparing. */
const addressesIn = (list: string) => (list.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) ?? []).map((a) => a.toLowerCase())

/** A recipient list kept short: mail to a whole class names its first few and counts the rest. */
function fewOf(list: string, max = 3): string {
  const all = recipients(list)
  return all.length > max ? `${all.slice(0, max).join(', ')} and ${all.length - max} more` : all.join(', ')
}

/**
 * Whether mail came to its mailbox only as a copy: the owner on its Cc and not
 * its To. What it asks, it asks of whoever it was to. A brief once told the
 * household it had been asked to come in, when the email had asked a teacher
 * that with a parent copied in; it was handed the sender and never the
 * recipients, so nothing it read said whom the email was for.
 */
function copiedIn(m: Pick<MailSummary, 'to' | 'cc'>, owner: string | null | undefined): boolean {
  const me = owner?.trim().toLowerCase()
  if (!me) return false
  return addressesIn(m.cc).includes(me) && !addressesIn(m.to).includes(me)
}

/** New mail as new_mail lists it: who sent it, to whom, and whether its mailbox was only copied in. */
function arrival(m: MailSummary, owner: string | null | undefined) {
  return {
    id: m.id,
    from: m.from,
    ...(m.to ? { to: fewOf(m.to) } : {}),
    ...(m.cc ? { cc: fewOf(m.cc) } : {}),
    ...(copiedIn(m, owner) ? { copied_in: true } : {}),
    subject: m.subject,
    snippet: m.snippet,
    date: m.date,
  }
}

/** The largest email attachment read here: a PDF of a school newsletter, not a video. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_CHARS = 12_000

/**
 * What a caller can be told about a file. A PDF and a text file go as text,
 * because a tool result is text; a calendar file as its events, parsed here
 * so time zones, all-day dates and repeats are worked out in code. An image
 * is the one thing this cannot carry, and it says so rather than describing
 * nothing.
 */
export async function fileToText(file: MailFile): Promise<Record<string, unknown>> {
  const { filename, mimeType } = file
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { error: `"${filename}" is ${Math.round(file.bytes.byteLength / 1e6)} MB, too large to read here.` }
  }
  const clip = (text: string) => (text.length > MAX_ATTACHMENT_CHARS ? `${text.slice(0, MAX_ATTACHMENT_CHARS)}\n[cut off here]` : text)

  if (mimeType === 'application/pdf' || ext === 'pdf') {
    const { extractText } = await import('unpdf')
    const { text, totalPages } = await extractText(file.bytes, { mergePages: true })
    const body = text.trim()
    return body
      ? { filename, type: 'pdf', pages: totalPages, text: clip(body) }
      : { filename, type: 'pdf', pages: totalPages, text: '', note: 'This PDF has no text layer (a scan), so nothing could be read from it.' }
  }
  if (mimeType === 'text/calendar' || ext === 'ics') {
    return { filename, type: 'calendar', text: describeIcs(parseIcs(new TextDecoder().decode(file.bytes)), filename, timezone(), MAX_ATTACHMENT_CHARS) }
  }
  if (mimeType.startsWith('text/') || ['txt', 'csv', 'md'].includes(ext)) {
    return { filename, type: 'text', text: clip(new TextDecoder().decode(file.bytes)) }
  }
  if (mimeType.startsWith('image/')) {
    return { error: `"${filename}" is an image, and an image attached to an email cannot be read here yet.` }
  }
  return { error: `"${filename}" (${mimeType}) is not a kind of file that can be read here.` }
}
