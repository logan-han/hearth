import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // A file's first test waits while its database is built: a few seconds of
    // initdb, which a busy runner can stretch past the default ten.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      // The application lives in lib/, app/api and the dashboard's
      // server-rendered pages, which hold the sign-in and admin gates. The
      // client components render through the pages' tests, but their handlers
      // only run in a browser, and with no DOM here they would read as
      // untested whatever the tests did. Config files and the one-shot webhook
      // script are not what coverage is measuring.
      include: ['lib/**/*.ts', 'app/api/**/*.ts', 'app/**/page.tsx', 'app/{shell,denied,sign-in,ui}.tsx'],
      exclude: ['lib/db/schema.ts', 'lib/load-env.ts'],
      // About a point and a half under what the suite reaches (lines 99.9,
      // statements and functions 99.6, branches 98.1), so a module of more
      // than about fifty lines that is merged without tests, or loses the
      // ones it had, fails the run. If a change lowers coverage for a good
      // reason, move these to the new level rather than widening the gap.
      thresholds: { lines: 98.5, functions: 98, branches: 96.5, statements: 98 },
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
