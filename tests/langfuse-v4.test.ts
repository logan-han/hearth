import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * Langfuse v4 contract. Ingestion goes through the OpenTelemetry-based
 * @langfuse packages at 5.4 or later, trace attributes are propagated before
 * the model call, and nothing in the app reaches for the retired v3 surface:
 * the `langfuse` SDK, the legacy ingestion endpoint, or trace-level I/O
 * setters. A regression here would start failing on 16 November 2026.
 */
const MIN_LANGFUSE_JS = [5, 4, 0]

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
}

function lowerBound(range: string): number[] {
  const m = range.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) throw new Error(`cannot read a version out of ${range}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

const atLeast = (v: number[], min: number[]) =>
  v[0] !== min[0] ? v[0] > min[0] : v[1] !== min[1] ? v[1] > min[1] : v[2] >= min[2]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|mjs)$/.test(name) ? [path] : []
  })
}

const root = new URL('..', import.meta.url).pathname
const appSources = [...sourceFiles(join(root, 'lib')), ...sourceFiles(join(root, 'app')), join(root, 'instrumentation.ts')]

/**
 * The calls to a model, each of which Langfuse should see inside a trace: the
 * AI SDK's own, and observed(), which wraps every other one (Jev's). The
 * telemetry module only defines observed(), so every call to it found here
 * is a model call.
 */
const MODEL_CALLS = new Set(['generateText', 'streamText', 'generateObject', 'streamObject', 'observed'])

/** Every model call in a file, and whether it sits inside a traced() call. */
function modelCalls(file: string): { at: string; traced: boolean }[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: { at: string; traced: boolean }[] = []
  const visit = (node: ts.Node, inTrace: boolean) => {
    let within = inTrace
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (MODEL_CALLS.has(name)) {
        found.push({ at: `${file.slice(root.length)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, traced: inTrace })
      }
      if (name === 'traced') within = true
    }
    ts.forEachChild(node, (child) => visit(child, within))
  }
  visit(source, false)
  return found
}

describe('Langfuse v4 readiness', () => {
  it('declares and installs the OpenTelemetry-based SDK at a v4-compatible version', () => {
    for (const name of ['@langfuse/otel', '@langfuse/tracing', '@langfuse/vercel-ai-sdk']) {
      expect(atLeast(lowerBound(pkg.dependencies[name]), MIN_LANGFUSE_JS), `${name} declared range`).toBe(true)
      const installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }
      expect(atLeast(lowerBound(installed.version), MIN_LANGFUSE_JS), `${name} installed`).toBe(true)
    }
    expect(pkg.dependencies).not.toHaveProperty('langfuse')
  })

  it('never touches the retired v3 surface', () => {
    const forbidden = [/from ['"]langfuse['"]/, /api\/public\/ingestion/, /setTraceIO|updateTrace\(/, /experimental_telemetry/]
    for (const file of appSources) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of forbidden) expect(text, `${file} matches ${pattern}`).not.toMatch(pattern)
    }
  })

  it('makes every model call inside traced(), which propagates the trace attributes', () => {
    // What traced() does with the attributes is tests/telemetry.test.ts's to
    // check; this is that no call to a model goes around it.
    const calls = appSources.flatMap(modelCalls)
    expect(calls.filter((c) => c.at.startsWith('lib/agent.ts:')).length).toBeGreaterThan(0)
    expect(calls.filter((c) => c.at.startsWith('lib/jev.ts:')).length).toBeGreaterThan(0)
    expect(calls.filter((c) => !c.traced).map((c) => c.at)).toEqual([])
  })
})
