import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as schema from '@/lib/db/schema'
import { __setDb } from '@/lib/db'

/**
 * An in-process Postgres built from the real migrations, so the query layer is
 * exercised against actual SQL rather than a mocked driver. Constraints,
 * defaults and the claim-by-predicate updates all behave as they do on Neon.
 *
 * Starting a PGlite runs initdb, which takes seconds; paid by every test, it
 * was most of the suite's running time. So a test file builds its database
 * once, and each test starts from it emptied: every table truncated and its
 * ids restarted, which is all a new database would have held.
 */

// A test can change the schema itself, dropping a table or adding a
// constraint to make a write fail, and emptying the tables does not undo
// that. So any DDL after the build is noted, and the next test gets a
// database built afresh. A change rolled back with its transaction takes the
// note with it.
const NOTE_DDL = `
  create schema harness;
  create function harness.note_ddl() returns event_trigger language plpgsql
    as $$ begin perform set_config('harness.ddl', 'changed', false); end $$;
  create event trigger harness_ddl on ddl_command_start execute function harness.note_ddl();
`

type Built = { client: PGlite; empty: string }
let built: Promise<Built> | null = null

async function build(): Promise<Built> {
  const client = new PGlite()
  // The migrator the deploy runs, not the files statement by statement: every
  // migration in one transaction, in journal order, so one that only works
  // outside a transaction fails here rather than on the build.
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })
  await client.exec(NOTE_DDL)
  const { rows } = await client.query<{ name: string }>(
    `select quote_ident(tablename) as name from pg_tables where schemaname = 'public'`,
  )
  return { client, empty: `truncate ${rows.map((r) => r.name).join(', ')} restart identity cascade` }
}

export async function freshDb() {
  let current = await (built ??= build())
  const { rows } = await current.client.query<{ ddl: string | null }>(`select current_setting('harness.ddl', true) as ddl`)
  if (rows[0].ddl === 'changed') {
    await current.client.close()
    current = await (built = build())
  } else {
    await current.client.exec(current.empty)
  }
  const db = drizzle(current.client, { schema })
  __setDb(db)
  return { db, client: current.client }
}

/** The database itself stays open for the file's next test; the worker's exit closes it. */
export async function closeDb(_client: PGlite) {
  __setDb(null)
}
