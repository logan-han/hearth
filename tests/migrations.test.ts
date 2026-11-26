import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { sql } from 'drizzle-orm'

/**
 * Until migration 0006 the README told households to `db:push` to the
 * database every build migrates. Push builds the schema but records no
 * migrations, so the next build replays all of them from the start. Drizzle's
 * migrator goes by each migration's timestamp alone and never compares its
 * hash, so the migrations such a database can already hold are written to
 * skip whatever exists, and the build that finds one merely records them.
 */
const PUSHED_UP_TO = 6

const folder = fileURLToPath(new URL('../drizzle', import.meta.url))
const fullJournal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string }[]
}
const journal = fullJournal

/** The migrations as they stood at one of them, in a folder of their own for the migrator the deploy runs. */
function migrationsUpTo(idx: number): string {
  const dir = mkdtempSync(join(tmpdir(), `hearth-${String(idx).padStart(4, '0')}-`))
  mkdirSync(join(dir, 'meta'))
  const entries = journal.entries.filter((entry) => entry.idx <= idx)
  for (const { tag } of entries) copyFileSync(join(folder, `${tag}.sql`), join(dir, `${tag}.sql`))
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...fullJournal, entries }))
  return dir
}

describe('a database db:push built on the old advice', () => {
  it('is recorded, not rebuilt, by the next build', async () => {
    const client = new PGlite()
    const db = drizzle(client)
    try {
      // The schema as push left it then: every table and index, no journal.
      for (const { tag } of journal.entries.filter((entry) => entry.idx <= PUSHED_UP_TO)) {
        for (const statement of readFileSync(join(folder, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) {
          if (statement.trim()) await db.execute(sql.raw(statement))
        }
      }

      await migrate(db, { migrationsFolder: folder })

      const recorded = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
      expect(recorded.rows).toEqual([{ n: journal.entries.length }])
    } finally {
      await client.close()
    }
  })
})

/**
 * Hearth left Telegram in migrations 0009 and 0010: the MCP key each member
 * held moved to a table of keys of its own, the ready-made watchers went,
 * and with them the rooms, the history and every column that named a chat.
 * Built at 0008 the way a deployed household was, with what such a household
 * holds, the next build has to keep everything that still means something.
 */
describe('a household on migration 0008, when the next build moves it to MCP alone', () => {
  it('carries its keys over, keeps its own automations and data, and drops what only Telegram needed', async () => {
    process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
    const crypto = await import('@/lib/crypto')
    crypto.resetKeyCache()
    const key = await crypto.mintMcpKey(1)
    const hash = await crypto.hashToken(key)
    // A key from before its issue time was kept, as the first keys were.
    const junosKey = await crypto.mintMcpKey(3)
    const undated = await crypto.hashToken(junosKey)

    // The migrations as they stood at 0008, applied and recorded by the migrator the deploy runs.
    const at0008 = migrationsUpTo(8)
    const at0010 = migrationsUpTo(10)
    const client = new PGlite()
    const db = drizzle(client)
    try {
      await migrate(db, { migrationsFolder: at0008 })

      await client.exec(`
        insert into members (telegram_user_id, name, email, allowed, is_admin, mcp_token_hash, mcp_token_at) values
          ('111', 'Rowan', 'rowan@example.com', true, true, '${hash}', '2026-09-01T00:00:00Z'),
          ('222', 'Ada', null, true, false, null, null),
          ('333', 'Juno', null, false, false, '${undated}', null);
        insert into chats (chat_id, type, title) values ('-100', 'group', 'Family'), ('111', 'private', null);
        insert into messages (chat_id, member_id, role, content) values ('-100', 1, 'user', 'bins tonight');
        insert into helpers (name, role, groups) values ('Chef', 'Plans meals.', '["kitchen"]');
        insert into automations (chat_id, member_id, label, cron_expr, instruction, kind, next_run_at, repeat, helper_id) values
          ('-100', null, 'Morning brief', '0 7 * * *', 'x', 'morning', now(), 'always', null),
          ('111', 1, 'Money snapshot', '0 18 * * 0', 'y', 'snapshot', now(), 'always', null),
          ('111', 1, 'Chef: dinners', '0 9 * * *', 'plan the week', null, now(), 'once', 1),
          ('-100', 2, 'Goal check-in: Bali', '0 19 * * 0', 'check in', null, now(), 'always', null);
        insert into goals (chat_id, member_id, title, automation_id) values ('-100', 2, 'Bali', 4);
        insert into activity (chat_id, member_id, via, tool, summary) values ('-100', 1, 'chat', 'add_to_list', 'added milk to the shopping list');
        insert into email_drafts (chat_id, member_id, provider, recipients, subject, body) values ('111', 1, 'google', 'a@b.com', 'Hello', 'Body');
        insert into event_proposals (chat_id, member_id, title, starts_at, ends_at, source) values
          ('-100', 1, 'Fete', '2030-10-01T00:00:00Z', '2030-10-01T02:00:00Z', 'google:abc');
        insert into settings (key, value) values
          ('proactive_posts:-1', '[]'), ('unaccounted:-1', '2'), ('memory_sweep_day', '2026-11-19'),
          ('turn:x', '1 2'), ('turnq:-1:2', '1'), ('album:-1:n', '[]'),
          ('mail_cursor:-1:1:google', '{}'), ('mail_cursor:111:1:google', '{}'), ('mail_cursor:mcp:1:1:google', '{}'),
          ('mail_cursor:urgent:-100:1:google', '{}'), ('mail_cursor:auto:5:1:google', '{"at":"x"}'),
          ('last_tick_at', '2026-11-20T00:00:00.000Z'), ('calendar_token', 'tok'), ('signing_epoch', 'ep'), ('unspent:3', '{}');
        insert into secrets (key, value) values
          ('TELEGRAM_BOT_TOKEN', 'x'), ('TELEGRAM_WEBHOOK_SECRET', 'x'), ('ALLOWED_TELEGRAM_IDS', 'x'),
          ('AMBIENT_MODE', 'x'), ('ASSISTANT_PERSONA', 'x'), ('GEMINI_API_KEY', 'x'), ('ASSISTANT_NAME', 'x');
      `)

      await migrate(db, { migrationsFolder: at0010 })

      const rows = async (query: string) => (await client.query<Record<string, unknown>>(query)).rows
      expect(await rows(`select count(*)::int as n from drizzle.__drizzle_migrations`)).toEqual([{ n: 11 }])

      // The key a member held is one of their keys now, and nobody without one gains one.
      expect(await rows(`select id, member_id, label, token_hash, (created_at at time zone 'UTC')::text as made, last_used_at from mcp_keys where member_id = 1`)).toEqual([
        { id: 1, member_id: 1, label: 'Key from before keys were made on the web', token_hash: hash, made: '2026-09-01 00:00:00', last_used_at: null },
      ])
      // One with no time on record is dated to the move, and a key held by someone since denied moves too, and lets nobody in.
      expect(await rows(`select member_id, token_hash, created_at > now() - interval '1 hour' as recent from mcp_keys where member_id <> 1`)).toEqual([
        { member_id: 3, token_hash: undated, recent: true },
      ])
      // And it still lets its member in, through the query the endpoint runs.
      const { __setDb } = await import('@/lib/db')
      const schema = await import('@/lib/db/schema')
      const q = await import('@/lib/db/queries')
      __setDb(drizzle(client, { schema }))
      try {
        expect(await q.memberByMcpKey(key)).toEqual({ member: expect.objectContaining({ id: 1, name: 'Rowan' }), keyId: 1 })
        expect(await q.memberByMcpKey(junosKey)).toBeNull()
      } finally {
        __setDb(null)
      }

      // The ready-made watchers are gone; members' own automations stay, still theirs and their helpers'.
      expect(await rows(`select id, member_id, label, helper_id from automations order by id`)).toEqual([
        { id: 3, member_id: 1, label: 'Chef: dinners', helper_id: 1 },
        { id: 4, member_id: 2, label: 'Goal check-in: Bali', helper_id: null },
      ])
      expect(await rows(`select member_id, title, automation_id from goals`)).toEqual([{ member_id: 2, title: 'Bali', automation_id: 4 }])
      expect(await rows(`select member_id, via, summary from activity`)).toEqual([{ member_id: 1, via: 'chat', summary: 'added milk to the shopping list' }])
      expect(await rows(`select member_id, subject from email_drafts`)).toEqual([{ member_id: 1, subject: 'Hello' }])
      expect(await rows(`select member_id, title, source from event_proposals`)).toEqual([{ member_id: 1, title: 'Fete', source: 'google:abc' }])
      expect(await rows(`select name, role from helpers`)).toEqual([{ name: 'Chef', role: 'Plans meals.' }])
      expect(await rows(`select name, email, allowed, is_admin from members order by id`)).toEqual([
        { name: 'Rowan', email: 'rowan@example.com', allowed: true, is_admin: true },
        { name: 'Ada', email: null, allowed: true, is_admin: false },
        { name: 'Juno', email: null, allowed: false, is_admin: false },
      ])

      // What only a chat needed is forgotten; a scheduled job's markers, the tick's pulse and the feed's token stay.
      expect((await rows(`select key from settings order by key`)).map((r) => r.key)).toEqual([
        'calendar_token', 'last_tick_at', 'mail_cursor:auto:5:1:google', 'signing_epoch', 'unspent:3',
      ])
      expect((await rows(`select key from secrets order by key`)).map((r) => r.key)).toEqual(['ASSISTANT_NAME', 'GEMINI_API_KEY'])

      // The rooms, their history and every column that named a chat or a Telegram id are gone.
      expect(await rows(`select to_regclass('public.chats') as chats, to_regclass('public.messages') as messages`)).toEqual([{ chats: null, messages: null }])
      const gone = [
        ['members', 'telegram_user_id'], ['members', 'mcp_token_hash'], ['members', 'mcp_token_at'],
        ['automations', 'chat_id'], ['automations', 'kind'], ['goals', 'chat_id'], ['activity', 'chat_id'],
        ['email_drafts', 'chat_id'], ['event_proposals', 'chat_id'], ['helpers', 'groups'],
      ]
      const columns = new Set(
        (await rows(`select table_name, column_name from information_schema.columns where table_schema = 'public'`)).map((r) => `${r.table_name}.${r.column_name}`),
      )
      expect(gone.filter(([table, column]) => columns.has(`${table}.${column}`))).toEqual([])
      const indexes = new Set((await rows(`select indexname from pg_indexes where schemaname = 'public'`)).map((r) => r.indexname))
      for (const name of ['members_telegram_user_id_idx', 'members_mcp_token_idx', 'automations_chat_kind_idx', 'activity_chat_idx', 'email_drafts_chat_status_idx']) {
        expect(indexes.has(name)).toBe(false)
      }
      for (const name of ['mcp_keys_token_hash_idx', 'mcp_keys_member_idx', 'automation_reports_member_idx', 'activity_member_idx', 'email_drafts_member_status_idx']) {
        expect(indexes.has(name)).toBe(true)
      }
    } finally {
      await client.close()
      rmSync(at0008, { recursive: true, force: true })
      rmSync(at0010, { recursive: true, force: true })
    }
  })
})

describe('a household on migration 0010, when the next build drops mail', () => {
  it('drops the drafts and every mail marker, and keeps the rest of its settings', async () => {
    const at0010 = migrationsUpTo(10)
    const client = new PGlite()
    const db = drizzle(client)
    try {
      await migrate(db, { migrationsFolder: at0010 })
      await client.exec(`
        insert into members (name, email, allowed, is_admin) values ('Rowan', 'rowan@example.com', true, true);
        insert into email_drafts (member_id, provider, recipients, subject, body) values (1, 'google', 'a@b.com', 'Hello', 'Body');
        insert into settings (key, value) values
          ('mail_cursor:auto:5:1:google', '{"at":"x"}'), ('mail_cursor:key:3:1:microsoft', '{}'), ('mail_cursor:brief:1:google', '{}'),
          ('unspent:5', '{}'), ('last_tick_at', '2026-11-20T00:00:00.000Z'), ('calendar_token', 'tok'), ('signing_epoch', 'ep');
      `)

      await migrate(db, { migrationsFolder: folder })

      const rows = async (query: string) => (await client.query<Record<string, unknown>>(query)).rows
      expect(await rows(`select count(*)::int as n from drizzle.__drizzle_migrations`)).toEqual([{ n: journal.entries.length }])
      expect(await rows(`select to_regclass('public.email_drafts') as drafts`)).toEqual([{ drafts: null }])
      expect((await rows(`select key from settings order by key`)).map((r) => r.key)).toEqual(['calendar_token', 'last_tick_at', 'signing_epoch'])
      expect(await rows(`select name from members`)).toEqual([{ name: 'Rowan' }])
    } finally {
      await client.close()
      rmSync(at0010, { recursive: true, force: true })
    }
  })
})
