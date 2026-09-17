import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'
import { required } from '../env'

type Db = ReturnType<typeof drizzle<typeof schema>>

let _db: Db | null = null

/** Lazily constructed so importing this module never requires DATABASE_URL. */
export function db(): Db {
  if (!_db) _db = drizzle(neon(required('DATABASE_URL')), { schema })
  return _db
}

/**
 * Test seam. Swaps in another drizzle instance, so the query layer can be
 * exercised against a real in-process Postgres instead of a mocked driver.
 */
export function __setDb(instance: unknown): void {
  _db = instance as Db | null
}

export { schema }
