import { and, asc, desc, eq, gte, inArray, lte, lt, ne, or, sql, isNull, gt, exists, notExists, ilike } from 'drizzle-orm'
import { db } from './index'
import {
  members, chats, connections, messages, familyEvents, memories, memoryQuestions, automations, settings, emailDrafts,
  lists, listItems, eventProposals,
  type Member, type Connection, type EmailDraft, type Stranger,
  type List, type ListItem, type EventProposal, type Memory, type MemoryQuestion,
} from './schema'
import { encrypt, decrypt, randomToken, hashToken, mintMcpKey, mcpKeyHolder } from '../crypto'
import { rankSimilar, findCorrected, DUPLICATE } from '../memory-match'
import type { Provider } from '../oauth/providers'

export const MAX_HISTORY = 200
/** Talk younger than this is kept however many rows it runs to: System charts a fortnight of it. */
export const HISTORY_DAYS = 14
/** Raw messages the model sees verbatim; older talk arrives as the chat's summary. */
export const CONTEXT_WINDOW = 15

/* ---------------------------------------------------------------- members */

/**
 * Record a person and refresh their display name. `grant` only ever raises
 * privileges, so seeing a seeded admin speak can never demote them, and an
 * ordinary member can never be silently promoted by a name change.
 */
export async function upsertMember(
  telegramUserId: string,
  name: string,
  grant: { allowed?: boolean; isAdmin?: boolean } = {},
): Promise<Member> {
  const raise: Partial<typeof members.$inferInsert> = { name }
  if (grant.allowed) raise.allowed = true
  if (grant.isAdmin) raise.isAdmin = true
  const [row] = await db()
    .insert(members)
    .values({ telegramUserId, name, allowed: grant.allowed ?? false, isAdmin: grant.isAdmin ?? false })
    .onConflictDoUpdate({ target: members.telegramUserId, set: raise })
    .returning()
  return row
}

export async function setMemberAllowed(telegramUserId: string, allowed: boolean) {
  const [row] = await db()
    .update(members)
    .set(allowed ? { allowed: true } : { allowed: false, isAdmin: false })
    .where(eq(members.telegramUserId, telegramUserId))
    .returning()
  return row
}

/** Everyone who may talk to the bot, in any room. */
export async function allowedMembers(): Promise<Member[]> {
  return db().select().from(members).where(eq(members.allowed, true)).orderBy(asc(members.id))
}

export async function memberByTelegramId(telegramUserId: string): Promise<Member | undefined> {
  const [row] = await db().select().from(members).where(eq(members.telegramUserId, telegramUserId)).limit(1)
  return row
}

export async function allMembers(): Promise<Member[]> {
  return db().select().from(members).orderBy(asc(members.id))
}

/* --------------------------------------------------------------- MCP keys */

/**
 * Mint this member's key for the MCP endpoint, replacing whatever they had:
 * one key per person, so revoking is always unambiguous. The plaintext is
 * returned once and never stored. It carries a tag only this deployment can
 * make (see mintMcpKey), so a made-up one is turned away before any read.
 */
export async function issueMcpKey(memberId: number): Promise<string> {
  const key = await mintMcpKey(memberId)
  await db()
    .update(members)
    .set({ mcpTokenHash: await hashToken(key), mcpTokenAt: new Date() })
    .where(eq(members.id, memberId))
  return key
}

export async function revokeMcpKey(memberId: number): Promise<void> {
  await db()
    .update(members)
    .set({ mcpTokenHash: null, mcpTokenAt: null })
    .where(eq(members.id, memberId))
}

/**
 * Who a bearer key belongs to, or null. A member who has since been denied
 * holds nothing: the allowlist is the one gate, here as everywhere else.
 *
 * The key's tag is checked first, with nothing read. Looking up every key sent
 * let anyone who knew the host keep Neon awake by posting made-up ones every
 * few minutes, which runs out the free plan's compute hours. A key whose tag
 * checks was minted here for that member, and its stored hash then says
 * whether it is still theirs: a replaced or revoked one no longer matches.
 */
export async function memberByMcpKey(key: string): Promise<Member | null> {
  const holder = await mcpKeyHolder(key)
  if (holder === null) return null
  const [row] = await db()
    .select()
    .from(members)
    .where(and(eq(members.id, holder), eq(members.mcpTokenHash, await hashToken(key)), eq(members.allowed, true)))
    .limit(1)
  return row ?? null
}

/* ------------------------------------------------------------------ chats */

export async function rememberChat(chatId: string, type: string, title: string | null) {
  // A message from the room is proof the bot is in it, whatever was said before.
  await db()
    .insert(chats)
    .values({ chatId, type, title })
    .onConflictDoUpdate({ target: chats.chatId, set: { type, title, leftAt: null } })
}

/** Telegram says the bot was removed from a room, or added back to one it knew. */
export async function setChatLeft(chatId: string, left: boolean): Promise<void> {
  await db()
    .update(chats)
    .set({ leftAt: left ? new Date() : null })
    .where(eq(chats.chatId, chatId))
}

export async function chatSummary(chatId: string): Promise<{ summary: string | null; through: number }> {
  const [row] = await db()
    .select({ summary: chats.summary, through: chats.summaryThrough })
    .from(chats)
    .where(eq(chats.chatId, chatId))
    .limit(1)
  return { summary: row?.summary ?? null, through: row?.through ?? 0 }
}

export async function setChatSummary(chatId: string, summary: string, through: number): Promise<void> {
  await db()
    .update(chats)
    .set({ summary, summaryThrough: through, summaryAt: new Date() })
    .where(eq(chats.chatId, chatId))
}

/** Messages newer than an id, oldest first. */
export async function messagesAfter(chatId: string, afterId: number, limit = MAX_HISTORY) {
  return db()
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), gt(messages.id, afterId)))
    .orderBy(asc(messages.id))
    .limit(limit)
}

export async function strangersIn(chatId: string): Promise<Stranger[]> {
  const [row] = await db().select().from(chats).where(eq(chats.chatId, chatId)).limit(1)
  return parseStrangers(row?.strangers)
}

/** The household's rooms: every group the bot is still in, with who there is unrecognised. */
export async function groupChats(): Promise<{ chatId: string; title: string | null; strangers: Stranger[] }[]> {
  const rows = await db()
    .select()
    .from(chats)
    .where(and(inArray(chats.type, ['group', 'supergroup']), isNull(chats.leftAt)))
    .orderBy(asc(chats.id))
  return rows.map((r) => ({ chatId: r.chatId, title: r.title, strangers: parseStrangers(r.strangers) }))
}

/**
 * The groups the bot is still in that this member has talked in, the one
 * they talked in last first. Having spoken there is the evidence the history
 * holds that they belong to the room, and the room they spoke in last is the
 * one they are using.
 */
export async function roomsOf(memberId: number): Promise<{ chatId: string; title: string | null; strangers: Stranger[] }[]> {
  const last = sql`max(${messages.id})`
  const rows = await db()
    .select({ chatId: chats.chatId, title: chats.title, strangers: chats.strangers })
    .from(chats)
    .innerJoin(messages, and(eq(messages.chatId, chats.chatId), eq(messages.memberId, memberId)))
    .where(and(inArray(chats.type, ['group', 'supergroup']), isNull(chats.leftAt)))
    .groupBy(chats.id)
    .orderBy(desc(last))
  return rows.map((r) => ({ chatId: r.chatId, title: r.title, strangers: parseStrangers(r.strangers) }))
}

function parseStrangers(raw: string | undefined | null): Stranger[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Stranger[]).filter((s) => s && typeof s.id === 'string') : []
  } catch {
    return []
  }
}

/*
 * The list is changed in the database, in one statement each, rather than
 * read, changed here and written back: updates are handled side by side, and
 * two outsiders noted at once would otherwise leave only the second on the
 * list, with the first in the room and the bot talking.
 */

/** Matches a room whose list already holds this person. */
const holds = (userId: string) => sql`${chats.strangers}::jsonb @> ${JSON.stringify([{ id: userId }])}::jsonb`

/** Returns true when this is the first time we have seen that stranger here. */
export async function noteStranger(chatId: string, stranger: Stranger): Promise<boolean> {
  // True only if a row took it: a stranger reported as flagged but written
  // nowhere is a room the bot goes on talking in.
  const written = await db()
    .update(chats)
    .set({ strangers: sql`(${chats.strangers}::jsonb || ${JSON.stringify([stranger])}::jsonb)::text` })
    .where(and(eq(chats.chatId, chatId), sql`not ${holds(stranger.id)}`))
    .returning({ id: chats.id })
  return written.length > 0
}

const without = (userId: string) =>
  sql`coalesce((select jsonb_agg(e) from jsonb_array_elements(${chats.strangers}::jsonb) e where e->>'id' <> ${userId}), '[]'::jsonb)::text`

export async function clearStranger(chatId: string, userId: string): Promise<void> {
  await db().update(chats).set({ strangers: without(userId) }).where(and(eq(chats.chatId, chatId), holds(userId)))
}

/** Vouched for, so a stranger nowhere: a grant made in a DM or on the dashboard unmutes every room they are in. */
export async function clearStrangerEverywhere(userId: string): Promise<void> {
  await db().update(chats).set({ strangers: without(userId) }).where(holds(userId))
}

/**
 * Telegram gives a group a new id when it becomes a supergroup, and the old
 * id is dead from then on. Everything kept under it moves across: the room's
 * row with its stranger flags and summary, its history, automations, drafts
 * and proposals, and the settings keyed by the room, the sweep cursors among
 * them, so the brief does not read the inbox out again. Both ends of the
 * upgrade announce it, so this runs twice and is safe to. Should the new id
 * have a row already (someone spoke there first), it gains the old one's
 * strangers and its summary, which covers the longer history, and a built-in
 * watcher already installed there gives way to the one the household had,
 * paused or not.
 */
export async function moveChat(from: string, to: string): Promise<void> {
  if (from === to) return
  await db().execute(sql`
    insert into chats (chat_id, type, title, strangers, summary, summary_through, summary_at, created_at)
    select ${to}, 'supergroup', title, strangers, summary, summary_through, summary_at, created_at
    from chats where chat_id = ${from}
    on conflict (chat_id) do update set
      strangers = (
        select coalesce(jsonb_agg(e), '[]'::jsonb)::text from (
          select distinct on (e->>'id') e
          from jsonb_array_elements(chats.strangers::jsonb || excluded.strangers::jsonb) e
        ) merged
      ),
      summary = coalesce(excluded.summary, chats.summary),
      summary_through = case when excluded.summary is null then chats.summary_through else excluded.summary_through end,
      summary_at = case when excluded.summary is null then chats.summary_at else excluded.summary_at end
  `)
  await db().delete(chats).where(eq(chats.chatId, from))
  await db().update(messages).set({ chatId: to }).where(eq(messages.chatId, from))
  await db().execute(sql`
    delete from automations
    where chat_id = ${to} and kind in (select kind from automations where chat_id = ${from} and kind is not null)
  `)
  await db().update(automations).set({ chatId: to }).where(eq(automations.chatId, from))
  await db().update(emailDrafts).set({ chatId: to }).where(eq(emailDrafts.chatId, from))
  await db().update(eventProposals).set({ chatId: to }).where(eq(eventProposals.chatId, from))
  // Keys name the room as one colon-separated part: mail_cursor:<chat>:…,
  // proactive_posts:<chat>. One the new room has already written stays. A
  // turn's hold, a waiting message's row and an album's items stay put: the
  // invocation answering in the old room frees and takes them by the old id,
  // and moved, a hold would keep the new room waiting for five minutes.
  const keyed = sql`(${settings.key} like ${`%:${from}:%`} or ${settings.key} like ${`%:${from}`})
    and ${settings.key} not like 'turn:%' and ${settings.key} not like 'turnq:%' and ${settings.key} not like 'album:%'`
  await db().execute(sql`
    insert into settings (key, value)
    select replace(key, ${`:${from}`}, ${`:${to}`}), value from settings where ${keyed}
    on conflict (key) do nothing
  `)
  await db().delete(settings).where(keyed)
}

/* --------------------------------------------------------------- messages */

export async function recordMessage(input: {
  chatId: string
  memberId?: number | null
  authorName?: string | null
  role: 'user' | 'assistant'
  content: string
  model?: string | null
}): Promise<number> {
  const [row] = await db()
    .insert(messages)
    .values({
      chatId: input.chatId,
      memberId: input.memberId ?? null,
      authorName: input.authorName ?? null,
      role: input.role,
      content: input.content.slice(0, 8000),
      model: input.model ?? null,
    })
    .returning({ id: messages.id })
  return row.id
}

/**
 * The last `limit` messages in a chat, oldest first. `excludeId` drops the
 * message currently being answered, which the caller has already stored, and
 * whatever members said after it: that came later, and read as history it sat
 * ahead of the question it followed. The bot's own replies since are kept, so
 * a turn that waited for the one before it sees what that one said.
 */
export async function recentMessages(chatId: string, limit = CONTEXT_WINDOW, excludeId?: number) {
  const where = excludeId
    ? and(eq(messages.chatId, chatId), or(lt(messages.id, excludeId), ne(messages.role, 'user')))
    : eq(messages.chatId, chatId)
  const rows = await db()
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit)
  return rows.reverse()
}

/**
 * The last day's talk across every chat, oldest first, for the nightly memory
 * pass. On a day with more than `limit` messages it is the newest that are
 * kept, since the pass is about what was said most recently.
 */
export async function messagesSince(hours: number, limit = 400) {
  const rows = await db()
    .select({
      chatId: messages.chatId,
      authorName: messages.authorName,
      role: messages.role,
      content: messages.content,
    })
    .from(messages)
    .where(gte(messages.createdAt, new Date(Date.now() - hours * 3600_000)))
    .orderBy(desc(messages.id))
    .limit(limit)
  return rows.reverse()
}

/**
 * Keep the table bounded: drop what is older than both the newest `keep` rows
 * and the last `days`. A count alone let a chatty group lose its week-old
 * talk, which left System's fortnight with empty days and the nightly pass
 * short of the day's first messages.
 */
export async function pruneMessages(chatId: string, keep = MAX_HISTORY, days = HISTORY_DAYS) {
  await db().execute(sql`
    delete from ${messages}
    where ${messages.chatId} = ${chatId}
      and ${messages.createdAt} < now() - make_interval(days => ${days})
      and ${messages.id} not in (
        select id from ${messages}
        where ${messages.chatId} = ${chatId}
        order by ${messages.id} desc
        limit ${keep}
      )
  `)
}

/* ------------------------------------------------------------ connections */

export async function saveConnection(input: {
  memberId: number
  provider: Provider
  email: string | null
  refreshToken: string
  scopes: string | null
}) {
  const refresh = await encrypt(input.refreshToken)
  await db()
    .insert(connections)
    .values({
      memberId: input.memberId,
      provider: input.provider,
      email: input.email,
      refreshToken: refresh,
      scopes: input.scopes,
    })
    .onConflictDoUpdate({
      target: [connections.memberId, connections.provider],
      set: { email: input.email, refreshToken: refresh, scopes: input.scopes, updatedAt: new Date() },
    })
}

/** A refreshed link's replacement refresh token, stored the same way the first one was. */
export async function updateRefreshToken(memberId: number, provider: Provider, refreshToken: string) {
  await db()
    .update(connections)
    .set({ refreshToken: await encrypt(refreshToken), updatedAt: new Date() })
    .where(and(eq(connections.memberId, memberId), eq(connections.provider, provider)))
}

export async function connectionsFor(memberId: number): Promise<Connection[]> {
  return db().select().from(connections).where(eq(connections.memberId, memberId))
}

export async function connectionFor(memberId: number, provider: Provider): Promise<Connection | undefined> {
  const [row] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.memberId, memberId), eq(connections.provider, provider)))
    .limit(1)
  return row
}

export async function decryptRefreshToken(c: Connection): Promise<string> {
  return decrypt(c.refreshToken)
}

export async function deleteConnection(memberId: number, provider: Provider) {
  await db()
    .delete(connections)
    .where(and(eq(connections.memberId, memberId), eq(connections.provider, provider)))
}

/* ---------------------------------------------------------- family events */

export async function addFamilyEvent(input: {
  title: string
  description?: string | null
  location?: string | null
  startsAt: Date
  endsAt: Date
  allDay?: boolean
  createdBy?: number | null
}) {
  const [row] = await db()
    .insert(familyEvents)
    .values({
      uid: `${randomToken(12)}@hearth`,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay ?? false,
      createdBy: input.createdBy ?? null,
    })
    .returning()
  return row
}

export async function getFamilyEvent(id: number) {
  const [row] = await db().select().from(familyEvents).where(eq(familyEvents.id, id)).limit(1)
  return row
}

/**
 * Every event on the family calendar that is on during [from, to): started
 * before `to` and not yet over by `from`. A camp that began on Friday is on
 * on Sunday, and yesterday's all-day event, which ends at this midnight, is
 * not on today. One starting at `from` counts whatever its length, so a
 * zero-length entry is not lost to the arithmetic.
 */
export async function listFamilyEvents(from: Date, to: Date) {
  return db()
    .select()
    .from(familyEvents)
    .where(
      and(
        or(lt(familyEvents.startsAt, to), eq(familyEvents.startsAt, from)),
        or(gt(familyEvents.endsAt, from), eq(familyEvents.startsAt, from)),
      ),
    )
    .orderBy(asc(familyEvents.startsAt))
}

/** Every event the ICS feed should publish. */
export async function allFamilyEventsForFeed(since: Date) {
  return db()
    .select()
    .from(familyEvents)
    // A subscribed feed is a mirror, not an invitation stream: clients remove
    // whatever stops appearing, while Outlook renders a STATUS:CANCELLED event
    // instead of hiding it. Omission is the cancellation signal that works.
    .where(and(gte(familyEvents.endsAt, since), eq(familyEvents.cancelled, false)))
    .orderBy(asc(familyEvents.startsAt))
}

export async function cancelFamilyEvent(id: number) {
  const [row] = await db()
    .update(familyEvents)
    .set({ cancelled: true, updatedAt: new Date() })
    .where(eq(familyEvents.id, id))
    .returning()
  return row
}

/**
 * Change an event in place. The uid stays, and `updatedAt` moves, which is
 * what bumps SEQUENCE in the feed: subscribed calendars then replace the entry
 * rather than showing the old one until it happens to drop out.
 */
export async function updateFamilyEvent(
  id: number,
  patch: {
    title?: string
    description?: string | null
    location?: string | null
    startsAt?: Date
    endsAt?: Date
    allDay?: boolean
  },
) {
  const [row] = await db()
    .update(familyEvents)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(familyEvents.id, id), eq(familyEvents.cancelled, false)))
    .returning()
  return row
}

/* --------------------------------------------------------------- memories */

/** Store a fact; when it corrects an older one, that one is superseded in the same step. */
export async function addMemory(content: string, createdBy?: number | null, replaces?: number | null) {
  const [row] = await db().insert(memories).values({ content, createdBy: createdBy ?? null }).returning()
  if (replaces) await deleteMemory(replaces, row.id)
  return row
}

/**
 * Current facts only, newest first. Forgotten and superseded rows stay as
 * history. `contains` is a plain case-insensitive substring, so a % or _ in
 * it matches only itself.
 */
export async function listMemories(limit = 100, contains?: string) {
  const needle = contains?.replace(/[\\%_]/g, '\\$&')
  return db()
    .select()
    .from(memories)
    .where(and(isNull(memories.invalidatedAt), needle ? ilike(memories.content, `%${needle}%`) : undefined))
    // Two facts filed in the same instant tie on created_at; the id settles it.
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(limit)
}

/**
 * Forgetting is soft: the row is marked rather than removed, so "what did we
 * think before" survives and a wrong correction can be undone by hand.
 */
export async function deleteMemory(id: number, supersededBy?: number | null) {
  const [row] = await db()
    .update(memories)
    .set({ invalidatedAt: new Date(), supersededBy: supersededBy ?? null })
    .where(and(eq(memories.id, id), isNull(memories.invalidatedAt)))
    .returning()
  return row
}

/* ------------------------------------------------------- memory questions */

/**
 * Put a would-be fact to the family rather than filing it. The same question
 * on two nights is one question: an open row with the same wording or the
 * same candidate fact is handed back instead of a second copy.
 */
export async function askQuestion(input: { question: string; candidate: string }): Promise<{ row: MemoryQuestion; fresh: boolean }> {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
  const dupe = (await openQuestions()).find((o) => same(o.candidate, input.candidate) || same(o.question, input.question))
  if (dupe) return { row: dupe, fresh: false }
  const [row] = await db()
    .insert(memoryQuestions)
    .values({ question: input.question.trim(), candidate: input.candidate.trim() })
    .returning()
  return { row, fresh: true }
}

/** Still waiting on the family, oldest first. */
export async function openQuestions(): Promise<MemoryQuestion[]> {
  return db().select().from(memoryQuestions).where(isNull(memoryQuestions.settledAt)).orderBy(asc(memoryQuestions.id))
}

/** Open, and not yet put to the family by a brief. */
export async function unaskedQuestions(): Promise<MemoryQuestion[]> {
  return db()
    .select()
    .from(memoryQuestions)
    .where(and(isNull(memoryQuestions.settledAt), isNull(memoryQuestions.askedAt)))
    .orderBy(asc(memoryQuestions.id))
}

export async function markQuestionsAsked(ids: number[], at: Date = new Date()): Promise<void> {
  if (ids.length === 0) return
  await db()
    .update(memoryQuestions)
    .set({ askedAt: at })
    .where(and(inArray(memoryQuestions.id, ids), isNull(memoryQuestions.askedAt)))
}

/**
 * A yes files the fact as the family stated it and closes the question; a no
 * closes it with nothing filed. The close comes first, so two answers to the
 * same question cannot file the fact twice, and a fact already Known in other
 * words is pointed at rather than filed again. A yes that differs from a Known
 * fact only by a "not" or a number corrects it, and retires it as remember
 * does with replaces: neither Home nor answer_question takes the old id, and
 * left alone the two would both stand as Known.
 */
export async function answerQuestion(
  id: number,
  fact: string | null,
  createdBy?: number | null,
): Promise<{ question: MemoryQuestion; memory: Memory | null; replaced?: number } | undefined> {
  const [claimed] = await db()
    .update(memoryQuestions)
    .set({ settledAt: new Date(), outcome: fact ? 'confirmed' : 'dismissed' })
    .where(and(eq(memoryQuestions.id, id), isNull(memoryQuestions.settledAt)))
    .returning()
  if (!claimed) return undefined
  if (!fact) return { question: claimed, memory: null }

  const current = await listMemories(500)
  const known = rankSimilar(fact, current)[0]
  const duplicate = known && known.score >= DUPLICATE ? known.row : undefined
  const corrected = duplicate ? undefined : findCorrected(fact, current)
  const memory = duplicate ?? (await addMemory(fact, createdBy ?? null, corrected?.id ?? null))
  const [question] = await db()
    .update(memoryQuestions)
    .set({ memoryId: memory.id })
    .where(eq(memoryQuestions.id, id))
    .returning()
  return { question, memory, ...(corrected ? { replaced: corrected.id } : {}) }
}

/* ------------------------------------------------------------ automations */

/**
 * A chat has at most one of each ready-made watcher, and the database holds
 * it to that: a second of the same kind, from two ticks installing the
 * built-ins at once or a doubled /watch, hands back the one already there.
 */
export async function addAutomation(input: {
  chatId: string
  memberId?: number | null
  label: string
  cronExpr: string
  instruction: string
  kind?: string | null
  nextRunAt: Date
}) {
  const [row] = await db().insert(automations).values({
    chatId: input.chatId,
    memberId: input.memberId ?? null,
    label: input.label,
    cronExpr: input.cronExpr,
    instruction: input.instruction,
    kind: input.kind ?? null,
    nextRunAt: input.nextRunAt,
  }).onConflictDoNothing().returning()
  if (row) return row
  const [have] = await db()
    .select()
    .from(automations)
    .where(and(eq(automations.chatId, input.chatId), eq(automations.kind, input.kind ?? '')))
    .limit(1)
  return have
}

export async function listAutomations(chatId?: string) {
  const q = db().select().from(automations)
  const rows = chatId ? await q.where(eq(automations.chatId, chatId)) : await q
  return rows.sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
}

export async function dueAutomations(now: Date) {
  return db()
    .select()
    .from(automations)
    .where(and(eq(automations.enabled, true), lte(automations.nextRunAt, now)))
    .orderBy(asc(automations.nextRunAt))
    .limit(20)
}

/**
 * Advance an automation's schedule. The predicate makes the update a lock: the
 * row is claimed only while it is still due as of `now`, and the first of two
 * overlapping ticks moves it into the future, so the second finds nothing. It
 * is "still due" rather than "exactly the time we read": Postgres keeps
 * microseconds and a Date does not, so a row nudged by hand with `now()` in
 * SQL never matched the equality this once used, and stayed due, unclaimed
 * and silent, tick after tick.
 */
export async function claimAutomation(id: number, now: Date, nextRunAt: Date | null) {
  const rows = await db()
    .update(automations)
    .set({
      lastRunAt: new Date(),
      nextRunAt: nextRunAt ?? new Date(8640000000000),
      enabled: nextRunAt !== null,
    })
    .where(and(eq(automations.id, id), eq(automations.enabled, true), lte(automations.nextRunAt, now)))
    .returning()
  return rows.length > 0
}

export async function setAutomationEnabled(id: number, enabled: boolean, nextRunAt?: Date) {
  const [row] = await db()
    .update(automations)
    .set(nextRunAt ? { enabled, nextRunAt } : { enabled })
    .where(eq(automations.id, id))
    .returning()
  return row
}

/** Bring a ready-made watcher's row back in step with its definition; a converted one changes kind too. */
export async function syncAutomation(
  id: number,
  patch: { kind?: string; label: string; cronExpr: string; instruction: string; nextRunAt?: Date },
) {
  const [row] = await db().update(automations).set(patch).where(eq(automations.id, id)).returning()
  return row
}

export async function getAutomation(id: number) {
  const [row] = await db().select().from(automations).where(eq(automations.id, id)).limit(1)
  return row
}

export async function deleteAutomation(id: number) {
  const rows = await db().delete(automations).where(eq(automations.id, id)).returning()
  return rows.length > 0
}

/* --------------------------------------------------------------- settings */

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db().select().from(settings).where(eq(settings.key, key)).limit(1)
  return row?.value ?? null
}

export async function setSetting(key: string, value: string) {
  await db().insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } })
}

/**
 * The scheduler's pulse, with the pulse before it kept alongside. The gap
 * between the two is the cadence QStash is actually running at, and that is
 * what "gone quiet" is judged against: three missed ticks, whether they were
 * due every five minutes or every hour. The old pulse moves aside first; a
 * first-ever tick has nothing to move and writes only the new one.
 */
export async function recordTick(now: Date): Promise<void> {
  await db().execute(sql`
    insert into settings (key, value)
    select 'prev_tick_at', value from settings where key = 'last_tick_at'
    on conflict (key) do update set value = excluded.value
  `)
  await setSetting('last_tick_at', now.toISOString())
}

/**
 * The long random path segment guarding the ICS feed; created on first use.
 * Two first uses at once both get the one that was stored: an overwrite here
 * would hand one of them a URL that is dead on arrival.
 */
export async function calendarToken(): Promise<string> {
  const existing = await getSetting('calendar_token')
  if (existing) return existing
  const [made] = await db()
    .insert(settings)
    .values({ key: 'calendar_token', value: randomToken(24) })
    .onConflictDoNothing()
    .returning({ value: settings.value })
  return made?.value ?? ((await getSetting('calendar_token')) as string)
}

/**
 * How long the edge answers the feed from its own copy: the s-maxage it is
 * served with, and so how long a replaced address can still be answered,
 * which `/calendar new` tells the admin.
 */
export const FEED_EDGE_SECONDS = 60 * 60

/**
 * A fresh feed token, for when the URL has got out. The old one stops matching
 * at once, though the edge may keep serving a cached copy for up to its
 * s-maxage, and every subscriber has to subscribe again.
 */
export async function rotateCalendarToken(): Promise<string> {
  const token = randomToken(24)
  await setSetting('calendar_token', token)
  return token
}

/* ----------------------------------------------------------- email drafts */

export async function createDraft(input: {
  chatId: string
  memberId: number
  provider: string
  to: string[]
  cc?: string[]
  subject: string
  body: string
}): Promise<EmailDraft> {
  const [row] = await db()
    .insert(emailDrafts)
    .values({
      chatId: input.chatId,
      memberId: input.memberId,
      provider: input.provider,
      recipients: input.to.join(', '),
      cc: input.cc?.length ? input.cc.join(', ') : null,
      subject: input.subject,
      body: input.body,
    })
    .returning()
  return row
}

export async function getDraft(id: number): Promise<EmailDraft | undefined> {
  const [row] = await db().select().from(emailDrafts).where(eq(emailDrafts.id, id)).limit(1)
  return row
}

export async function pendingDrafts(chatId: string): Promise<EmailDraft[]> {
  return db()
    .select()
    .from(emailDrafts)
    .where(and(eq(emailDrafts.chatId, chatId), eq(emailDrafts.status, 'pending')))
    .orderBy(desc(emailDrafts.id))
    .limit(5)
}

export type DraftStatus = 'pending' | 'sent' | 'cancelled'

/**
 * Move a draft between states, but only from the state we expect. The predicate
 * makes this a claim: a duplicate confirmation cannot send the same email twice.
 */
export async function markDraft(
  id: number,
  status: DraftStatus,
  from: DraftStatus = 'pending',
): Promise<boolean> {
  const rows = await db()
    .update(emailDrafts)
    .set({ status })
    .where(and(eq(emailDrafts.id, id), eq(emailDrafts.status, from)))
    .returning()
  return rows.length > 0
}

/* ------------------------------------------------------------ shared lists */

/**
 * Lists are addressed by name, case-insensitively, and created on first use,
 * by whichever of two people adding to a new list at once gets there first.
 */
export async function findOrCreateList(name: string): Promise<List> {
  const clean = name.trim().toLowerCase()
  const [existing] = await db().select().from(lists).where(eq(lists.name, clean)).limit(1)
  if (existing) return existing
  const [row] = await db().insert(lists).values({ name: clean }).onConflictDoNothing().returning()
  return row ?? ((await findList(clean)) as List)
}

export async function findList(name: string): Promise<List | undefined> {
  const [row] = await db().select().from(lists).where(eq(lists.name, name.trim().toLowerCase())).limit(1)
  return row
}

export async function allLists(): Promise<{ name: string; open: number }[]> {
  const rows = await db()
    .select({ name: lists.name, done: listItems.done, id: listItems.id })
    .from(lists)
    .leftJoin(listItems, eq(listItems.listId, lists.id))
  const counts = new Map<string, number>()
  for (const r of rows) {
    const open = counts.get(r.name) ?? 0
    counts.set(r.name, open + (r.id !== null && r.done === false ? 1 : 0))
  }
  return [...counts].map(([name, open]) => ({ name, open })).sort((a, b) => a.name.localeCompare(b.name))
}

export async function addListItems(listId: number, contents: string[], addedBy?: number | null) {
  if (contents.length === 0) return []
  return db()
    .insert(listItems)
    .values(contents.map((content) => ({ listId, content: content.trim(), addedBy: addedBy ?? null })))
    .returning()
}

export async function listContents(listId: number): Promise<ListItem[]> {
  return db()
    .select()
    .from(listItems)
    .where(eq(listItems.listId, listId))
    .orderBy(asc(listItems.done), asc(listItems.id))
}

/** Match items by substring, so "milk" ticks off "2L milk". */
export async function markListItems(listId: number, needles: string[], done: boolean) {
  const items = await listContents(listId)
  const matched = new Set<number>()
  for (const needle of needles) {
    const n = needle.trim().toLowerCase()
    if (!n) continue
    const hit =
      items.find((i) => i.content.toLowerCase() === n) ??
      items.find((i) => i.content.toLowerCase().includes(n)) ??
      items.find((i) => n.includes(i.content.toLowerCase()))
    if (hit) matched.add(hit.id)
  }
  if (matched.size === 0) return []
  return db()
    .update(listItems)
    .set({ done })
    .where(and(eq(listItems.listId, listId), inArray(listItems.id, [...matched])))
    .returning()
}

export async function setListItemDone(id: number, done: boolean): Promise<ListItem | undefined> {
  const [row] = await db().update(listItems).set({ done }).where(eq(listItems.id, id)).returning()
  return row
}

export async function deleteListItem(id: number): Promise<boolean> {
  return (await db().delete(listItems).where(eq(listItems.id, id)).returning()).length > 0
}

export async function removeListItems(listId: number, ids: number[]) {
  if (ids.length === 0) return []
  return db()
    .delete(listItems)
    .where(and(eq(listItems.listId, listId), inArray(listItems.id, ids)))
    .returning()
}

export async function clearList(listId: number, onlyDone: boolean) {
  const where = onlyDone
    ? and(eq(listItems.listId, listId), eq(listItems.done, true))
    : eq(listItems.listId, listId)
  return db().delete(listItems).where(where).returning()
}

/* -------------------------------------------------------- event proposals */

export async function proposalForSource(source: string): Promise<EventProposal | undefined> {
  const [row] = await db().select().from(eventProposals).where(eq(eventProposals.source, source)).limit(1)
  return row
}

export async function addProposal(input: {
  chatId: string
  memberId?: number | null
  title: string
  description?: string | null
  location?: string | null
  startsAt: Date
  endsAt: Date
  allDay?: boolean
  source?: string | null
}): Promise<EventProposal> {
  const [row] = await db()
    .insert(eventProposals)
    .values({
      chatId: input.chatId,
      memberId: input.memberId ?? null,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay ?? false,
      source: input.source ?? null,
    })
    .returning()
  return row
}

/** A live event with the proposal's title at the proposal's instant: the same occasion, already on the calendar. */
function alreadyOnCalendar() {
  return db()
    .select({ one: sql`1` })
    .from(familyEvents)
    .where(
      and(
        eq(familyEvents.cancelled, false),
        eq(familyEvents.startsAt, eventProposals.startsAt),
        sql`lower(trim(${familyEvents.title})) = lower(trim(${eventProposals.title}))`,
      ),
    )
}

/**
 * A proposal still worth an answer: pending, its occasion not yet over, and
 * not on the calendar already by another route. Decided at read time, so
 * nothing stale is ever shown, whether or not the tick has been round yet.
 */
function liveProposal(now: Date) {
  return and(eq(eventProposals.status, 'pending'), gt(eventProposals.endsAt, now), notExists(alreadyOnCalendar()))
}

export async function pendingProposals(chatId?: string, now: Date = new Date()): Promise<EventProposal[]> {
  const where = chatId ? and(liveProposal(now), eq(eventProposals.chatId, chatId)) : liveProposal(now)
  return db().select().from(eventProposals).where(where).orderBy(asc(eventProposals.startsAt))
}

/**
 * Retire, durably, what the read-time filter already hides, so the row says
 * why it stopped being a question: superseded when its event reached the
 * calendar another way, expired when the occasion passed unanswered.
 */
export async function retireStaleProposals(now: Date = new Date()): Promise<{ expired: number; superseded: number }> {
  const superseded = await db()
    .update(eventProposals)
    .set({ status: 'superseded' })
    .where(and(eq(eventProposals.status, 'pending'), exists(alreadyOnCalendar())))
    .returning({ id: eventProposals.id })
  const expired = await db()
    .update(eventProposals)
    .set({ status: 'expired' })
    .where(and(eq(eventProposals.status, 'pending'), lte(eventProposals.endsAt, now)))
    .returning({ id: eventProposals.id })
  return { expired: expired.length, superseded: superseded.length }
}

/** Claim a proposal so a repeated "yes" cannot add the same event twice. */
export async function settleProposal(
  id: number,
  status: 'accepted' | 'rejected',
): Promise<EventProposal | undefined> {
  const [row] = await db()
    .update(eventProposals)
    .set({ status })
    .where(and(eq(eventProposals.id, id), eq(eventProposals.status, 'pending')))
    .returning()
  return row
}

/* ------------------------------------------------------- member admin ---- */

export type MemberRow = Member & { linked: { provider: string; email: string | null }[] }

/** Everyone the bot knows, with whatever mailboxes each has linked. */
export async function allMembersWithLinks(): Promise<MemberRow[]> {
  const [people, links] = await Promise.all([
    db().select().from(members).orderBy(asc(members.id)),
    db().select().from(connections),
  ])
  return people.map((m) => ({
    ...m,
    linked: links
      .filter((c) => c.memberId === m.id)
      .map((c) => ({ provider: c.provider, email: c.email })),
  }))
}

/** Create or update a member from the dashboard rather than from a chat. */
export async function saveMember(input: {
  telegramUserId: string
  name: string
  email: string | null
  allowed: boolean
  isAdmin: boolean
}): Promise<Member> {
  const [row] = await db()
    .insert(members)
    .values(input)
    .onConflictDoUpdate({
      target: members.telegramUserId,
      set: {
        name: input.name,
        email: input.email,
        allowed: input.allowed,
        // Losing access takes admin with it, so a revoked person cannot sign in.
        isAdmin: input.allowed && input.isAdmin,
      },
    })
    .returning()
  return row
}

export async function deleteMember(telegramUserId: string): Promise<boolean> {
  // Their own scheduled instructions stop with them. Deleting the row sets
  // member_id to null, after which a custom automation would read as the
  // household's, so it is paused while it is still known to be theirs.
  const [member] = await db().select({ id: members.id }).from(members).where(eq(members.telegramUserId, telegramUserId)).limit(1)
  if (member) {
    await db()
      .update(automations)
      .set({ enabled: false })
      .where(and(eq(automations.memberId, member.id), isNull(automations.kind)))
  }
  const rows = await db().delete(members).where(eq(members.telegramUserId, telegramUserId)).returning()
  return rows.length > 0
}
