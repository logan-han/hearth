import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/session'
import { hydrateSecrets, setSecret } from '@/lib/settings'
import { telegramApi, telegramStatus, registerCommands } from '@/lib/telegram-admin'
import { appUrl } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const deny = () => NextResponse.json({ error: 'Not an administrator' }, { status: 401 })

export async function GET() {
  if (!(await requireAdmin())) return deny()
  await hydrateSecrets()
  return NextResponse.json(await telegramStatus())
}

/**
 * `{ token }` saves a new bot token, but only one Telegram itself vouches for,
 * so a paste error cannot silently kill the bot. `{ register: true }` points
 * the bot's webhook at this deployment, minting a webhook secret when none is
 * set. Both may arrive in one request; the token lands first.
 */
export async function POST(req: Request) {
  const session = await requireAdmin()
  if (!session) return deny()
  await hydrateSecrets()

  let body: { token?: string; register?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  if (body.token !== undefined) {
    const token = String(body.token).trim()
    if (!/^\d+:[\w-]+$/.test(token)) {
      return NextResponse.json(
        { error: 'That does not look like a bot token. BotFather prints one like 123456:ABC-…' },
        { status: 400 },
      )
    }
    const me = await telegramApi<{ username?: string }>(token, 'getMe')
    if (!me.ok) {
      return NextResponse.json(
        { error: `Telegram rejected that token: ${me.description ?? 'unknown error'}` },
        { status: 400 },
      )
    }
    await setSecret('TELEGRAM_BOT_TOKEN', token, session.email)
  }

  if (body.register) {
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return NextResponse.json({ error: 'Set the bot token first.' }, { status: 400 })

    let secret = process.env.TELEGRAM_WEBHOOK_SECRET
    if (!secret) {
      secret = randomBytes(32).toString('hex')
      await setSecret('TELEGRAM_WEBHOOK_SECRET', secret, session.email)
    }

    const hook = await telegramApi(token, 'setWebhook', {
      url: `${appUrl()}/api/telegram`,
      secret_token: secret,
      allowed_updates: ['message', 'edited_message'],
    })
    if (!hook.ok) {
      return NextResponse.json(
        { error: `Telegram refused the webhook: ${hook.description ?? 'unknown error'}` },
        { status: 502 },
      )
    }
    // The "/" menu in Telegram is how the family discovers commands exist.
    if (!(await registerCommands(token))) {
      console.warn('[telegram] setMyCommands failed; the webhook itself is registered')
    }
  }

  return NextResponse.json(await telegramStatus())
}
