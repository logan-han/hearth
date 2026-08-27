import type { Update, Message } from 'grammy/types'
import { waitUntil } from '@vercel/functions'
import { send, typing, bot, downloadFile, mediaTypeFor, type Attachment } from './telegram'
import { runAgent, shouldChimeIn } from './agent'
import { idSet, appUrl, ambientMode } from './env'
import {
  upsertMember,
  memberByTelegramId,
  setMemberAllowed,
  allowedMembers,
  rememberChat,
  strangersIn,
  noteStranger,
  clearStranger,
  recordMessage,
  pruneMessages,
  connectionsFor,
  deleteConnection,
  calendarToken,
  addAutomation,
  listAutomations,
  allMembersWithLinks,
} from './db/queries'
import { nextRun, formatLocal } from './cron'
import { connectLink } from './oauth/state'
import type { Member } from './db/schema'

/**
 * Authorisation is per person, never per room. `ALLOWED_TELEGRAM_IDS` seeds the
 * founding members as admins; everyone else is granted by an admin with /allow
 * or added from the dashboard, so the env seed may legitimately stay empty.
 * A fresh deployment with neither seed nor members still accepts nobody.
 *
 * Returns the member when they may use the bot, or null when they may not.
 */
async function authorise(c: TelegramContext): Promise<Member | null> {
  if (idSet('ALLOWED_TELEGRAM_IDS').has(c.userId)) {
    return upsertMember(c.userId, c.userName, { allowed: true, isAdmin: true })
  }
  const existing = await memberByTelegramId(c.userId)
  if (!existing?.allowed) return null
  return upsertMember(c.userId, c.userName)
}

type TelegramContext = {
  chatId: string
  chatType: string
  chatTitle: string | null
  userId: string
  userName: string
  text: string
  messageId: number
  isReplyToBot: boolean
  isMention: boolean
  isCommand: boolean
  /** Photos, voice notes and documents the model should look at. */
  attachments: Attachment[]
  /** Author of the message being replied to, for `/allow` without an id. */
  replyToUserId?: string
  replyToUserName?: string
}

const SUPPORTED_DOC_TYPES = /^(image\/|application\/pdf$|audio\/)/

/**
 * Pull down anything the model can look at. Failures are swallowed on purpose:
 * a photo we cannot fetch should degrade to a text-only reply, not an error.
 */
async function collectAttachments(msg: Message): Promise<Attachment[]> {
  const out: Attachment[] = []

  const grab = async (fileId: string, kind: Attachment['kind'], declared?: string, name?: string) => {
    try {
      const { bytes, path } = await downloadFile(fileId)
      const mediaType = mediaTypeFor(name ?? path, declared)
      if (!SUPPORTED_DOC_TYPES.test(mediaType)) return
      out.push({ bytes, mediaType, filename: name, kind })
    } catch (err) {
      console.warn('[telegram] could not fetch attachment:', err instanceof Error ? err.message : err)
    }
  }

  // Telegram sends several resolutions; the last is the largest.
  const photo = msg.photo?.at(-1)
  if (photo) await grab(photo.file_id, 'photo')
  if (msg.voice) await grab(msg.voice.file_id, 'voice', msg.voice.mime_type, 'voice.oga')
  if (msg.audio) await grab(msg.audio.file_id, 'voice', msg.audio.mime_type, msg.audio.file_name)
  if (msg.document) {
    await grab(msg.document.file_id, 'document', msg.document.mime_type, msg.document.file_name)
  }
  return out
}

/**
 * getMe is stable for the life of the bot but costs an API round-trip, and the
 * handler needs it three times per update. Memoise it per lambda, keyed to the
 * bot instance so a token changed in the dashboard is not answered with the
 * old bot's identity.
 */
let meCache: {
  for: ReturnType<typeof bot>
  info: Promise<Awaited<ReturnType<ReturnType<typeof bot>['api']['getMe']>>>
} | null = null

function me() {
  const b = bot()
  if (meCache?.for !== b) meCache = { for: b, info: b.api.getMe() }
  return meCache.info
}

function displayName(from: NonNullable<Message['from']>): string {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || `user${from.id}`
}

async function parse(update: Update): Promise<TelegramContext | null> {
  const msg = update.message ?? update.edited_message
  if (!msg?.from || msg.from.is_bot) return null

  const text = msg.text ?? msg.caption ?? ''
  const attachments = await collectAttachments(msg)
  // A photo with no caption is still worth reading; a message with neither is not.
  if (!text.trim() && attachments.length === 0) return null

  const self = await me()
  const replyAuthor = msg.reply_to_message?.from
  const mentionTag = self.username ? `@${self.username}`.toLowerCase() : ''
  const isMention = Boolean(mentionTag) && text.toLowerCase().includes(mentionTag)

  return {
    chatId: String(msg.chat.id),
    chatType: msg.chat.type,
    chatTitle: 'title' in msg.chat ? (msg.chat.title ?? null) : null,
    userId: String(msg.from.id),
    userName: displayName(msg.from),
    text: text.trim(),
    messageId: msg.message_id,
    isReplyToBot: msg.reply_to_message?.from?.id === self.id,
    isMention,
    isCommand: text.trimStart().startsWith('/'),
    attachments,
    replyToUserId: replyAuthor && !replyAuthor.is_bot ? String(replyAuthor.id) : undefined,
    replyToUserName: replyAuthor && !replyAuthor.is_bot ? displayName(replyAuthor) : undefined,
  }
}

/** Strip the bot's own @mention so it does not leak into the prompt. */
async function cleanText(text: string): Promise<string> {
  const self = await me()
  if (!self.username) return text
  return text.replace(new RegExp(`@${self.username}`, 'gi'), '').trim()
}

/**
 * Ready-made watchers: the proactive half of the bot, one message to switch
 * on. Each is an ordinary automation, so /watch list, pausing and deleting all
 * work the same as anything scheduled by hand — and each instruction ends by
 * earning its silence, so a quiet run posts nothing.
 */
const WATCHERS: Record<string, { label: string; cron: string; instruction: string; needs?: string }> = {
  money: {
    label: '2Up transactions',
    cron: '0 9-22 * * *',
    instruction:
      'Call new_transactions on account "2up". If it returns any, post them — but explain, don\'t relay: ' +
      'say what each one likely is in household terms (the school, the mechanic, groceries), and point out anything ' +
      'notable — unusually large, a new merchant, a possible duplicate, a refund. If something stands out, you may pull ' +
      'quick context (recent spending, known household facts) before posting. The family can read raw amounts in their ' +
      'banking app; your job is the sentence that makes sense of them. If there are none, SKIP.',
  },
  inbox: {
    label: 'Inbox sweep',
    cron: '45 7 * * *',
    needs: 'a linked email account (send /connect first)',
    instruction:
      'Call new_mail. To read a full message found in someone else\'s mailbox, use read_email with of: their name. Mention only what the household would actually care about: appointments, school notices, bills, ' +
      'deliveries, bookings. For each, say why it matters and what needs doing, not just that it arrived. ' +
      'Propose any calendar-worthy dates with propose_family_event. Ignore newsletters and promotions. ' +
      'If there is nothing new, or nothing worth mentioning, SKIP.',
  },
  morning: {
    label: 'Morning brief',
    cron: '0 7 * * 1-5',
    instruction:
      "List today's family calendar events with list_family_events, any Jira tasks due today or overdue if Jira is configured, " +
      "and the day's weather via the weather tool if it is configured. " +
      'Post one short brief for the day, flagging anything that needs preparation — a form, a payment, an umbrella, an early start. ' +
      'If there is nothing on, nothing due and no weather worth a warning, SKIP.',
  },
}

async function handleWatch(c: TelegramContext, member: Member): Promise<void> {
  const which = c.text.split(/\s+/)[1]?.toLowerCase()
  const existing = await listAutomations(c.chatId)

  if (which === 'list') {
    if (existing.length === 0) {
      await send(c.chatId, 'Nothing is being watched in this chat yet. Send /watch to see what I can keep an eye on.')
      return
    }
    await send(
      c.chatId,
      'Watching in this chat:\n' +
        existing
          .map((a) => `· **${a.label}** — ${a.enabled ? `next ${formatLocal(a.nextRunAt)}` : 'paused'}`)
          .join('\n') +
        '\n\nAsk me in plain words to pause, change or delete any of them.',
    )
    return
  }

  const watcher = which ? WATCHERS[which] : undefined
  if (!watcher) {
    await send(
      c.chatId,
      [
        'I can keep watch and post here only when there is something worth saying:',
        '',
        '/watch money — new 2Up transactions, checked hourly 9am–10pm',
        c.chatType === 'private'
          ? '/watch inbox — your inbox each morning: things worth knowing, dates proposed for the calendar'
          : "/watch inbox — everyone's linked inboxes each morning: things worth knowing, dates proposed for the calendar",
        "/watch morning — a weekday brief: today's family calendar and anything due on the board",
        '/watch list — what this chat is already watching',
        '',
        'Anything else, just describe it: "every Friday 5pm, remind us to book the market run".',
      ].join('\n'),
    )
    return
  }

  // An inbox watcher in the family group sweeps everyone's linked mailboxes;
  // in a DM it is personal, bound to whoever switched it on.
  let label = watcher.label
  let instruction = watcher.instruction
  if (which === 'inbox') {
    if (c.chatType !== 'private') {
      label = 'Family inbox sweep'
      instruction =
        'Call new_mail with everyone set to true — every linked mailbox in the family, saying whose mailbox each item came from. ' +
        instruction.replace('Call new_mail. ', '')
      const people = await allMembersWithLinks()
      if (!people.some((m) => m.allowed && m.linked.length > 0)) {
        await send(c.chatId, `That one needs ${WATCHERS.inbox.needs}.`)
        return
      }
    } else {
      label = `${c.userName}'s inbox`
      if ((await connectionsFor(member.id)).length === 0) {
        await send(c.chatId, `That one needs ${WATCHERS.inbox.needs}.`)
        return
      }
    }
  }

  const dupe = existing.find((a) => a.enabled && a.label.toLowerCase() === label.toLowerCase())
  if (dupe) {
    await send(c.chatId, `Already watching — **${dupe.label}** runs next ${formatLocal(dupe.nextRunAt)}.`)
    return
  }

  const next = nextRun(watcher.cron)
  if (!next) {
    await send(c.chatId, 'That schedule will never fire; this is a bug worth reporting.')
    return
  }
  await addAutomation({
    chatId: c.chatId,
    memberId: member.id,
    label,
    cronExpr: watcher.cron,
    instruction,
    nextRunAt: next,
  })
  await send(
    c.chatId,
    `Watching. **${label}** first runs ${formatLocal(next)}, and posts only when there is something to say.`,
  )
}

const HELP = [
  '**Hearth** — your family assistant.',
  '',
  'Just talk to me. In the group, @mention me or reply to one of my messages.',
  '',
  '**Commands**',
  '/watch — have me check money, inbox or the day ahead, and post only when it matters',
  '/connect — link your Google or Microsoft account',
  '/accounts — see and unlink your linked accounts',
  '/calendar — the shared family calendar subscription link',
  '/whoami — your Telegram id',
  '/members — who I answer to',
  '/help — this message',
  '',
  '**Admin only**',
  '/allow <id> — let someone use me (or reply to their message)',
  '/deny <id> — revoke someone',
  '',
  '**Things I can do**',
  '· answer questions, with a web search when it matters',
  '· read photos of school notices and invitations, and pull the dates out',
  '· keep shared lists: "add milk to the shopping list", "got the milk"',
  '· answer money questions: "how much have we spent this month?"',
  '· look things up in Notion, and add to a page',
  '· track household jobs on the Jira board: "what\'s overdue?"',
  '· read your email and calendar, and draft replies (I never send without a yes)',
  '· keep the shared family calendar everyone subscribes to',
  '· remember household facts, and run reminders on a schedule',
].join('\n')

async function handleCommand(c: TelegramContext, member: Member): Promise<boolean> {
  const cmd = c.text.split(/[\s@]/)[0].toLowerCase()

  switch (cmd) {
    case '/start':
    case '/help':
      await send(c.chatId, HELP)
      return true

    case '/connect': {
      const link = await connectLink(appUrl(), { tg: c.userId, name: c.userName, chat: c.chatId })
      const body = `Link an account (this link is personal and expires in 30 minutes):\n${link}`
      try {
        await send(c.userId, body)
        if (c.chatType !== 'private') await send(c.chatId, `${c.userName}, I have sent you the link in a DM.`)
      } catch {
        // The member has never opened a DM with the bot, so we cannot message them.
        await send(
          c.chatId,
          `${c.userName}, start a direct message with me first, then send /connect again.`,
        )
      }
      return true
    }

    case '/accounts': {
      const conns = await connectionsFor(member.id)
      await send(
        c.chatId,
        conns.length
          ? `Linked accounts:\n${conns.map((x) => `· ${x.provider}${x.email ? ` — ${x.email}` : ''}`).join('\n')}\n\nUnlink with /unlink google or /unlink microsoft.`
          : 'You have no linked accounts. Send /connect to add one.',
      )
      return true
    }

    case '/unlink': {
      const which = c.text.split(/\s+/)[1]?.toLowerCase()
      if (which !== 'google' && which !== 'microsoft') {
        await send(c.chatId, 'Usage: /unlink google — or — /unlink microsoft')
        return true
      }
      await deleteConnection(member.id, which)
      await send(c.chatId, `Unlinked your ${which} account.`)
      return true
    }

    case '/whoami':
      await send(c.chatId, `You are **${c.userName}**, id \`${c.userId}\`${member.isAdmin ? ' (admin)' : ''}.`)
      return true

    case '/members': {
      const people = await allowedMembers()
      await send(
        c.chatId,
        `I answer to ${people.length} ${people.length === 1 ? 'person' : 'people'}:\n` +
          people.map((m) => `· ${m.name} \`${m.telegramUserId}\`${m.isAdmin ? ' (admin)' : ''}`).join('\n'),
      )
      return true
    }

    case '/allow':
    case '/deny': {
      if (!member.isAdmin) {
        await send(c.chatId, 'Only an admin can do that.')
        return true
      }
      const granting = cmd === '/allow'
      const target = c.text.split(/\s+/)[1]?.replace(/[^0-9]/g, '') || c.replyToUserId
      if (!target) {
        await send(c.chatId, `Usage: \`${cmd} <telegram id>\`, or reply to one of their messages with \`${cmd}\`.`)
        return true
      }
      if (!granting && target === c.userId) {
        await send(c.chatId, 'You cannot revoke yourself.')
        return true
      }
      if (!granting && idSet('ALLOWED_TELEGRAM_IDS').has(target)) {
        // The env seed is re-applied on their next message, so clearing the row
        // here would silently undo itself. Say so rather than pretend.
        await send(
          c.chatId,
          `\`${target}\` is a founding member, set in ALLOWED_TELEGRAM_IDS. ` +
            'Remove them from that setting (dashboard Settings, or the deployment env); I cannot revoke them from here.',
        )
        return true
      }
      if (granting) {
        const name = c.replyToUserId === target ? (c.replyToUserName ?? `user${target}`) : `user${target}`
        await upsertMember(target, name, { allowed: true })
        await clearStranger(c.chatId, target)
        await send(c.chatId, `Done, \`${target}\` can use me now.`)
      } else {
        const row = await setMemberAllowed(target, false)
        await send(c.chatId, row ? `Revoked \`${target}\`.` : `I have no record of \`${target}\`.`)
      }
      return true
    }

    case '/watch': {
      await handleWatch(c, member)
      return true
    }

    case '/calendar': {
      const url = `${appUrl()}/api/calendar/${await calendarToken()}/family.ics`
      await send(
        c.chatId,
        `Subscribe to the family calendar with this URL:\n\`${url}\`\n\nGoogle Calendar → Other calendars → From URL. Apple/Outlook → Add calendar → Subscribe from web.`,
      )
      return true
    }

    default:
      return false
  }
}

/** Decide whether this message deserves a full agent run. */
async function shouldRespond(c: TelegramContext, messageId: number): Promise<boolean> {
  if (c.chatType === 'private') return true
  if (c.isMention || c.isReplyToBot || c.isCommand) return true
  if (!ambientMode()) return false
  return shouldChimeIn({
    chatId: c.chatId,
    text: c.text,
    memberName: c.userName,
    excludeMessageId: messageId,
  })
}

/**
 * Join and leave events. Telegram tells us who entered a room, which is the
 * only reliable moment to notice an outsider: a bot cannot enumerate a group's
 * membership, so anyone who never speaks is otherwise invisible.
 */
async function handleMembershipChange(update: Update): Promise<boolean> {
  const msg = update.message
  if (!msg) return false
  const chatId = String(msg.chat.id)

  if (msg.left_chat_member) {
    await clearStranger(chatId, String(msg.left_chat_member.id))
    return true
  }

  const joined = msg.new_chat_members
  if (!joined?.length) return false

  const self = await me()
  const flagged: string[] = []
  for (const person of joined) {
    if (person.is_bot && person.id === self.id) continue
    const name = displayName(person)
    if (person.is_bot || !(await isAllowedId(String(person.id)))) {
      if (await noteStranger(chatId, { id: String(person.id), name })) flagged.push(`${name} (${person.id})`)
    }
  }
  if (flagged.length) {
    await rememberChat(chatId, msg.chat.type, 'title' in msg.chat ? (msg.chat.title ?? null) : null)
    await send(
      chatId,
      `I don't recognise ${flagged.join(', ')}, so I'll stay quiet here.\n\n` +
        'An admin can vouch for them with `/allow <id>` (or reply to one of their messages with `/allow`). ' +
        'Remove them and I resume automatically.',
    )
  }
  return true
}

/** Is this Telegram id allowed, by env seed or by an admin's grant? */
async function isAllowedId(userId: string): Promise<boolean> {
  if (idSet('ALLOWED_TELEGRAM_IDS').has(userId)) return true
  return (await memberByTelegramId(userId))?.allowed ?? false
}

/**
 * Someone we do not know sent a message. In a group they become a flagged
 * stranger. In a DM we answer only the one question they can reasonably need
 * answered, which is what their own id is, so an admin can vouch for them.
 */
async function handleUnknownSender(c: TelegramContext): Promise<void> {
  console.warn(`[telegram] unauthorised user=${c.userId} chat=${c.chatId}`)

  if (c.chatType === 'private') {
    const cmd = c.text.split(/[\s@]/)[0].toLowerCase()
    if (['/start', '/whoami', '/id', '/help'].includes(cmd)) {
      await send(
        c.chatId,
        `Your Telegram id is \`${c.userId}\`.\n\nSend it to whoever runs this bot and ask them to add you.`,
      )
    }
    return
  }

  await rememberChat(c.chatId, c.chatType, c.chatTitle)
  if (await noteStranger(c.chatId, { id: c.userId, name: c.userName })) {
    await send(
      c.chatId,
      `I don't recognise ${c.userName} (\`${c.userId}\`), so I'll stay quiet here until an admin runs ` +
        '`/allow ' + c.userId + '`.',
    )
  }
}

/** True when the room holds someone unrecognised, in which case we said so. */
async function refuseForStrangers(c: TelegramContext): Promise<boolean> {
  const strangers = await strangersIn(c.chatId)
  if (strangers.length === 0) return false
  await send(
    c.chatId,
    `Not while ${strangers.map((s) => s.name).join(', ')} ${strangers.length > 1 ? 'are' : 'is'} here. ` +
      'An admin can vouch for them with `/allow`, or remove them and I resume.',
    c.messageId,
  )
  return true
}

/** Full processing, run after the webhook has already acked. */
export async function processUpdate(update: Update): Promise<void> {
  if (await handleMembershipChange(update)) return

  const c = await parse(update)
  if (!c) return

  const member = await authorise(c)
  if (!member) {
    await handleUnknownSender(c)
    return
  }

  await rememberChat(c.chatId, c.chatType, c.chatTitle)
  // Seeing an allowed member speak clears any stale flag against them.
  await clearStranger(c.chatId, c.userId)
  const text = await cleanText(c.text)
  // History is text-only, so note that something was attached rather than
  // leaving a bare caption with no explanation of what it described.
  const forHistory = c.attachments.length
    ? `${text} [sent ${c.attachments.map((a) => a.kind).join(', ')}]`.trim()
    : text

  // Every group message becomes context, whether or not we reply to it.
  const storedId = await recordMessage({
    chatId: c.chatId,
    memberId: member.id,
    authorName: c.userName,
    role: 'user',
    content: forHistory,
  })

  if (c.isCommand && (await handleCommand(c, member))) return
  if (!(await shouldRespond(c, storedId))) {
    await pruneMessages(c.chatId)
    return
  }
  // A room containing someone unrecognised is not a room to read a private
  // inbox aloud in, so refuse everything until they are vouched for or gone.
  if (c.chatType !== 'private' && (await refuseForStrangers(c))) {
    await pruneMessages(c.chatId)
    return
  }

  await typing(c.chatId)
  try {
    const result = await runAgent({
      chatId: c.chatId,
      chatType: c.chatType,
      member,
      memberName: c.userName,
      text,
      excludeMessageId: storedId,
      attachments: c.attachments,
    })

    const reply = [result.text, ...result.notices.filter((n) => !result.text.includes(n))]
      .filter(Boolean)
      .join('\n\n')
      .trim()

    if (reply) {
      await send(c.chatId, reply, c.chatType === 'private' ? undefined : c.messageId)
      await recordMessage({ chatId: c.chatId, role: 'assistant', content: reply, model: result.model })
    }
  } catch (err) {
    console.error('[agent] run failed:', err)
    await send(c.chatId, `Sorry, that went wrong: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    try {
      await pruneMessages(c.chatId)
    } catch (err) {
      // Trimming history is housekeeping; never let it mask a delivered reply.
      console.error('[telegram] prune failed:', err)
    }
  }
}

/** Ack immediately, then keep working past the response. */
export function processInBackground(update: Update): void {
  waitUntil(
    processUpdate(update).catch((err) => console.error('[telegram] processing failed:', err)),
  )
}
