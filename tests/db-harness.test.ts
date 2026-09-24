import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { freshDb, closeDb } from './helpers/db'
import { db } from '@/lib/db'
import * as q from '@/lib/db/queries'

/** The harness every query-layer test stands on, held to what it promises. */

const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: { idx: number; when: number; tag: string }[]
}

let client: PGlite
beforeEach(async () => {
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('the migrations', () => {
  it('are listed in the order they were made', () => {
    // The deploy's migrator skips any migration older than the last one it
    // applied, for good and without a word, so one merged out of order would
    // pass every test here and never reach production.
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i)
      if (i > 0) expect(entry.when).toBeGreaterThan(journal.entries[i - 1].when)
    })
  })

  it('build the test database through the migrator the deploy runs', async () => {
    const { rows } = await client.query<{ hash: string; created_at: string }>(
      `select hash, created_at::text from drizzle.__drizzle_migrations order by id`,
    )
    expect(rows).toEqual(
      journal.entries.map(({ tag, when }) => ({
        hash: createHash('sha256').update(readFileSync(new URL(`../drizzle/${tag}.sql`, import.meta.url), 'utf8')).digest('hex'),
        created_at: String(when),
      })),
    )
  })
})

describe('each test', () => {
  let before: PGlite

  it('may write rows', async () => {
    expect((await q.upsertMember('111', 'Rowan', { allowed: true })).id).toBe(1)
    await q.upsertMember('222', 'Ada', { allowed: true })
    before = client
  })

  it('starts with the tables empty and the ids from one, on the same database', async () => {
    expect(client).toBe(before)
    expect(await q.allMembers()).toEqual([])
    expect((await q.upsertMember('333', 'Juno', { allowed: true })).id).toBe(1)
  })

  it('may change the schema', async () => {
    await db().execute(sql`drop table model_events`)
    await db().execute(sql`alter table members add constraint no_one_for_test check (false)`)
    before = client
  })

  it('starts from the schema as migrated, on a database built afresh', async () => {
    expect(client).not.toBe(before)
    await expect(db().execute(sql`select count(*) from model_events`)).resolves.toBeTruthy()
    expect((await q.upsertMember('111', 'Rowan', { allowed: true })).id).toBe(1)
  })

  it('keeps the database when a schema change was rolled back', async () => {
    await client.exec(`begin; drop table model_events; rollback;`)
    before = client
  })

  it('so the next test reuses it', async () => {
    expect(client).toBe(before)
    await expect(db().execute(sql`select count(*) from model_events`)).resolves.toBeTruthy()
  })
})
