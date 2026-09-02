import { and, asc, desc, eq, gte, inArray, lte, ne, sql, isNull, gt } from 'drizzle-orm'
import { db } from './index'
import {
  members, chats, connections, messages, familyEvents, memories, automations, settings, emailDrafts,
  lists, listItems, eventProposals,
  type Member, type Connection, type EmailDraft, type Stranger,
  type List, type ListItem, type EventProposal,
} from './schema'
import { encrypt, decrypt, randomToken } from '../crypto'
import type { Provider } from '../oauth/providers'

export const MAX_HISTORY = 200
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

/* ------------------------------------------------------------------ chats */

export async function rememberChat(chatId: string, type: string, title: string | null) {
  await db()
    .insert(chats)
    .values({ chatId, type, title })
    .onConflictDoUpdate({ target: chats.chatId, set: { type, title } })
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

function parseStrangers(raw: string | undefined | null): Stranger[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Stranger[]).filter((s) => s && typeof s.id === 'string') : []
  } catch {
    return []
  }
}

/** Returns true when this is the first time we have seen that stranger here. */
export async function noteStranger(chatId: string, stranger: Stranger): Promise<boolean> {
  const current = await strangersIn(chatId)
  if (current.some((s) => s.id === stranger.id)) return false
  const next = [...current, stranger]
  await db().update(chats).set({ strangers: JSON.stringify(next) }).where(eq(chats.chatId, chatId))
  return true
}

export async function clearStranger(chatId: string, userId: string): Promise<void> {
  const current = await strangersIn(chatId)
  const next = current.filter((s) => s.id !== userId)
  if (next.length === current.length) return
  await db().update(chats).set({ strangers: JSON.stringify(next) }).where(eq(chats.chatId, chatId))
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
 * message currently being answered, which the caller has already stored.
 */
export async function recentMessages(chatId: string, limit = CONTEXT_WINDOW, excludeId?: number) {
  const where = excludeId
    ? and(eq(messages.chatId, chatId), ne(messages.id, excludeId))
    : eq(messages.chatId, chatId)
  const rows = await db()
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit)
  return rows.reverse()
}

/** The last day's talk across every chat, oldest first, for the nightly memory pass. */
export async function messagesSince(hours: number, limit = 400) {
  return db()
    .select({
      chatId: messages.chatId,
      authorName: messages.authorName,
      role: messages.role,
      content: messages.content,
    })
    .from(messages)
    .where(gte(messages.createdAt, new Date(Date.now() - hours * 3600_000)))
    .orderBy(asc(messages.id))
    .limit(limit)
}

/** Keep the table bounded: drop everything older than the newest MAX_HISTORY rows. */
export async function pruneMessages(chatId: string, keep = MAX_HISTORY) {
  await db().execute(sql`
    delete from ${messages}
    where ${messages.chatId} = ${chatId}
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

export async function listFamilyEvents(from: Date, to: Date) {
  return db()
    .select()
    .from(familyEvents)
    .where(and(gte(familyEvents.startsAt, from), lte(familyEvents.startsAt, to)))
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

/* --------------------------------------------------------------- memories */

/** Store a fact; when it corrects an older one, that one is superseded in the same step. */
export async function addMemory(content: string, createdBy?: number | null, replaces?: number | null) {
  const [row] = await db().insert(memories).values({ content, createdBy: createdBy ?? null }).returning()
  if (replaces) await deleteMemory(replaces, row.id)
  return row
}

/** Current facts only, newest first. Forgotten and superseded rows stay as history. */
export async function listMemories(limit = 100) {
  return db()
    .select()
    .from(memories)
    .where(isNull(memories.invalidatedAt))
    // Two facts filed in the same instant tie on created_at; the id settles it.
    .orderBy(desc(memories.createdAt), desc(memories.id))
    .limit(limit)
}

/**
 * Forgetting is soft: the row is marked rather than removed, so "what did we
 * think before" survives and a wrong correction can be undone by hand.
 */
export async function deleteMemory(id: number, supersededBy?: number | null) {
  await db()
    .update(memories)
    .set({ invalidatedAt: new Date(), supersededBy: supersededBy ?? null })
    .where(and(eq(memories.id, id), isNull(memories.invalidatedAt)))
}

/* ------------------------------------------------------------ automations */

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
  }).returning()
  return row
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
 * Advance an automation's schedule. The `nextRunAt` predicate makes the update a
 * lock: two overlapping ticks cannot both claim the same due run.
 */
export async function claimAutomation(id: number, expectedRun: Date, nextRunAt: Date | null) {
  const rows = await db()
    .update(automations)
    .set({
      lastRunAt: new Date(),
      nextRunAt: nextRunAt ?? new Date(8640000000000),
      enabled: nextRunAt !== null,
    })
    .where(and(eq(automations.id, id), eq(automations.nextRunAt, expectedRun)))
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

/** The long random path segment guarding the ICS feed; created on first use. */
export async function calendarToken(): Promise<string> {
  const existing = await getSetting('calendar_token')
  if (existing) return existing
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

/** Lists are addressed by name, case-insensitively, and created on first use. */
export async function findOrCreateList(name: string): Promise<List> {
  const clean = name.trim().toLowerCase()
  const [existing] = await db().select().from(lists).where(eq(lists.name, clean)).limit(1)
  if (existing) return existing
  const [row] = await db().insert(lists).values({ name: clean }).returning()
  return row
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

export async function pendingProposals(chatId?: string): Promise<EventProposal[]> {
  const where = chatId
    ? and(eq(eventProposals.status, 'pending'), eq(eventProposals.chatId, chatId))
    : eq(eventProposals.status, 'pending')
  return db().select().from(eventProposals).where(where).orderBy(asc(eventProposals.startsAt))
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
  const rows = await db().delete(members).where(eq(members.telegramUserId, telegramUserId)).returning()
  return rows.length > 0
}
