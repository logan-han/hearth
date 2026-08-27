/**
 * Run pending migrations before `next build`, so a Deploy Button clone gets
 * its schema without anyone opening a terminal.
 *
 * Gated on the database URL being in the process env, which is true on Vercel
 * and false in a plain local `npm run build` — a local build should not touch
 * a database. Locally, run `npm run db:migrate` (reads .env.local) instead.
 */
import { execSync } from 'node:child_process'

if (process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED) {
  console.log('[migrate] database found, applying migrations')
  execSync('npx drizzle-kit migrate', { stdio: 'inherit' })
} else {
  console.log('[migrate] no DATABASE_URL in the environment, skipping')
}
