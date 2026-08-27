import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // The application lives in lib/ and app/api. Config files, the marketing
      // page and the one-shot webhook script are not what coverage is measuring.
      include: ['lib/**/*.ts', 'app/api/**/*.ts'],
      exclude: ['lib/db/schema.ts', 'lib/load-env.ts', 'lib/stats.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
