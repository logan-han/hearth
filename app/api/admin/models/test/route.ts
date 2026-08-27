import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/session'
import { hydrateSecrets } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Ask a model for one token, to find out whether it will actually serve you.
 *
 * This is the practical answer to "which free models don't train on my data".
 * Whether a provider may train is an OpenRouter account setting, not a model
 * property, and the API exposes no policy field. But with training disabled
 * OpenRouter refuses to route to providers that train, so a model that answers
 * is one that did not, and a model that cannot be reached is being declined on
 * your behalf rather than quietly used.
 */
export async function POST(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Not an administrator' }, { status: 401 })
  await hydrateSecrets()

  let body: { provider?: string; model?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }
  const { provider, model } = body
  if (!model) return NextResponse.json({ error: 'Which model?' }, { status: 400 })

  const target = endpointFor(provider ?? '')
  if (!target) return NextResponse.json({ error: `Unknown provider "${provider}".` }, { status: 400 })
  if (!target.key) return NextResponse.json({ ok: false, reason: 'No key set for that provider.' })

  try {
    const res = await fetch(`${target.base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await res.json()) as any

    if (res.ok && !data.error) {
      return NextResponse.json({
        ok: true,
        servedBy: data.provider ?? null,
        reason: data.provider ? `Answered, served by ${data.provider}.` : 'Answered.',
      })
    }
    const message = String(data?.error?.message ?? `HTTP ${res.status}`)
    return NextResponse.json({ ok: false, reason: friendly(message, data?.error?.code) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, reason: message.includes('timed out') ? 'Timed out.' : message })
  }
}

function endpointFor(provider: string) {
  if (provider === 'openrouter') {
    return { base: 'https://openrouter.ai/api/v1', key: process.env.OPENROUTER_API_KEY }
  }
  if (provider === 'gemini') {
    return {
      base: 'https://generativelanguage.googleapis.com/v1beta/openai',
      key: process.env.GEMINI_API_KEY,
    }
  }
  if (provider === 'self-hosted') {
    return { base: (process.env.LLM_BASE_URL ?? '').replace(/\/$/, ''), key: process.env.LLM_API_KEY || 'not-needed' }
  }
  return null
}

/** Say what the refusal means, since the raw messages are opaque. */
function friendly(message: string, code?: number): string {
  if (/data polic|no allowed provider|no endpoints found/i.test(message)) {
    return 'Refused by your privacy settings: every provider for this model wants to train on prompts.'
  }
  if (code === 429 || /rate limit|quota/i.test(message)) return 'Rate limited right now, so this tells us nothing.'
  if (/tool/i.test(message)) return 'Reachable, but it refused the request shape.'
  return message.slice(0, 140)
}
