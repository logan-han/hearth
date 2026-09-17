import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'
import * as schema from '@/lib/db/schema'
import { __setDb } from '@/lib/db'

/**
 * An in-process Postgres built from the real migration, so the query layer is
 * exercised against actual SQL rather than a mocked driver. Constraints,
 * defaults and the claim-by-predicate updates all behave as they do on Neon.
 */
export async function freshDb() {
  const client = new PGlite()
  const db = drizzle(client, { schema })

  // Every migration in journal order, so the test schema is the deployed one.
  const journal = JSON.parse(
    readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: { tag: string }[] }
  for (const { tag } of journal.entries) {
    const migration = readFileSync(new URL(`../../drizzle/${tag}.sql`, import.meta.url), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await db.execute(sql.raw(trimmed))
    }
  }

  __setDb(db)
  return { db, client }
}

export async function closeDb(client: PGlite) {
  __setDb(null)
  await client.close()
}
