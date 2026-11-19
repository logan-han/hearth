/**
 * Load .env.local for the CLI entry points (drizzle-kit, npm run probe).
 * Next.js does this itself; standalone scripts do not.
 */
import { existsSync } from 'node:fs'

export function loadEnvLocal(): void {
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) {
      process.loadEnvFile(file)
      return
    }
  }
}
