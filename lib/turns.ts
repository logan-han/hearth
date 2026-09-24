import { and, eq, like, sql } from 'drizzle-orm'
import { db } from './db'
import { settings } from './db/schema'
import { randomToken } from './crypto'

/*
 * What has to hold between the messages of one chat. Telegram delivers each
 * message as an update of its own, each is answered in an invocation of its
 * own, and the next may well land on another instance, so this is kept in the
 * database, in rows of the settings table under keys of its own, and never in
 * memory.
 */

/** Longer than a webhook invocation may run, so a turn the platform cuts off frees its chat by itself. */
const TURN_HOLD_MS = 300_000
/** How long a message waits for the turn ahead of it before going ahead anyway: a late answer beats none. */
const TURN_WAIT_MS = 90_000
const TURN_POLL_MS = 1_000

/** Where a message waiting for its chat says so, with the time it stops waiting as the value. */
const waitingPrefix = (chatId: string) => `turnq:${chatId}:`

/**
 * Wait for the chat to be free, then hold it. A chat's messages are answered
 * one at a time, so a quick follow-up ("actually, oat milk") is answered once
 * the reply to the message before it exists, with that reply in view, rather
 * than alongside it with both acting on the same words. Returns the hold to
 * hand back to endTurn, or null when the wait ran out and the turn goes ahead
 * without one.
 *
 * Waiting messages are answered in the order they came, by `storedId`, the
 * id of the message's row in the history. Each waiter polls on its own clock,
 * so once the chat came free it went to whichever polled first: of "add
 * milk", "and eggs" and "and bread", the bread could be answered before the
 * eggs, adding both, and then the eggs answered again with the bread's reply
 * in view but not the question it answered. So each waiter says it is
 * waiting, and a free chat is taken only by the earliest message still
 * waiting. One still on its way here, fetching its attachments say, has not
 * said so yet and is not waited for.
 */
export async function awaitTurn(chatId: string, storedId: number): Promise<string | null> {
  const key = `turn:${chatId}`
  const giveUpAt = Date.now() + TURN_WAIT_MS
  const waiting = `${waitingPrefix(chatId)}${storedId}`
  // A waiter cut off mid-wait leaves its row; it is cleared once its wait would have run out.
  await db()
    .delete(settings)
    .where(sql`case when ${settings.key} like 'turnq:%' then ${settings.value}::bigint < ${Date.now()} else false end`)
  await db()
    .insert(settings)
    .values({ key: waiting, value: String(giveUpAt) })
    .onConflictDoUpdate({ target: settings.key, set: { value: String(giveUpAt) } })
  try {
    for (;;) {
      if (!(await waitingAhead(chatId, storedId))) {
        const hold = `${Date.now() + TURN_HOLD_MS} ${randomToken(8)}`
        const taken = await db()
          .insert(settings)
          .values({ key, value: hold })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: hold },
            // Only a hold that has lapsed is taken over.
            setWhere: sql`split_part(${settings.value}, ' ', 1)::bigint < ${Date.now()}`,
          })
          .returning({ key: settings.key })
        if (taken.length) return hold
      }
      if (Date.now() >= giveUpAt) return null
      await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS))
    }
  } finally {
    // A row left behind holds back later messages only until its wait runs
    // out, while a throw here would lose the hold just taken, freed by nobody
    // for five minutes.
    await db()
      .delete(settings)
      .where(eq(settings.key, waiting))
      .catch((err) => console.error('[turns] could not clear a waiting row:', err))
  }
}

/** Whether an earlier message in the chat is still waiting its turn. */
async function waitingAhead(chatId: string, storedId: number): Promise<boolean> {
  const prefix = waitingPrefix(chatId)
  const rows = await db().select().from(settings).where(like(settings.key, `${prefix}%`))
  const now = Date.now()
  return rows.some((r) => Number(r.key.slice(prefix.length)) < storedId && Number(r.value) > now)
}

/** Free the chat, unless the hold lapsed and another turn has it now. */
export async function endTurn(chatId: string, hold: string | null): Promise<void> {
  if (!hold) return
  await db().delete(settings).where(and(eq(settings.key, `turn:${chatId}`), eq(settings.value, hold)))
}

/** How long the item answering for an album gives the rest of it to arrive. */
const ALBUM_SETTLE_MS = 1_500
/** An album nobody answered is cleared once it is this old, as the next is noted. */
const ALBUM_KEEP_MS = 60_000

const albumKey = (chatId: string, albumId: string) => `album:${chatId}:${albumId}`

/**
 * Note one item of an album where the item that answers can find it. Telegram
 * sends each photo of an album as a message of its own, and in a group only
 * the one with the caption is addressed to the bot, so every item leaves what
 * it carries here, whether or not it goes on to answer.
 */
export async function noteAlbumItem<T extends { messageId: number }>(chatId: string, albumId: string, item: T): Promise<void> {
  // The case keeps the cast off every other row: SQL promises nothing about
  // the order a filter's terms are read in.
  await db()
    .delete(settings)
    .where(
      sql`case when ${settings.key} like 'album:%'
        then (${settings.value}::jsonb -> 0 ->> 'at')::bigint < ${Date.now() - ALBUM_KEEP_MS}
        else false end`,
    )
  await db()
    .insert(settings)
    .values({ key: albumKey(chatId, albumId), value: JSON.stringify([{ ...item, at: Date.now() }]) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`(${settings.value}::jsonb || excluded.value::jsonb)::text` },
    })
}

/**
 * Give the rest of an album a moment to be noted, then take all of it for one
 * turn, in the order it was sent. Only the first item to take it gets
 * anything; null means another item is answering for the album.
 */
export async function takeAlbum<T extends { messageId: number }>(chatId: string, albumId: string): Promise<T[] | null> {
  await new Promise((resolve) => setTimeout(resolve, ALBUM_SETTLE_MS))
  const [row] = await db()
    .delete(settings)
    .where(eq(settings.key, albumKey(chatId, albumId)))
    .returning({ value: settings.value })
  if (!row) return null
  return (JSON.parse(row.value) as T[]).sort((a, b) => a.messageId - b.messageId)
}
