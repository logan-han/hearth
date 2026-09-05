import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * A person in the family, keyed by their Telegram user id. `allowed` is the only
 * authorisation gate the bot has: rooms are never trusted, people are.
 */
export const members = pgTable(
  'members',
  {
    id: serial('id').primaryKey(),
    telegramUserId: text('telegram_user_id').notNull(),
    name: text('name').notNull(),
    /** Set by an admin so this person can sign in before linking an account. */
    email: text('email'),
    allowed: boolean('allowed').notNull().default(false),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('members_telegram_user_id_idx').on(t.telegramUserId)],
)

/**
 * Rooms the bot has seen. A room grants nothing on its own; `strangers` holds
 * the people seen here who are not allowed members, as a JSON array of
 * `{ id, name }`. While it is non-empty the bot stays quiet in that room, so a
 * private calendar or inbox is never read out in front of an outsider.
 */
export const chats = pgTable(
  'chats',
  {
    id: serial('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    type: text('type').notNull(),
    title: text('title'),
    strangers: text('strangers').notNull().default('[]'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Rolling summary of everything older than the raw history window. */
    summary: text('summary'),
    /** The newest message id the summary covers. */
    summaryThrough: integer('summary_through'),
    summaryAt: timestamp('summary_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('chats_chat_id_idx').on(t.chatId)],
)

export type Stranger = { id: string; name: string }

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
  },
  (t) => [uniqueIndex('connections_member_provider_idx').on(t.memberId, t.provider)],
)

/** Rolling conversation window per chat. Pruned to MAX_HISTORY per chat. */
export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    memberId: integer('member_id').references(() => members.id, { onDelete: 'set null' }),
    authorName: text('author_name'),
    role: text('role').notNull(), // 'user' | 'assistant'
    content: text('content').notNull(),
    /** For assistant rows: which model in the chain actually answered. */
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_chat_created_idx').on(t.chatId, t.createdAt)],
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

/** Scheduled instructions run by /api/tick. */
export const automations = pgTable(
  'automations',
  {
    id: serial('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    memberId: integer('member_id').references(() => members.id, { onDelete: 'set null' }),
    label: text('label').notNull(),
    cronExpr: text('cron_expr').notNull(),
    instruction: text('instruction').notNull(),
    /** A ready-made watcher's kind (money, inbox, morning); null for a custom instruction. */
    kind: text('kind'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('automations_next_run_idx').on(t.enabled, t.nextRunAt)],
)

/** Outbound email held for explicit human confirmation. Never sent silently. */
export const emailDrafts = pgTable(
  'email_drafts',
  {
    id: serial('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    memberId: integer('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    recipients: text('recipients').notNull(),
    cc: text('cc'),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('pending'), // pending | sent | cancelled
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_drafts_chat_status_idx').on(t.chatId, t.status)],
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
 * A calendar event the bot spotted somewhere (an email, a photographed notice)
 * and wants a human to confirm. Events found this way are never added silently.
 * `source` is the thing it came from, so the same email is never proposed twice.
 */
export const eventProposals = pgTable(
  'event_proposals',
  {
    id: serial('id').primaryKey(),
    chatId: text('chat_id').notNull(),
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
 * Admin-editable configuration that overrides the environment, so a key can be
 * rotated from the dashboard without a redeploy. Values are AES-256-GCM
 * encrypted with TOKEN_ENC_KEY, which is why that one key can never live here.
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

export type Member = typeof members.$inferSelect
export type Connection = typeof connections.$inferSelect
export type FamilyEvent = typeof familyEvents.$inferSelect
export type Automation = typeof automations.$inferSelect
export type EmailDraft = typeof emailDrafts.$inferSelect
export type List = typeof lists.$inferSelect
export type ListItem = typeof listItems.$inferSelect
export type EventProposal = typeof eventProposals.$inferSelect
export type Secret = typeof secrets.$inferSelect
