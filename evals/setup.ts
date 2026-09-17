import { loadEnvLocal } from '@/lib/load-env'

// Keys for the model chain come from .env.local, like the CLI scripts. Nothing
// else from there is wanted: evals must never touch the real database or send
// a Telegram message, so those are cleared before any module can read them.
loadEnvLocal()
for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET']) {
  delete process.env[key]
}
process.env.TOKEN_ENC_KEY ??= 'a'.repeat(64)
process.env.TIMEZONE ??= 'Australia/Melbourne'
