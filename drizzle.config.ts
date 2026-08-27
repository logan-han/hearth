import type { Config } from 'drizzle-kit'
import { loadEnvLocal } from './lib/load-env'

loadEnvLocal()

export default {
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // DDL goes to the direct endpoint: pgbouncer in transaction mode is a poor
  // host for migrations. The app itself keeps using the pooled URL.
  dbCredentials: { url: (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL)! },
} satisfies Config
