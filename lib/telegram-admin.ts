import { appUrl } from './env'

/**
 * Talking to Telegram about the bot itself: is the token real, where does the
 * webhook point. Used by the admin API and the setup guide, not the bot's own
 * message traffic, which goes through grammY in lib/telegram.ts.
 */

export type TelegramApiResult<T> = { ok: boolean; description?: string; result?: T }

export async function telegramApi<T>(token: string, method: string, body?: unknown): Promise<TelegramApiResult<T>> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return (await res.json()) as TelegramApiResult<T>
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The everyday commands, registered with Telegram so the "/" menu lists them —
 * nobody should have to remember a command exists. Admin-only ones stay out.
 */
export const BOT_COMMANDS = [
  { command: 'watch', description: 'Check money, inbox or the day ahead — posts only when it matters' },
  { command: 'connect', description: 'Link your Google or Microsoft account' },
  { command: 'accounts', description: 'See and unlink your linked accounts' },
  { command: 'calendar', description: 'The family calendar subscription link' },
  { command: 'whoami', description: 'Your Telegram id' },
  { command: 'members', description: 'Who I answer to' },
  { command: 'help', description: 'Everything I can do' },
] as const

/** Best-effort: a webhook that works with a stale menu beats no webhook. */
export async function registerCommands(token: string): Promise<boolean> {
  const res = await telegramApi(token, 'setMyCommands', { commands: BOT_COMMANDS })
  return res.ok
}

export type TelegramStatus = {
  configured: boolean
  ok: boolean
  username: string | null
  error?: string
  secretSet: boolean
  webhook: { url: string | null; pending: number; lastError: string | null } | null
  expectedUrl: string
  connected: boolean
}

/**
 * One picture of the bot as Telegram sees it, for the settings panel and the
 * setup guide. `connected` means updates reach this deployment specifically:
 * a webhook pointing at an old URL is a configured bot that hears nothing.
 */
export async function telegramStatus(): Promise<TelegramStatus> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const expectedUrl = `${appUrl()}/api/telegram`
  const secretSet = Boolean(process.env.TELEGRAM_WEBHOOK_SECRET)

  if (!token) {
    return { configured: false, ok: false, username: null, secretSet, webhook: null, expectedUrl, connected: false }
  }

  const [me, hook] = await Promise.all([
    telegramApi<{ username?: string }>(token, 'getMe'),
    telegramApi<{ url?: string; pending_update_count?: number; last_error_message?: string }>(token, 'getWebhookInfo'),
  ])

  const webhook = hook.ok
    ? {
        url: hook.result?.url || null,
        pending: hook.result?.pending_update_count ?? 0,
        lastError: hook.result?.last_error_message ?? null,
      }
    : null

  return {
    configured: true,
    ok: me.ok,
    username: me.ok ? (me.result?.username ?? null) : null,
    error: me.ok ? undefined : me.description,
    secretSet,
    webhook,
    expectedUrl,
    connected: Boolean(webhook?.url === expectedUrl && secretSet),
  }
}
