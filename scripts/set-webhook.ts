/**
 * Register the Telegram webhook against this deployment.
 *
 *   npm run set-webhook            # reads .env.local
 *   npm run set-webhook -- --delete
 *
 * Needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and APP_URL.
 */
import { loadEnvLocal } from '../lib/load-env'

loadEnvLocal()

const token = process.env.TELEGRAM_BOT_TOKEN
const secret = process.env.TELEGRAM_WEBHOOK_SECRET
const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '')

if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required')

const api = (method: string) => `https://api.telegram.org/bot${token}/${method}`

async function call(method: string, body?: unknown) {
  const res = await fetch(api(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown }
  if (!json.ok) throw new Error(`${method} failed: ${json.description}`)
  return json.result
}

async function main() {
  if (process.argv.includes('--delete')) {
    await call('deleteWebhook', { drop_pending_updates: true })
    console.log('Webhook deleted.')
    return
  }

  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET is required')
  if (!appUrl) throw new Error('APP_URL is required, e.g. https://hearth.vercel.app')

  const me = (await call('getMe')) as { username?: string }
  await call('setWebhook', {
    url: `${appUrl}/api/telegram`,
    secret_token: secret,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: true,
  })
  const { BOT_COMMANDS } = await import('../lib/telegram-admin')
  await call('setMyCommands', { commands: BOT_COMMANDS })
  const info = (await call('getWebhookInfo')) as { url?: string; pending_update_count?: number }

  console.log(`Bot:     @${me.username}`)
  console.log(`Webhook: ${info.url}`)
  console.log(`Pending: ${info.pending_update_count ?? 0}`)
  console.log('\nReminder: BotFather → /setprivacy → Disable, so the bot sees group messages.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
