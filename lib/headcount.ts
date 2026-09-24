import { GrammyError, HttpError } from 'grammy'
import { bot } from './telegram'
import { allowedMembers } from './db/queries'
import { idSet } from './env'
import { describeError } from './errors'

const PRESENT = new Set(['creator', 'administrator', 'member'])
/** How Telegram says a person is not in the chat at all, as opposed to not telling. */
const NOT_THERE = /user not found|participant_id_invalid|user_id_invalid|user_not_participant/i

/**
 * A hiccup rather than an answer: rate limited, Telegram's side down, or the
 * network. Thrown on, so the caller reports the real reason instead of
 * reading a blip as "cannot see this room".
 */
const transient = (err: unknown) =>
  err instanceof HttpError || (err instanceof GrammyError && (err.error_code === 429 || err.error_code >= 500))

/** What Telegram said, whether or not the message carries its description. */
const said = (err: unknown) => (err instanceof GrammyError ? `${err.message} ${err.description}` : describeError(err))

/**
 * How many people in a group the household cannot account for: Telegram's
 * head count, less the bot itself and each allowed member Telegram says is in
 * the room. A bot cannot list a group, and someone who was there before the
 * bot arrived and never speaks produces no join event and no message, so this
 * is the only check that sees them. Null when Telegram cannot say (the bot was
 * removed, or the group hides its members from a bot that is not an admin),
 * which callers read as "not safe to post".
 */
export async function unaccountedIn(chatId: string): Promise<number | null> {
  const api = bot().api
  let total: number
  let self: number
  try {
    ;[total, { id: self }] = await Promise.all([api.getChatMemberCount(chatId), api.getMe()])
  } catch (err) {
    if (transient(err)) throw err
    console.warn(`[headcount] could not count chat ${chatId}:`, said(err))
    return null
  }

  // Ids as Telegram numbers them: a zero-padded entry is the same person, and
  // the bot is already the one taken off the total.
  const ids = new Set<number>()
  for (const id of [...(await allowedMembers()).map((m) => m.telegramUserId), ...idSet('ALLOWED_TELEGRAM_IDS')]) {
    // A malformed seed entry is nobody, and not worth asking Telegram about.
    if (/^\d+$/.test(id) && Number(id) !== self) ids.add(Number(id))
  }

  const present = new Set<number>()
  for (const id of ids) {
    try {
      const m = await api.getChatMember(chatId, id)
      if (PRESENT.has(m.status) || (m.status === 'restricted' && m.is_member)) present.add(m.user.id)
    } catch (err) {
      if (transient(err)) throw err
      // An id Telegram has never seen in this chat is simply not there. Any
      // other refusal means the room cannot be seen, and a room that cannot be
      // seen is not one to post into.
      if (NOT_THERE.test(said(err))) continue
      console.warn(`[headcount] could not look up a member of chat ${chatId}:`, said(err))
      return null
    }
  }
  return Math.max(0, total - 1 - present.size)
}
