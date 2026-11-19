import { and, asc, desc, eq, gte, inArray, lte, lt, ne, or, sql, isNull, gt, exists, notExists, ilike } from 'drizzle-orm'
import { db } from './index'
import {
  members, mcpKeys, connections, familyEvents, memories, memoryQuestions, automations, automationReports, settings, emailDrafts,
  lists, listItems, eventProposals, activity, goals, goalSteps, goalUpdates, helpers, routines,
  type Member, type McpKey, type Connection, type EmailDraft, type AutomationReport,
  type List, type ListItem, type EventProposal, type Memory, type MemoryQuestion, type Activity,
  type Goal, type GoalStep, type GoalUpdate, type Helper, type Routine,
} from './schema'
import { encrypt, decrypt, randomToken, hashToken, mintMcpKey, mcpKeyHolder } from '../crypto'
import { rankSimilar, findCorrected, DUPLICATE } from '../memory-match'
import type { Provider } from '../oauth/providers'

/* ---------------------------------------------------------------- members */

/** Everyone who may use Hearth: sign in, hold a key, have their accounts read. */
export async function allowedMembers(): Promise<Member[]> {
  return db().select().from(members).where(eq(members.allowed, true)).orderBy(asc(members.id))
}

export async function memberById(id: number): Promise<Member | undefined> {
  const [row] = await db().select().from(members).where(eq(members.id, id)).limit(1)
  return row
}

export async function allMembers(): Promise<Member[]> {
  return db().select().from(members).orderBy(asc(members.id))
}

/* --------------------------------------------------------------- MCP keys */

/** The longest label a key keeps: enough for "Claude Code on the laptop", not an essay. */
export const MCP_KEY_LABEL_MAX = 60

/**
 * Mint a new key for the MCP endpoint for this member, beside any they
 * already hold: one per client, so revoking one leaves the others working.
 * The plaintext is returned once and never stored. It carries a tag only this
 * deployment can make (see mintMcpKey), so a made-up one is turned away
 * before any read.
 */
export async function issueMcpKey(memberId: number, label: string): Promise<{ key: string; row: McpKey }> {
  const key = await mintMcpKey(memberId)
  const name = label.trim().replace(/\s+/g, ' ').slice(0, MCP_KEY_LABEL_MAX) || 'MCP client'
  const [row] = await db()
    .insert(mcpKeys)
    .values({ memberId, label: name, tokenHash: await hashToken(key) })
    .returning()
  return { key, row }
}

/** A member's keys, newest first, as the dashboard lists them: never the key itself, which is not kept. */
export async function mcpKeysFor(memberId: number): Promise<McpKey[]> {
  return db().select().from(mcpKeys).where(eq(mcpKeys.memberId, memberId)).orderBy(desc(mcpKeys.createdAt), desc(mcpKeys.id))
}

/** Revoke one of a member's own keys. Its row goes, and with it the only record that would let it in again. */
export async function revokeMcpKey(memberId: number, keyId: number): Promise<boolean> {
  const rows = await db()
    .delete(mcpKeys)
    .where(and(eq(mcpKeys.id, keyId), eq(mcpKeys.memberId, memberId)))
    .returning({ id: mcpKeys.id })
  return rows.length > 0
}

/** How often a key's last use is written down: once an hour is enough to tell a live key from a forgotten one. */
const TOUCH_EVERY_MS = 3_600_000

/**
 * Who a bearer key belongs to and which of their keys it is, or null. A
 * member who has since been denied holds nothing: the allowlist is the one
 * gate, here as everywhere else.
 *
 * The key's tag is checked first, with nothing read. Looking up every key sent
 * let anyone who knew the host keep Neon awake by posting made-up ones every
 * few minutes, which runs out the free plan's compute hours. A key whose tag
 * checks was minted here for that member, and its stored hash then says
 * whether it is still theirs: a revoked one has no row to match.
 */
export async function memberByMcpKey(key: string): Promise<{ member: Member; keyId: number } | null> {
  const holder = await mcpKeyHolder(key)
  if (holder === null) return null
  const [row] = await db()
    .select({ member: members, keyId: mcpKeys.id, lastUsedAt: mcpKeys.lastUsedAt })
    .from(mcpKeys)
    .innerJoin(members, eq(members.id, mcpKeys.memberId))
    .where(and(eq(mcpKeys.tokenHash, await hashToken(key)), eq(mcpKeys.memberId, holder), eq(members.allowed, true)))
    .limit(1)
  if (!row) return null
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await db()
      .update(mcpKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpKeys.id, row.keyId))
      .catch((err: unknown) => console.warn('[mcp] could not note a key as used:', err))
  }
  return { member: row.member, keyId: row.keyId }
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

/** Make a member's link read-only, or writable again; the row it changed, or nothing when there is no such link. */
export async function setConnectionReadOnly(memberId: number, provider: Provider, readOnly: boolean): Promise<Connection | undefined> {
  const [row] = await db()
    .update(connections)
    .set({ readOnly, updatedAt: new Date() })
    .where(and(eq(connections.memberId, memberId), eq(connections.provider, provider)))
    .returning()
  return row
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

/** How often an automation runs; see the column in lib/db/schema.ts. */
export const REPEATS = ['always', 'once', 'until'] as const
export type Repeat = (typeof REPEATS)[number]

export async function addAutomation(input: {
  memberId: number | null
  label: string
  cronExpr: string
  instruction: string
  nextRunAt: Date
  repeat?: Repeat
  helperId?: number | null
}) {
  const [row] = await db().insert(automations).values({
    memberId: input.memberId,
    label: input.label,
    cronExpr: input.cronExpr,
    instruction: input.instruction,
    nextRunAt: input.nextRunAt,
    repeat: input.repeat ?? 'always',
    helperId: input.helperId ?? null,
  }).returning()
  return row
}

/** A member's automations, or everyone's for the admin pages, soonest first. */
export async function listAutomations(memberId?: number) {
  const q = db().select().from(automations)
  const rows = memberId !== undefined ? await q.where(eq(automations.memberId, memberId)) : await q
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

/** Rewrite what an automation is called and does, keeping when it runs unless told. */
export async function syncAutomation(
  id: number,
  patch: { label: string; cronExpr: string; instruction: string; nextRunAt?: Date },
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

/* ----------------------------------------------------- automation reports */

export type ReportStatus = 'ready' | 'held' | 'problem'

/** Keep what a scheduled run found for the member who set it up. */
export async function addReport(input: {
  memberId: number
  automationId: number | null
  label: string
  helper?: string | null
  status: ReportStatus
  body: string
  detail?: string | null
}): Promise<AutomationReport> {
  const [row] = await db()
    .insert(automationReports)
    .values({
      memberId: input.memberId,
      automationId: input.automationId,
      label: input.label,
      helper: input.helper ?? null,
      status: input.status,
      body: input.body.slice(0, 8000),
      detail: input.detail?.slice(0, 2000) ?? null,
    })
    .returning()
  return row
}

/** A member's reports since a moment, newest first. */
export async function reportsFor(memberId: number, opts: { since?: Date; limit?: number } = {}): Promise<AutomationReport[]> {
  const where = opts.since
    ? and(eq(automationReports.memberId, memberId), gte(automationReports.createdAt, opts.since))
    : eq(automationReports.memberId, memberId)
  return db()
    .select()
    .from(automationReports)
    .where(where)
    .orderBy(desc(automationReports.createdAt), desc(automationReports.id))
    .limit(opts.limit ?? 20)
}

/** Thirty days is long enough to catch up after a holiday, and no longer. */
export async function pruneReports(days = 30): Promise<number> {
  const rows = await db()
    .delete(automationReports)
    .where(lt(automationReports.createdAt, new Date(Date.now() - days * 86_400_000)))
    .returning({ id: automationReports.id })
  return rows.length
}

/* ------------------------------------------------------------------ goals */

export type GoalStatus = 'active' | 'done' | 'dropped'

export async function createGoal(input: {
  memberId: number | null
  title: string
  outcome?: string | null
  targetDate?: string | null
}): Promise<Goal> {
  const [row] = await db()
    .insert(goals)
    .values({ memberId: input.memberId, title: input.title, outcome: input.outcome ?? null, targetDate: input.targetDate ?? null })
    .returning()
  return row
}

export async function getGoal(id: number): Promise<Goal | undefined> {
  const [row] = await db().select().from(goals).where(eq(goals.id, id)).limit(1)
  return row
}

export async function updateGoal(
  id: number,
  patch: Partial<Pick<Goal, 'title' | 'outcome' | 'targetDate' | 'automationId'>>,
): Promise<Goal | undefined> {
  const [row] = await db().update(goals).set({ ...patch, updatedAt: new Date() }).where(eq(goals.id, id)).returning()
  return row
}

/** One member's goals in a given state, in progress unless told, oldest first. A goal is its owner's alone. */
export async function goalsIn(opts: { memberId: number; status?: GoalStatus }): Promise<Goal[]> {
  return db()
    .select()
    .from(goals)
    .where(and(eq(goals.status, opts.status ?? 'active'), eq(goals.memberId, opts.memberId)))
    .orderBy(asc(goals.id))
}

/** Settle a goal, once: the predicate makes it a claim, so a second "done" finds it already closed. */
export async function closeGoal(id: number, status: Exclude<GoalStatus, 'active'>): Promise<Goal | undefined> {
  const now = new Date()
  const [row] = await db()
    .update(goals)
    .set({ status, closedAt: now, updatedAt: now })
    .where(and(eq(goals.id, id), eq(goals.status, 'active')))
    .returning()
  return row
}

/** Back in progress after being closed, as a person can change their mind. */
export async function reopenGoal(id: number): Promise<Goal | undefined> {
  const [row] = await db()
    .update(goals)
    .set({ status: 'active', closedAt: null, updatedAt: new Date() })
    .where(and(eq(goals.id, id), ne(goals.status, 'active')))
    .returning()
  return row
}

export async function addGoalSteps(goalId: number, contents: string[]): Promise<GoalStep[]> {
  const clean = contents.map((c) => c.trim()).filter(Boolean)
  if (clean.length === 0) return []
  return db().insert(goalSteps).values(clean.map((content) => ({ goalId, content }))).returning()
}

/** A goal's steps in the order they were planned. */
export async function goalStepsOf(goalId: number): Promise<GoalStep[]> {
  return db().select().from(goalSteps).where(eq(goalSteps.goalId, goalId)).orderBy(asc(goalSteps.id))
}

export async function getGoalStep(id: number): Promise<GoalStep | undefined> {
  const [row] = await db().select().from(goalSteps).where(eq(goalSteps.id, id)).limit(1)
  return row
}

export async function setGoalStepDone(id: number, done: boolean): Promise<GoalStep | undefined> {
  const [row] = await db().update(goalSteps).set({ done }).where(eq(goalSteps.id, id)).returning()
  return row
}

/** Tick steps off, or back on, by what they say: "venue" ticks "Book the venue", as a list item is matched. */
export async function markGoalSteps(goalId: number, needles: string[], done: boolean): Promise<GoalStep[]> {
  const matched = matchedIds(await goalStepsOf(goalId), needles)
  if (matched.length === 0) return []
  return db()
    .update(goalSteps)
    .set({ done })
    .where(and(eq(goalSteps.goalId, goalId), inArray(goalSteps.id, matched)))
    .returning()
}

export async function addGoalUpdate(goalId: number, note: string, memberId: number | null): Promise<GoalUpdate> {
  const [row] = await db().insert(goalUpdates).values({ goalId, note: note.trim(), memberId }).returning()
  await db().update(goals).set({ updatedAt: row.createdAt }).where(eq(goals.id, goalId))
  return row
}

/** A goal's latest progress notes, newest first, with who gave each. */
export async function goalUpdatesFor(goalId: number, limit = 5): Promise<(GoalUpdate & { who: string | null })[]> {
  const rows = await db()
    .select({ row: goalUpdates, who: members.name })
    .from(goalUpdates)
    .leftJoin(members, eq(members.id, goalUpdates.memberId))
    .where(eq(goalUpdates.goalId, goalId))
    .orderBy(desc(goalUpdates.createdAt), desc(goalUpdates.id))
    .limit(limit)
  return rows.map((r) => ({ ...r.row, who: r.who }))
}

/* ---------------------------------------------------------------- helpers */

export async function listHelpers(): Promise<Helper[]> {
  return db().select().from(helpers).orderBy(asc(helpers.id))
}

export async function getHelper(id: number): Promise<Helper | undefined> {
  const [row] = await db().select().from(helpers).where(eq(helpers.id, id)).limit(1)
  return row
}

export async function helperNamed(name: string): Promise<Helper | undefined> {
  const [row] = await db().select().from(helpers).where(sql`lower(${helpers.name}) = ${name.trim().toLowerCase()}`).limit(1)
  return row
}

/** A new helper, or null when one of that name, in any case, is already there. */
export async function addHelper(input: { name: string; role: string; createdBy: number | null }): Promise<Helper | null> {
  const [row] = await db()
    .insert(helpers)
    .values({ name: input.name.trim(), role: input.role.trim(), createdBy: input.createdBy })
    .onConflictDoNothing()
    .returning()
  return row ?? null
}

export async function deleteHelper(id: number): Promise<boolean> {
  return (await db().delete(helpers).where(eq(helpers.id, id)).returning()).length > 0
}

/* --------------------------------------------------------------- routines */

export async function listRoutines(): Promise<Routine[]> {
  return db().select().from(routines).orderBy(asc(routines.name))
}

export async function routineNamed(name: string): Promise<Routine | undefined> {
  const [row] = await db().select().from(routines).where(sql`lower(${routines.name}) = ${name.trim().toLowerCase()}`).limit(1)
  return row
}

/** Keep a routine, or replace the steps of the one already kept under that name. */
export async function saveRoutine(input: { name: string; steps: string; createdBy: number | null }): Promise<{ row: Routine; replaced: boolean }> {
  const existing = await routineNamed(input.name)
  if (existing) {
    const [row] = await db().update(routines).set({ steps: input.steps, updatedAt: new Date() }).where(eq(routines.id, existing.id)).returning()
    return { row, replaced: true }
  }
  const [made] = await db()
    .insert(routines)
    .values({ name: input.name.trim(), steps: input.steps, createdBy: input.createdBy })
    .onConflictDoNothing()
    .returning()
  // Kept under that name by someone else a moment ago: these steps replace its.
  return made ? { row: made, replaced: false } : saveRoutine(input)
}

export async function deleteRoutine(id: number): Promise<boolean> {
  return (await db().delete(routines).where(eq(routines.id, id)).returning()).length > 0
}

/* --------------------------------------------------------------- activity */

export async function recordActivity(input: { memberId: number | null; via: string; tool: string; summary: string }): Promise<void> {
  await db().insert(activity).values(input)
}

/** The latest changes, newest first, with whose each was; one member's own when one is named. */
export async function recentActivity(opts: { memberId?: number; limit?: number } = {}): Promise<(Activity & { who: string | null })[]> {
  const rows = await db()
    .select({ row: activity, who: members.name })
    .from(activity)
    .leftJoin(members, eq(members.id, activity.memberId))
    .where(opts.memberId !== undefined ? eq(activity.memberId, opts.memberId) : undefined)
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(opts.limit ?? 20)
  return rows.map((r) => ({ ...r.row, who: r.who }))
}

/** Ninety days is long enough to answer "what happened to the dentist booking?" and no longer. */
export async function pruneActivity(days = 90): Promise<number> {
  const rows = await db()
    .delete(activity)
    .where(lt(activity.createdAt, new Date(Date.now() - days * 86_400_000)))
    .returning({ id: activity.id })
  return rows.length
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
 * which Settings tells the admin who replaces it.
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

/** A member's own drafts still waiting on their yes, newest first. Only the writer can send one, so only they see it. */
export async function pendingDrafts(memberId: number): Promise<EmailDraft[]> {
  return db()
    .select()
    .from(emailDrafts)
    .where(and(eq(emailDrafts.memberId, memberId), eq(emailDrafts.status, 'pending')))
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
  const matched = matchedIds(await listContents(listId), needles)
  if (matched.length === 0) return []
  return db()
    .update(listItems)
    .set({ done })
    .where(and(eq(listItems.listId, listId), inArray(listItems.id, matched)))
    .returning()
}

/**
 * The ids of the rows some words name, in the order the words came: each
 * word takes the row that says it exactly, else the first containing it,
 * else the first it contains.
 */
function matchedIds(rows: readonly { id: number; content: string }[], needles: readonly string[]): number[] {
  const matched = new Set<number>()
  for (const needle of needles) {
    const n = needle.trim().toLowerCase()
    if (!n) continue
    const hit =
      rows.find((row) => row.content.toLowerCase() === n) ??
      rows.find((row) => row.content.toLowerCase().includes(n)) ??
      rows.find((row) => n.includes(row.content.toLowerCase()))
    if (hit) matched.add(hit.id)
  }
  return [...matched]
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

export async function getProposal(id: number): Promise<EventProposal | undefined> {
  const [row] = await db().select().from(eventProposals).where(eq(eventProposals.id, id)).limit(1)
  return row
}

/**
 * Every proposal, in any state, from this source or starting in this span:
 * the candidates for being the same occasion as a new find. Small by its
 * nature, a day's proposals and one source's.
 */
export async function proposalsAround(opts: { source: string | null; from: Date; to: Date }): Promise<EventProposal[]> {
  const inSpan = and(gte(eventProposals.startsAt, opts.from), lt(eventProposals.startsAt, opts.to))
  const source = opts.source?.trim()
  return db()
    .select()
    .from(eventProposals)
    .where(source ? or(eq(eventProposals.source, source), sql`split_part(${eventProposals.source}, '/', 1) = ${source.split('/')[0]}`, inSpan) : inSpan)
    .orderBy(asc(eventProposals.id))
}

/**
 * A new proposal. Two finds of the same source at once (two clients reading
 * the same notice in the same second) cannot both insert one: the source is
 * unique, and the second gets the first's row back.
 */
export async function addProposal(input: {
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
      memberId: input.memberId ?? null,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay ?? false,
      source: input.source?.trim() || null,
    })
    .onConflictDoNothing()
    .returning()
  if (row) return row
  const [have] = await db().select().from(eventProposals).where(eq(eventProposals.source, input.source!.trim())).limit(1)
  return have
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

/** Every proposal still worth an answer, soonest first. Any member may settle one. */
export async function pendingProposals(now: Date = new Date()): Promise<EventProposal[]> {
  return db().select().from(eventProposals).where(liveProposal(now)).orderBy(asc(eventProposals.startsAt))
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

export type MemberRow = Member & { linked: { provider: string; email: string | null; readOnly: boolean }[] }

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
      .map((c) => ({ provider: c.provider, email: c.email, readOnly: c.readOnly })),
  }))
}

/**
 * Add a member from the dashboard, or change one: by id when one is given,
 * otherwise by their address, so adding someone already in the family by the
 * same address changes that person rather than making a second.
 */
export async function saveMember(input: {
  id?: number
  name: string
  email: string | null
  allowed: boolean
  isAdmin: boolean
}): Promise<Member> {
  const email = input.email?.trim() || null
  const values = {
    name: input.name,
    email,
    allowed: input.allowed,
    // Losing access takes admin with it, so a revoked person cannot sign in.
    isAdmin: input.allowed && input.isAdmin,
  }
  const existing = input.id !== undefined
    ? await memberById(input.id)
    : email
      ? (await db().select().from(members).where(sql`lower(${members.email}) = ${email.toLowerCase()}`).limit(1))[0]
      : undefined
  // A change names someone already here; one who has gone is not made again.
  if (input.id !== undefined && !existing) throw new Error(`No member ${input.id}.`)
  if (existing) {
    const [row] = await db().update(members).set(values).where(eq(members.id, existing.id)).returning()
    return row
  }
  const [row] = await db().insert(members).values(values).returning()
  return row
}

export async function deleteMember(id: number): Promise<boolean> {
  // Their own scheduled instructions stop with them. Deleting the row sets
  // member_id to null, after which an automation would belong to nobody, so
  // it is paused while it is still known to be theirs.
  await db().update(automations).set({ enabled: false }).where(eq(automations.memberId, id))
  const rows = await db().delete(members).where(eq(members.id, id)).returning()
  return rows.length > 0
}
