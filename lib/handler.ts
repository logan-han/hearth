import type { Update, Message } from 'grammy/types'
import { waitUntil } from '@vercel/functions'
import { send, typing, bot, downloadFile, mediaTypeFor, type Attachment } from './telegram'
import { runAgent, shouldChimeIn, unconfirmedLine } from './agent'
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
  clearStrangerEverywhere,
  setChatLeft,
  moveChat,
  recordMessage,
  pruneMessages,
  connectionsFor,
  deleteConnection,
  calendarToken,
  rotateCalendarToken,
  FEED_EDGE_SECONDS,
  addAutomation,
  listAutomations,
  setAutomationEnabled,
  issueMcpKey,
  revokeMcpKey,
} from './db/queries'
import { nextRun, formatLocal } from './cron'
import { connectLink } from './oauth/state'
import { WATCHERS, isWatcherKind, watcherInstruction } from './watchers'
import { flushTelemetry } from './telemetry'
import { maybeSummarise } from './summary'
import type { Member } from './db/schema'
import { describeError } from './errors'
import { unsaid } from './notices'
import { commitCursors } from './tools/cursor'
import { flagRevoked } from './headcount'
import { awaitTurn, endTurn, noteAlbumItem, takeAlbum } from './turns'

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
  /** A command naming another bot (`/roll@dice_bot`), which is that bot's to answer. */
  forAnotherBot: boolean
  /** Photos, voice notes and documents the model might look at, not yet fetched. */
  media: Media[]
  /** Telegram's media_group_id: the album this message is one item of. */
  albumId?: string
  /** Author of the message being replied to, for `/allow` without an id. */
  replyToUserId?: string
  replyToUserName?: string
}

/**
 * What the model can be shown. Images, PDFs and audio go to it as files; text
 * files, a calendar export (.ics) above all, are read in code and handed over
 * as text, since the model endpoints accept no other file types.
 */
const SUPPORTED_DOC_TYPES = /^(image\/|application\/pdf$|audio\/|text\/)/

function isCalendarBytes(bytes: Uint8Array): boolean {
  return /^\s*BEGIN:VCALENDAR/i.test(new TextDecoder().decode(bytes.slice(0, 64)))
}

/** A file a message carries, as Telegram describes it, before anything is fetched. */
type Media = { fileId: string; kind: Attachment['kind']; declared?: string; name?: string }

/**
 * What a message carries that the model might read. Nothing is fetched here:
 * that waits until the sender is known to be a member and the message is being
 * answered, so a stranger's forwarded 20 MB file, or a photo in the group
 * nobody asked about, costs no download. A document whose declared type is one
 * no model reads is not worth fetching at all; one that declares nothing
 * useful may still be a calendar export, which only its name or its bytes give
 * away.
 */
function mediaIn(msg: Message): Media[] {
  const out: Media[] = []
  // Telegram sends several resolutions; the last is the largest.
  const photo = msg.photo?.at(-1)
  if (photo) out.push({ fileId: photo.file_id, kind: 'photo' })
  if (msg.voice) out.push({ fileId: msg.voice.file_id, kind: 'voice', declared: msg.voice.mime_type, name: 'voice.oga' })
  if (msg.audio) out.push({ fileId: msg.audio.file_id, kind: 'voice', declared: msg.audio.mime_type, name: msg.audio.file_name })
  const doc = msg.document
  if (doc) {
    const type = mediaTypeFor(doc.file_name ?? '', doc.mime_type)
    if (SUPPORTED_DOC_TYPES.test(type) || type === 'application/octet-stream' || /\.ics$/i.test(doc.file_name ?? '')) {
      out.push({ fileId: doc.file_id, kind: 'document', declared: doc.mime_type, name: doc.file_name })
    }
  }
  return out
}

/**
 * Pull down anything the model can look at. Failures are swallowed on purpose:
 * a photo we cannot fetch should degrade to a text-only reply, not an error.
 */
async function collectAttachments(media: Media[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const { fileId, kind, declared, name } of media) {
    try {
      const { bytes, path } = await downloadFile(fileId)
      let mediaType = mediaTypeFor(name ?? path, declared)
      // A calendar export forwarded from a mail app often arrives with no
      // useful type or extension; the file itself says what it is.
      if (!SUPPORTED_DOC_TYPES.test(mediaType) && isCalendarBytes(bytes)) mediaType = 'text/calendar'
      if (!SUPPORTED_DOC_TYPES.test(mediaType)) continue
      out.push({ bytes, mediaType, filename: name, kind })
    } catch (err) {
      console.warn('[telegram] could not fetch attachment:', describeError(err))
    }
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
  if (meCache?.for !== b) {
    const info = b.api.getMe()
    meCache = { for: b, info }
    // A failed lookup is not the bot's identity. Kept, one 502 from Telegram
    // failed every update this instance served until it was recycled; dropped,
    // the next update asks again.
    info.catch(() => {
      if (meCache?.info === info) meCache = null
    })
  }
  return meCache.info
}

function displayName(from: NonNullable<Message['from']>): string {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || `user${from.id}`
}

async function parse(update: Update): Promise<TelegramContext | null> {
  // An edit is not a new message. Answered again, "milk and eggs" corrected to
  // "milk and bread" put milk on the list twice, and a reminder whose time was
  // corrected fired at both. Webhooks registered before edits were dropped
  // from allowed_updates still deliver them.
  const msg = update.message
  if (!msg?.from || msg.from.is_bot) return null

  const text = msg.text ?? msg.caption ?? ''
  const media = mediaIn(msg)
  // A photo with no caption is still worth reading; a message with neither is not.
  if (!text.trim() && media.length === 0) return null

  const self = await me()
  const replyAuthor = msg.reply_to_message?.from
  const mentionTag = self.username ? `@${self.username}`.toLowerCase() : ''
  const isMention = Boolean(mentionTag) && text.toLowerCase().includes(mentionTag)
  // In a group with several bots, Telegram's menu names the bot a command is
  // for. Only a bare command, or one naming this bot, is Hearth's.
  const addressee = /^\/\w+@(\w+)/.exec(text.trimStart())?.[1]?.toLowerCase()
  const forAnotherBot = addressee !== undefined && addressee !== self.username?.toLowerCase()

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
    isCommand: text.trimStart().startsWith('/') && !forAnotherBot,
    forAnotherBot,
    media,
    albumId: msg.media_group_id,
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

  // Mail used to be a watcher of its own; its job moved into the morning brief.
  const asked = which === 'inbox' ? 'morning' : which
  const watcher = isWatcherKind(asked) ? WATCHERS[asked] : undefined
  if (!watcher) {
    const inGroup = c.chatType !== 'private'
    await send(
      c.chatId,
      [
        'I can keep watch and post here only when there is something worth saying:',
        '',
        inGroup
          ? "/watch morning — a brief each day at 7am: today's family calendar, everyone's new mail worth knowing about (dates proposed for the calendar), anything overdue on the board, and the weather"
          : "/watch morning — a brief each day at 7am: today's family calendar, your new mail worth knowing about (dates proposed for the calendar), anything overdue on the board, and the weather",
        "/watch snapshot — Sunday 6pm: the week's spending, the month so far, and how the budget is tracking",
        '/watch money — new 2Up transactions, checked hourly 9am–10pm',
        '/watch list — what this chat is already watching',
        '',
        ...(inGroup ? ['The brief and the snapshot are already on in a family group; pause either from Home if it is not wanted.', ''] : []),
        'Anything else, just describe it: "every Friday 5pm, remind us to book the market run".',
      ].join('\n'),
    )
    return
  }

  const note = which === 'inbox' ? 'Mail is part of the morning brief now. ' : ''
  const have = existing.find((a) => a.kind === watcher.kind)
  if (have?.enabled) {
    await send(c.chatId, `${note}Already watching — **${have.label}** runs next ${formatLocal(have.nextRunAt)}.`)
    return
  }

  const next = nextRun(watcher.cron)
  if (!next) {
    await send(c.chatId, 'That schedule will never fire; this is a bug worth reporting.')
    return
  }

  // A paused one is switched back on rather than doubled.
  if (have) {
    await setAutomationEnabled(have.id, true, next)
    await send(c.chatId, `${note}Resumed. **${have.label}** next runs ${formatLocal(next)}, and posts only when there is something to say.`)
    return
  }

  // In a DM the brief is personal, bound to whoever switched it on, so it
  // reads their own mailbox. The tick route fetches the data itself; the
  // instruction only says how to phrase it.
  await addAutomation({
    chatId: c.chatId,
    memberId: member.id,
    label: watcher.label,
    cronExpr: watcher.cron,
    instruction: watcherInstruction(watcher.kind, c.chatId),
    kind: watcher.kind,
    nextRunAt: next,
  })
  await send(
    c.chatId,
    `${note}Watching. **${watcher.label}** first runs ${formatLocal(next)}, and posts only when there is something to say.`,
  )
}

const HELP = [
  '**Hearth** — your family assistant.',
  '',
  'Just talk to me. In the group, @mention me or reply to one of my messages.',
  '',
  '**Commands**',
  "/watch — have me keep an eye on the day ahead, the week's money or 2Up, and post only when it matters",
  '/connect — link your Google or Microsoft account',
  '/accounts — see and unlink your linked accounts',
  '/calendar — the shared family calendar subscription link',
  '/mcp — let Claude use my tools on your behalf',
  '/whoami — your Telegram id',
  '/members — who I answer to',
  '/help — this message',
  '',
  '**Admin only**',
  '/allow <id> — let someone use me (or reply to their message)',
  '/deny <id> — revoke someone',
  '/calendar new — replace the calendar URL, if it has got out',
  '',
  '**Things I can do**',
  '· answer questions, with a web search when it matters',
  '· read photos of notices, letters and invitations, and pull the dates out',
  '· keep shared lists: "add milk to the shopping list", "got the milk"',
  '· answer money questions: "how much have we spent this month?"',
  '· look things up in Notion, and add to a page',
  '· track household jobs on the Jira board: "what\'s overdue?"',
  '· read your email and calendar, and draft replies (I never send without a yes)',
  '· keep the shared family calendar everyone subscribes to',
  '· remember household facts, and run reminders on a schedule',
].join('\n')

/** The command word, without any @botname: `/Calendar@hearth_bot new` is `/calendar`. */
function commandOf(text: string): string {
  return text.split(/[\s@]/)[0].toLowerCase()
}

/** Commands that reveal nothing of the household, so they still run in a room with a stranger in it. */
const SAFE_WITH_STRANGERS = new Set(['/start', '/help', '/whoami', '/connect', '/mcp', '/unlink', '/allow', '/deny'])

async function handleCommand(c: TelegramContext, member: Member): Promise<boolean> {
  const cmd = commandOf(c.text)

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
        // Vouched for here or in a DM, they are family in every room.
        await clearStrangerEverywhere(target)
        await send(c.chatId, `Done, \`${target}\` can use me now.`)
      } else {
        const row = await setMemberAllowed(target, false)
        if (!row) {
          await send(c.chatId, `I have no record of \`${target}\`.`)
          return true
        }
        const quiet = await flagRevoked(row)
        await send(
          c.chatId,
          `Revoked \`${target}\`.` +
            (quiet.length ? ` I'll stay quiet in ${quiet.join(', ')} while they are there.` : '') +
            ' If they had the family calendar URL, `/calendar new` replaces it.',
        )
      }
      return true
    }

    case '/watch': {
      await handleWatch(c, member)
      return true
    }

    case '/calendar': {
      const howTo = 'Google Calendar → Other calendars → From URL. Apple/Outlook → Add calendar → Subscribe from web.'
      if (c.text.split(/\s+/)[1]?.toLowerCase() !== 'new') {
        const url = `${appUrl()}/api/calendar/${await calendarToken()}/family.ics`
        await send(c.chatId, `Subscribe to the family calendar with this URL:\n\`${url}\`\n\n${howTo}`)
        return true
      }
      if (!member.isAdmin) {
        await send(c.chatId, 'Only an admin can do that.')
        return true
      }
      // The old URL got out somewhere, quite possibly in this room, so the new
      // one goes to the admin alone to pass on.
      const url = `${appUrl()}/api/calendar/${await rotateCalendarToken()}/family.ics`
      const note = `The old calendar URL has stopped working (a cached copy can answer for up to ${FEED_EDGE_SECONDS / 60} minutes). `
      try {
        await send(c.userId, `${note}Everyone subscribed needs to subscribe again with this one:\n\`${url}\`\n\n${howTo}`)
        if (c.chatType !== 'private') await send(c.chatId, `${note}${c.userName}, I have sent you the new one in a DM to pass on.`)
      } catch {
        await send(c.chatId, `${note}${c.userName}, start a direct message with me and send /calendar there for the new one.`)
      }
      return true
    }

    case '/mcp': {
      await handleMcp(c, member)
      return true
    }

    default:
      return false
  }
}

/**
 * A key for the MCP endpoint, which is every tool Hearth has, in this member's
 * name. It is only ever shown the once, so /mcp on its own says what is there
 * rather than reissuing and quietly breaking whatever is already connected.
 * The key goes by DM even when asked for in the group: it is one person's.
 */
async function handleMcp(c: TelegramContext, member: Member): Promise<void> {
  const sub = c.text.split(/\s+/)[1]?.toLowerCase()

  if (sub === 'off') {
    await revokeMcpKey(member.id)
    await send(c.chatId, 'Revoked. Anything connected with that key stops working now.')
    return
  }

  if (member.mcpTokenAt && sub !== 'new') {
    await send(
      c.chatId,
      `You have a key, issued ${formatLocal(member.mcpTokenAt)}. I only ever show one once, so ` +
        'if it is lost or no longer works, `/mcp new` replaces it — which stops the old one working. ' +
        '`/mcp off` revokes it.',
    )
    return
  }

  const key = await issueMcpKey(member.id)
  const url = `${appUrl()}/api/mcp`
  const body = [
    member.mcpTokenAt ? 'Here is a new key; the old one has stopped working.' : 'Here is your key.',
    '',
    'In Claude Code:',
    `\`claude mcp add --transport http hearth ${url} --header "Authorization: Bearer ${key}"\``,
    '',
    `Anywhere else: \`${url}\`, with that key as a bearer token.`,
    '',
    'It acts as you: your mail, your calendar, the household calendar and lists. ' +
      'Keep it to yourself, and send `/mcp off` if it gets out.',
  ].join('\n')

  try {
    await send(c.userId, body)
    if (c.chatType !== 'private') await send(c.chatId, `${c.userName}, I have sent you the key in a DM.`)
  } catch {
    // No DM open with the bot, and a key this powerful is not going in a group.
    await revokeMcpKey(member.id)
    await send(c.chatId, `${c.userName}, start a direct message with me first, then send /mcp again.`)
  }
}

/** Decide whether this message deserves a full agent run. */
async function shouldRespond(c: TelegramContext, messageId: number): Promise<boolean> {
  // Even as a reply to one of ours: the command names who it is for.
  if (c.forAnotherBot) return false
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
  // The bot's own comings and goings. A room it was removed from stops
  // counting as the household's: no built-in watchers there, and never the
  // room an MCP call acts in.
  const own = update.my_chat_member
  if (own) {
    const next = own.new_chat_member
    const gone = next.status === 'left' || next.status === 'kicked' || (next.status === 'restricted' && !next.is_member)
    await setChatLeft(String(own.chat.id), gone)
    return true
  }

  const msg = update.message
  if (!msg) return false
  const chatId = String(msg.chat.id)

  // Made a supergroup, the room has a new id; both ends of the change say so.
  if (msg.migrate_to_chat_id) {
    await moveChat(chatId, String(msg.migrate_to_chat_id))
    return true
  }
  if (msg.migrate_from_chat_id) {
    await moveChat(String(msg.migrate_from_chat_id), chatId)
    return true
  }

  if (msg.left_chat_member) {
    await clearStranger(chatId, String(msg.left_chat_member.id))
    return true
  }

  const joined = msg.new_chat_members
  if (!joined?.length) return false

  const self = await me()
  const unknown: typeof joined = []
  for (const person of joined) {
    if (person.is_bot && person.id === self.id) continue
    if (person.is_bot || !(await isAllowedId(String(person.id)))) unknown.push(person)
  }
  if (!unknown.length) return true

  // The flag lives on the chat's row, which a room nobody has spoken in yet
  // (the bot added alongside an outsider, say) does not have.
  await rememberChat(chatId, msg.chat.type, 'title' in msg.chat ? (msg.chat.title ?? null) : null)
  const flagged: string[] = []
  for (const person of unknown) {
    const name = displayName(person)
    if (await noteStranger(chatId, { id: String(person.id), name })) flagged.push(`${name} (${person.id})`)
  }
  if (flagged.length) {
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
    const cmd = commandOf(c.text)
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
  // Seeing an allowed member speak clears any stale flag against them, in
  // every room: whoever is let through here is family everywhere. A founder
  // re-granted by ALLOWED_TELEGRAM_IDS, or added to it in Settings, never went
  // through /allow, so this is the only place their other rooms unmute.
  await clearStrangerEverywhere(c.userId)
  const text = await cleanText(c.text)
  // History is text-only, so note that something was attached rather than
  // leaving a bare caption with no explanation of what it described. A file's
  // name goes in too, so a later "the .ics I sent" can at least be recognised.
  const forHistory = c.media.length
    ? `${text} [sent ${c.media.map((m) => (m.name ? `${m.kind} ${m.name}` : m.kind)).join(', ')}]`.trim()
    : text

  // Every group message becomes context, whether or not we reply to it.
  const storedId = await recordMessage({
    chatId: c.chatId,
    memberId: member.id,
    authorName: c.userName,
    role: 'user',
    content: forHistory,
  })

  if (c.isCommand) {
    // A room holding someone unrecognised hears only the commands that give
    // nothing away: /calendar would hand them the feed, /accounts and /members
    // the family's addresses and ids. /allow stays, being how a room unmutes.
    if (c.chatType !== 'private' && !SAFE_WITH_STRANGERS.has(commandOf(c.text)) && (await refuseForStrangers(c))) {
      await housekeeping(c.chatId)
      return
    }
    if (await handleCommand(c, member)) return
  }
  // Every item of an album is noted, answering or not, so that the one that
  // answers has all of them.
  const part = { messageId: c.messageId, text, media: c.media }
  if (c.albumId) await noteAlbumItem(c.chatId, c.albumId, part)
  if (!(await shouldRespond(c, storedId))) {
    await housekeeping(c.chatId)
    return
  }
  // A room containing someone unrecognised is not a room to read a private
  // inbox aloud in, so refuse everything until they are vouched for or gone.
  if (c.chatType !== 'private' && (await refuseForStrangers(c))) {
    await housekeeping(c.chatId)
    return
  }

  // An album is one message to the family, so it gets one answer, from
  // whichever of its items takes the album first, with every page in it.
  let parts = [part]
  if (c.albumId) {
    const album = await takeAlbum<typeof part>(c.chatId, c.albumId)
    if (!album) {
      await housekeeping(c.chatId)
      return
    }
    parts = album
  }
  const said = parts.map((p) => p.text).filter(Boolean).join('\n')
  const attachments = await collectAttachments(parts.flatMap((p) => p.media))
  // Nothing to answer: a file with no caption turned out to be nothing a model reads.
  if (!said && attachments.length === 0) {
    await housekeeping(c.chatId)
    return
  }

  const turn = await awaitTurn(c.chatId, storedId)
  await typing(c.chatId)
  try {
    const result = await runAgent({
      chatId: c.chatId,
      chatType: c.chatType,
      member,
      memberName: c.userName,
      text: said,
      excludeMessageId: storedId,
      attachments,
    })

    const reply = [result.text, ...unsaid(result.text, result.notices)]
      .filter(Boolean)
      .join('\n\n')
      .trim()

    if (reply) {
      try {
        await send(c.chatId, reply, c.chatType === 'private' ? undefined : c.messageId)
      } catch (err) {
        // The turn itself worked, and whatever it wrote stands, so this is not
        // "that went wrong", which would be asked again and done twice.
        console.error('[telegram] reply not confirmed:', err)
        await sayUnconfirmed(c.chatId, result.wrote, result.unconfirmed)
        return
      }
    }
    // What the reply reported as new is now seen; a send that failed leaves it new.
    await commitCursors(result.cursors)
    if (reply) await recordMessage({ chatId: c.chatId, role: 'assistant', content: reply, model: result.model })
  } catch (err) {
    console.error('[agent] run failed:', err)
    await send(c.chatId, `Sorry, that went wrong: ${describeError(err)}`)
  } finally {
    await endTurn(c.chatId, turn)
    await housekeeping(c.chatId)
  }
}

/**
 * Tell the chat a finished turn's reply may be missing, and keep that in the
 * history, where the next turn sees what was done before doing it again. When
 * this fails too, only the log has it.
 */
async function sayUnconfirmed(chatId: string, wrote: readonly string[] | undefined, unconfirmed?: readonly string[]): Promise<void> {
  const line = unconfirmedLine(wrote, unconfirmed)
  try {
    await send(chatId, line)
    await recordMessage({ chatId, role: 'assistant', content: line })
  } catch (err) {
    console.error('[telegram] could not say the reply was not confirmed:', err)
  }
}

/**
 * Trim the stored history and fold what fell out of the raw window into the
 * chat's summary. Housekeeping never masks a delivered reply, so each step
 * swallows its own failure.
 */
async function housekeeping(chatId: string): Promise<void> {
  try {
    await pruneMessages(chatId)
  } catch (err) {
    console.error('[telegram] prune failed:', err)
  }
  try {
    await maybeSummarise(chatId)
  } catch (err) {
    console.error('[telegram] summary failed:', err)
  }
}

/** Ack immediately, then keep working past the response. */
export function processInBackground(update: Update): void {
  waitUntil(
    processUpdate(update)
      .catch((err) => console.error('[telegram] processing failed:', err))
      // The function ends when this promise settles; traces must be out first.
      .finally(() => flushTelemetry()),
  )
}
