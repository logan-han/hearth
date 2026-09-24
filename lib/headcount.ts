import { bot } from './telegram'
import { allowedMembers } from './db/queries'
import { idSet } from './env'
import { describeError } from './errors'

const PRESENT = new Set(['creator', 'administrator', 'member'])
/** How Telegram says a person is not in the chat at all, as opposed to not telling. */
const NOT_THERE = /user not found|participant_id_invalid|user_id_invalid|user_not_participant/i

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
  try {
    total = await api.getChatMemberCount(chatId)
  } catch (err) {
    console.warn(`[headcount] could not count chat ${chatId}:`, describeError(err))
    return null
  }

  const ids = new Set([...(await allowedMembers()).map((m) => m.telegramUserId), ...idSet('ALLOWED_TELEGRAM_IDS')])
  let known = 0
  for (const id of ids) {
    // A malformed seed entry is nobody, and not worth asking Telegram about.
    if (!/^\d+$/.test(id)) continue
    try {
      const m = await api.getChatMember(chatId, Number(id))
      if (PRESENT.has(m.status) || (m.status === 'restricted' && m.is_member)) known++
    } catch (err) {
      // An id Telegram has never seen in this chat is simply not there. Any
      // other refusal means the room cannot be seen, and a room that cannot be
      // seen is not one to post into.
      if (NOT_THERE.test(describeError(err))) continue
      console.warn(`[headcount] could not look up a member of chat ${chatId}:`, describeError(err))
      return null
    }
  }
  return Math.max(0, total - 1 - known)
}
