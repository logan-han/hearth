import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MANAGED_KEYS } from '@/lib/settings'
import { allToolNames } from '@/lib/tools'

/**
 * What the docs say against what the code does. Each of these drifted once
 * with nothing noticing: variables the code reads that .env.example never
 * named, placeholders there that the store imported as real values, and tool
 * counts in the README several tools behind.
 */

// fileURLToPath, not .pathname: a checkout under a folder with a space in its
// name would otherwise be looked for at a %20 path that does not exist.
const root = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|mjs)$/.test(name) ? [path] : []
  })
}

const example = new Map(
  [...readFileSync(join(root, '.env.example'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2]]),
)

/** Set by the platform, not by whoever deploys. */
const PLATFORM = /^(NODE_ENV|NEXT_RUNTIME|VERCEL_\w+)$/

/** The dashboard settings .env.example fills in on purpose, as their starting values. */
const STARTING_VALUES: readonly string[] = ['GEMINI_MODEL', 'OPENROUTER_MODEL', 'TIMEZONE', 'LANGUAGE', 'UNITS']

describe('.env.example', () => {
  it('names every variable the code reads', () => {
    const sources = [
      ...['lib', 'app', 'scripts', 'evals'].flatMap((dir) => sourceFiles(join(root, dir))),
      join(root, 'instrumentation.ts'),
      join(root, 'drizzle.config.ts'),
    ]
    const read = new Set<string>()
    for (const file of sources) {
      const text = readFileSync(file, 'utf8')
      // Two letters at least: a comment's `process.env.X` is not a variable.
      for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|\b(?:required|optional|idSet)\('([A-Z][A-Z0-9_]+)'\)/g)) {
        read.add(m[1] ?? m[2])
      }
    }
    // A scan that matched nothing would pass whatever the file says.
    expect(read.has('DATABASE_URL') && read.has('TOKEN_ENC_KEY')).toBe(true)
    expect([...read].filter((key) => !PLATFORM.test(key) && !example.has(key)).sort()).toEqual([])
  })

  it('names every setting the dashboard manages', () => {
    expect(MANAGED_KEYS.filter((key) => !example.has(key))).toEqual([])
  })

  it('leaves the other dashboard settings empty, so a copy of it seeds no placeholder', () => {
    // The store imports whatever a managed key holds on first sight and never
    // reads it again: a sample bot token here once kept an admin from /setup.
    expect(MANAGED_KEYS.filter((key) => example.get(key) && !STARTING_VALUES.includes(key))).toEqual([])
  })
})

describe('the README', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')

  /** The number a sentence of the README gives, wherever its lines happen to wrap. */
  function claimed(sentence: string): number {
    const found = readme.match(new RegExp(sentence.replace(/ /g, '\\s+')))
    expect(found, sentence).toBeTruthy()
    return Number(found![1])
  }

  it('counts the tools as the code does', () => {
    expect(claimed('handed all (\\d+) tools')).toBe(allToolNames().length)
  })

  it('mentions Telegram only in the note that says when it was removed', () => {
    const lines = readme.split('\n').filter((line) => /telegram/i.test(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/Telegram was removed on \d{1,2} \w+ \d{4}/)
  })
})

describe('where the docs send an admin', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  const renders = (page: string | undefined, form: string) =>
    Boolean(page) && new RegExp(`<${form}\\b`).test(readFileSync(join(root, 'app', page!.toLowerCase(), 'page.tsx'), 'utf8'))

  it('names the page that reorders the chain', () => {
    // ChainForm is the one control that writes the order.
    expect(readFileSync(join(root, 'app/chain-form.tsx'), 'utf8')).toContain("key: 'LLM_ORDER'")
    expect(renders(/Also set on (\w+)\b[^\n]*\n(?:#[^\n]*\n)*LLM_ORDER=/.exec(env)?.[1], 'ChainForm')).toBe(true)
    expect(renders(/`LLM_ORDER`\s+and\s+is\s+editable\s+from\s+\*\*(\w+)\*\*/.exec(readme)?.[1], 'ChainForm')).toBe(true)
  })
})

describe('a household with no chat', () => {
  // The Telegram bot is gone, and nothing it needed may be left behind: not a
  // token, a webhook, a chat id to post to, or a dependency.
  const CHAT_ERA = /\b(?:telegram|grammy|botfather|webhook)\b|chat[ _]?id/i

  it('names nothing of the chat in code, scripts, settings or docs', () => {
    const files = [
      ...['lib', 'app', 'scripts', 'evals'].flatMap((dir) => sourceFiles(join(root, dir))),
      ...['instrumentation.ts', 'drizzle.config.ts', '.env.example', 'AGENTS.md', 'package.json'].map((f) => join(root, f)),
    ]
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ file: file.slice(root.length), line: i + 1, text: line.trim() }))
        .filter((l) => CHAT_ERA.test(l.text)),
    )
    expect(found).toEqual([])
  })

  it('leaves only the dated removal note in the README', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const lines = readme.split('\n').filter((line) => CHAT_ERA.test(line))
    expect(lines).toEqual([expect.stringMatching(/Telegram was removed on \d{1,2} \w+ \d{4}/)])
  })
})
