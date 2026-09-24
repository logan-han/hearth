import { NextResponse } from 'next/server'
import type { Update } from 'grammy/types'
import { processInBackground } from '@/lib/handler'
import { hydrateSecrets, recheckSecrets } from '@/lib/settings'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // The secret this instance already holds is checked before anything touches
  // the database, so a stranger's post costs no read (see recheckSecrets).
  // Dashboard-managed settings (the webhook secret itself, the bot token, LLM
  // keys) are then read fresh for the second check and the background work.
  const given = req.headers.get('x-telegram-bot-api-secret-token')
  const held = process.env.TELEGRAM_WEBHOOK_SECRET
  if (held && given === held) await hydrateSecrets()
  else if (!(await recheckSecrets())) return NextResponse.json({ ok: false }, { status: held ? 401 : 503 })
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!expected) {
    console.error('[telegram] TELEGRAM_WEBHOOK_SECRET is not set; refusing all updates')
    return NextResponse.json({ ok: false }, { status: 503 })
  }
  if (given !== expected) {
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
