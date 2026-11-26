import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  integer,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * A person in the family. `allowed` is the only authorisation gate there is:
 * a dashboard session, an MCP key and a linked account all act for a member,
 * and none of them for anyone whose row says they may not. `email` is how
 * they sign in on the web before they have linked anything.
 */
export const members = pgTable('members', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  /** Set by an admin so this person can sign in before linking an account. */
  email: text('email'),
  allowed: boolean('allowed').notNull().default(false),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A key a member made on the web for an MCP client, or that the OAuth flow
 * made for a client they approved. Only the SHA-256 of the key is kept, so a
 * lost key is replaced rather than looked up, and deleting the row revokes it
 * for good.
 */
export const mcpKeys = pgTable(
  'mcp_keys',
  {
    id: serial('id').primaryKey(),
    memberId: integer('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** What the member called it, or the client that asked for it: "Claude Code on the laptop". */
    label: text('label').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When it was last used, to the hour: enough to tell a live key from a forgotten one. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('mcp_keys_token_hash_idx').on(t.tokenHash), index('mcp_keys_member_idx').on(t.memberId)],
)

/** A linked Google or Microsoft account belonging to one member. */
export const connections = pgTable(
  'connections',
  {
    id: serial('id').primaryKey(),
    memberId: integer('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'google' | 'microsoft'
    email: text('email'),
    refreshToken: text('refresh_token').notNull(), // AES-256-GCM, see lib/crypto.ts
    scopes: text('scopes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Linked to be read and never written from, by its owner's choice: no
     * draft, send or calendar entry goes through it, whoever asks. Relinking
     * the account keeps the choice.
     */
    readOnly: boolean('read_only').notNull().default(false),
  },
  (t) => [uniqueIndex('connections_member_provider_idx').on(t.memberId, t.provider)],
)

/** The shared family calendar, served as ICS. */
export const familyEvents = pgTable(
  'family_events',
  {
    id: serial('id').primaryKey(),
    uid: text('uid').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    allDay: boolean('all_day').notNull().default(false),
    createdBy: integer('created_by').references(() => members.id, { onDelete: 'set null' }),
    cancelled: boolean('cancelled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('family_events_uid_idx').on(t.uid),
    index('family_events_starts_at_idx').on(t.startsAt),
  ],
)

/** Durable shared facts: "bin night is Monday". */
export const memories = pgTable(
  'memories',
  {
    id: serial('id').primaryKey(),
    content: text('content').notNull(),
    createdBy: integer('created_by').references(() => members.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when forgotten or corrected. Rows stay, so a correction keeps its history. */
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    /** The memory that replaced this one, when a correction did the forgetting. */
    supersededBy: integer('superseded_by'),
  },
  (t) => [index('memories_created_at_idx').on(t.createdAt)],
)

/**
 * A fact worth keeping that nobody could stand behind yet: it does not say
 * who it is about, or it rests on a notice or an email rather than on a
 * person saying so. It is put to the family instead, once, and filed only on
 * a yes.
 */
export const memoryQuestions = pgTable(
  'memory_questions',
  {
    id: serial('id').primaryKey(),
    /** As put to the family. */
    question: text('question').notNull(),
    /** The fact to file on a yes. */
    candidate: text('candidate').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When a morning brief first put it to someone; Home carries it from then on. */
    askedAt: timestamp('asked_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    outcome: text('outcome'), // confirmed | dismissed
    /** The memory filed on a yes. */
    memoryId: integer('memory_id'),
  },
  (t) => [index('memory_questions_settled_idx').on(t.settledAt)],
)

/**
 * A member's scheduled instruction, run by /api/tick: a reminder, a watch
 * that runs until it finds something, a goal's check-in, a job handed to a
 * helper. What a run finds is kept as a report for the member who set it up.
 */
export const automations = pgTable(
  'automations',
  {
    id: serial('id').primaryKey(),
    memberId: integer('member_id').references(() => members.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    cronExpr: text('cron_expr').notNull(),
    instruction: text('instruction').notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * always: at every time its cron gives. once: at the first of them, then
     * it switches itself off, for "tomorrow at 5pm" and work handed over to do
     * later. until: at every time until a run has something to report, then
     * it switches itself off, for "tell us when the camp dates are out".
     */
    repeat: text('repeat').notNull().default('always'),
    /** The helper whose job this is, who runs it and is named on its report; null for Hearth itself. */
    helperId: integer('helper_id').references((): AnyPgColumn => helpers.id, { onDelete: 'set null' }),
  },
  (t) => [index('automations_next_run_idx').on(t.enabled, t.nextRunAt)],
)

/**
 * What a scheduled run found, kept for the member who set it up: nothing is
 * posted anywhere, so it waits here until their MCP client or Home reads
 * it. A draft the checks held back is kept too, marked, with why. Pruned
 * after thirty days.
 */
export const automationReports = pgTable(
  'automation_reports',
  {
    id: serial('id').primaryKey(),
    memberId: integer('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** The automation that ran; a one-off or a finished watch is gone by the time it is read. */
    automationId: integer('automation_id').references(() => automations.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    /** The helper whose job it was, by name, when one did it. */
    helper: text('helper'),
    /** ready | held | problem */
    status: text('status').notNull(),
    body: text('body').notNull(),
    /** Why a draft was held back, what went wrong, or what the checks changed. */
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('automation_reports_member_idx').on(t.memberId, t.createdAt)],
)

/**
 * Something one member wants to get done over weeks rather than in one go: a
 * trip saved for, a party planned, a house readied for sale. Its steps are its
 * own, never a shared list, and it is its owner's alone; a check-in automation
 * reports on it until it is done or dropped.
 */
export const goals = pgTable(
  'goals',
  {
    id: serial('id').primaryKey(),
    memberId: integer('member_id').references(() => members.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** What done looks like, in the household's words. */
    outcome: text('outcome'),
    /** The day it is meant to be done by, as YYYY-MM-DD in household time. */
    targetDate: text('target_date'),
    /** The check-in that reports on it; gone once the goal is closed. */
    automationId: integer('automation_id').references(() => automations.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('active'), // active | done | dropped
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('goals_status_idx').on(t.status)],
)

/** One step of a goal's plan, in the order it was planned: one thing a person can do. */
export const goalSteps = pgTable(
  'goal_steps',
  {
    id: serial('id').primaryKey(),
    goalId: integer('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    done: boolean('done').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('goal_steps_goal_idx').on(t.goalId)],
)

/** Progress on a goal as someone reported it: "booked the venue", "another $400 in the trip account". */
export const goalUpdates = pgTable(
  'goal_updates',
  {
    id: serial('id').primaryKey(),
    goalId: integer('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    memberId: integer('member_id').references(() => members.id, { onDelete: 'set null' }),
    note: text('note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('goal_updates_goal_idx').on(t.goalId, t.createdAt)],
)

/**
 * A named specialist the family can hand a job to ("Researcher, look into
 * plumbers for tonight"): a role it plays when it does that job, and that an
 * MCP client can take up when someone talks to it by name.
 */
export const helpers = pgTable(
  'helpers',
  {
    id: serial('id').primaryKey(),
    /** As the family writes it; two helpers never share a name in any case. */
    name: text('name').notNull(),
    /** Who it is and what it looks after, as its standing instructions. */
    role: text('role').notNull(),
    createdBy: integer('created_by').references(() => members.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('helpers_name_idx').on(sql`lower(${t.name})`)],
)

/**
 * Something the household does the same way each time, kept once and run by
 * name: "the Sunday reset", "getting ready for a school term". Its steps are
 * instructions, carried out with whatever tools the caller has.
 */
export const routines = pgTable(
  'routines',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    steps: text('steps').notNull(),
    createdBy: integer('created_by').references(() => members.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('routines_name_idx').on(sql`lower(${t.name})`)],
)

/**
 * What Hearth changed, one row a change: each member's record of what was
 * done in their name and how, kept so they can look back over it rather than
 * take anyone's word. Pruned after ninety days.
 */
export const activity = pgTable(
  'activity',
  {
    id: serial('id').primaryKey(),
    memberId: integer('member_id').references(() => members.id, { onDelete: 'set null' }),
    /** mcp | web | watcher */
    via: text('via').notNull(),
    tool: text('tool').notNull(),
    /** One line a person can read: "added milk, eggs to the shopping list". */
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('activity_created_idx').on(t.createdAt), index('activity_member_idx').on(t.memberId, t.createdAt)],
)

/** A named shared list: groceries, packing, jobs to do. */
export const lists = pgTable(
  'lists',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('lists_name_idx').on(t.name)],
)

export const listItems = pgTable(
  'list_items',
  {
    id: serial('id').primaryKey(),
    listId: integer('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    done: boolean('done').notNull().default(false),
    addedBy: integer('added_by').references(() => members.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('list_items_list_idx').on(t.listId, t.done)],
)

/**
 * A calendar event found somewhere (an email, a notice, a page) that a person
 * has to confirm. Events found this way are never added silently, and any
 * member may settle one. `source` is the thing it came from, so the same
 * email is never proposed twice.
 */
export const eventProposals = pgTable(
  'event_proposals',
  {
    id: serial('id').primaryKey(),
    memberId: integer('member_id').references(() => members.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    location: text('location'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    allDay: boolean('all_day').notNull().default(false),
    source: text('source'),
    status: text('status').notNull().default('pending'), // pending | accepted | rejected | expired | superseded
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('event_proposals_status_idx').on(t.status),
    uniqueIndex('event_proposals_source_idx').on(t.source),
  ],
)

/**
 * Admin-editable configuration for a fixed allowlist of keys, so a key can be
 * rotated from the dashboard without a redeploy. The deployment's environment
 * seeds a key the first time it is seen; from then on this table owns it, and
 * a removed key keeps a row with an empty value so it is not seeded again.
 * Values are AES-256-GCM encrypted with TOKEN_ENC_KEY, which is why that one
 * key can never live here.
 */
export const secrets = pgTable('secrets', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
})

/** Single-row app settings, e.g. the ICS feed token. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

/**
 * One row per model call: which slot, for what, whether it answered and how
 * long it took, or why it failed and the chain moved on. The System page's
 * chain health reads from here; rows older than a month are pruned.
 */
export const modelEvents = pgTable(
  'model_events',
  {
    id: serial('id').primaryKey(),
    slot: text('slot').notNull(),
    /** hearth.watcher, hearth.decision, hearth.verify */
    purpose: text('purpose').notNull(),
    /** answered | failed */
    outcome: text('outcome').notNull(),
    ms: integer('ms').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('model_events_created_idx').on(t.createdAt)],
)

export type Member = typeof members.$inferSelect
export type McpKey = typeof mcpKeys.$inferSelect
export type Connection = typeof connections.$inferSelect
export type FamilyEvent = typeof familyEvents.$inferSelect
export type Automation = typeof automations.$inferSelect
export type AutomationReport = typeof automationReports.$inferSelect
export type List = typeof lists.$inferSelect
export type ListItem = typeof listItems.$inferSelect
export type EventProposal = typeof eventProposals.$inferSelect
export type Memory = typeof memories.$inferSelect
export type MemoryQuestion = typeof memoryQuestions.$inferSelect
export type Secret = typeof secrets.$inferSelect
export type Goal = typeof goals.$inferSelect
export type GoalUpdate = typeof goalUpdates.$inferSelect
export type GoalStep = typeof goalSteps.$inferSelect
export type Helper = typeof helpers.$inferSelect
export type Routine = typeof routines.$inferSelect
export type Activity = typeof activity.$inferSelect
