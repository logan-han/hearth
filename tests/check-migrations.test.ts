import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * CI's check that lib/db/schema.ts has no change drizzle/ lacks. drizzle-kit
 * exits 0 whatever happens, so each case here stands in an npx that prints
 * what drizzle-kit printed in that case and exits 0, as it does.
 */
const script = fileURLToPath(new URL('../scripts/check-migrations.sh', import.meta.url))
let bin: string

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'hearth-npx-'))
})

afterAll(() => {
  rmSync(bin, { recursive: true, force: true })
})

function check(printed: string): number | null {
  writeFileSync(join(bin, 'npx'), `#!/bin/sh\ncat <<'EOF'\n${printed}\nEOF\n`, { mode: 0o755 })
  return spawnSync('bash', [script], { cwd: bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).status
}

describe('the migrations check', () => {
  it('passes when drizzle-kit finds nothing to migrate', () => {
    expect(check('15 tables\n\nNo schema changes, nothing to migrate 😴')).toBe(0)
  })

  it('fails when drizzle-kit writes a migration the commit lacks', () => {
    expect(check('[✓] Your SQL migration file ➜ drizzle/0007_right_shen.sql 🚀')).toBe(1)
  })

  it('fails when drizzle-kit could not compare, though it exits 0 and writes nothing', () => {
    // A renamed column in CI, where there is no terminal for the rename prompt.
    expect(check('Error: Interactive prompts require a TTY terminal (process.stdin.isTTY or process.stdout.isTTY is false). This can happen when running in CI, piped input, or non-interactive shells.')).toBe(1)
    // A schema that does not compile.
    expect(check("    at Pipe.onStreamRead (node:internal/stream_base_commons:189:23) {\n  name: 'TransformError'\n}")).toBe(1)
  })
})
