import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * The eval harness: live model calls against recorded tool results, scored by
 * deterministic checks and an LLM judge. Run with `npm run evals`; it is kept
 * out of `npm test` because it spends quota and depends on the chain's mood.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    setupFiles: ['evals/setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // One file at a time: free tiers rate-limit, and a queued eval is a slow
    // eval rather than a failed one.
    fileParallelism: false,
    reporters: ['verbose'],
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
