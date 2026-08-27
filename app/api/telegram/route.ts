import { NextResponse } from 'next/server'
import type { Update } from 'grammy/types'
import { processInBackground } from '@/lib/handler'
import { hydrateSecrets } from '@/lib/settings'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // Dashboard-managed settings (the webhook secret itself, the bot token, LLM
  // keys) must be in place before the secret check and the background work.
  await hydrateSecrets()
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!expected) {
    console.error('[telegram] TELEGRAM_WEBHOOK_SECRET is not set; refusing all updates')
    return NextResponse.json({ ok: false }, { status: 503 })
  }
  if (req.headers.get('x-telegram-bot-api-secret-token') !== expected) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }

  let update: Update
  try {
    update = (await req.json()) as Update
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  // Telegram retries anything not acked within seconds, so ack now and process
  // in the background via Fluid compute's waitUntil.
  processInBackground(update)
  return NextResponse.json({ ok: true })
}

export async function GET() {
  return NextResponse.json({ ok: true, service: 'hearth-telegram-webhook' })
}
