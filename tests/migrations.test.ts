import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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
const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string }[]
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
