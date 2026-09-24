import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/migrate.mjs', import.meta.url))

/** What the build step says, run with only the environment given. */
const run = (env: Record<string, string>) =>
  execFileSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env }, encoding: 'utf8' })

describe('the build-time migration', () => {
  it('leaves a build with no database alone', () => {
    expect(run({})).toContain('no DATABASE_URL')
  })

  it("never migrates from a preview build, which may be sharing production's database", () => {
    // Were it to try, drizzle-kit would fail on this address and the run would throw.
    for (const stage of ['preview', 'development']) {
      expect(run({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', VERCEL_ENV: stage })).toContain(
        `a ${stage} build may share production's database, skipping`,
      )
    }
  })
})
