/**
 * Run pending migrations before `next build`, so a Deploy Button clone gets
 * its schema without anyone opening a terminal.
 *
 * Gated on the database URL being in the process env, which is true on Vercel
 * and false in a plain local `npm run build` — a local build should not touch
 * a database. Locally, run `npm run db:migrate` (reads .env.local) instead.
 *
 * On Vercel only a production build migrates. Every pushed branch gets a
 * preview build, and unless Neon gives each preview a branch of its own, the
 * preview shares production's database: a migration still under review would
 * land in production, and one stamped earlier but merged later would then be
 * skipped without a word, since drizzle applies only what is newer than the
 * last migration it ran. With a Neon branch per preview, MIGRATE_PREVIEWS=1
 * on the Preview environment lets previews migrate their own branch.
 */
import { execSync } from 'node:child_process'

const stage = process.env.VERCEL_ENV

if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_UNPOOLED) {
  console.log('[migrate] no DATABASE_URL in the environment, skipping')
} else if (stage && stage !== 'production' && process.env.MIGRATE_PREVIEWS !== '1') {
  console.log(`[migrate] a ${stage} build may share production's database, skipping (MIGRATE_PREVIEWS=1 to migrate)`)
} else {
  console.log('[migrate] database found, applying migrations')
  execSync('npx drizzle-kit migrate', { stdio: 'inherit' })
}
