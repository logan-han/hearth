import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/session'
import { hydrateSecrets } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export type ModelOption = {
  id: string
  label: string
  free: boolean
  note: string
}

/**
 * What each provider will actually serve, so choosing a model is picking from a
 * list rather than typing an id and hoping. Only models that can drive tools
 * are offered: the agent is useless without tool calling, and a model that
 * cannot do it fails at the worst moment rather than at configuration time.
 */
export async function GET(req: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Not an administrator' }, { status: 401 })
  await hydrateSecrets()

  const provider = new URL(req.url).searchParams.get('provider') ?? ''
  try {
    if (provider === 'gemini') return NextResponse.json({ models: await gemini() })
    if (provider === 'openrouter') return NextResponse.json({ models: await openrouter() })
    if (provider === 'self-hosted') return NextResponse.json({ models: await selfHosted() })
    return NextResponse.json({ error: `Unknown provider "${provider}".` }, { status: 400 })
  } catch (err) {
    console.error(`[models] could not list ${provider}:`, err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not reach that provider.' },
      { status: 502 },
    )
  }
}

/** Generation-capable text models. Image, audio and embedding models are out. */
async function gemini(): Promise<ModelOption[]> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('Add a Gemini key first.')

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`)
  if (!res.ok) throw new Error(`Gemini said ${res.status}.`)
  const data = (await res.json()) as { models?: any[] }

  return (data.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => String(m.name).replace('models/', ''))
    .filter((id) => !/embedding|aqa|tts|image|vision-only|omni/i.test(id))
    .map((id) => ({
      id,
      label: id,
      free: true,
      note: id.includes('lite') ? 'fastest' : id.includes('pro') ? 'most capable' : '',
    }))
}

async function openrouter(): Promise<ModelOption[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models')
  if (!res.ok) throw new Error(`OpenRouter said ${res.status}.`)
  const data = (await res.json()) as { data?: any[] }

  return (data.data ?? [])
    .filter((m) => (m.supported_parameters ?? []).includes('tools'))
    .map((m) => {
      const inCost = Number(m.pricing?.prompt ?? 0) * 1e6
      const outCost = Number(m.pricing?.completion ?? 0) * 1e6
      const free = String(m.id).endsWith(':free') || (inCost === 0 && outCost === 0)
      return {
        id: String(m.id),
        label: String(m.name ?? m.id),
        free,
        note: free ? 'free' : `$${inCost.toFixed(2)} in / $${outCost.toFixed(2)} out per M`,
      }
    })
    .sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id))
}

/** OpenAI-compatible servers advertise what they have loaded at /v1/models. */
async function selfHosted(): Promise<ModelOption[]> {
  const base = process.env.LLM_BASE_URL
  if (!base) throw new Error('Add a self-hosted endpoint first.')

  const res = await fetch(`${base.replace(/\/$/, '')}/models`, {
    headers: process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {},
  })
  if (!res.ok) throw new Error(`Your server said ${res.status}.`)
  const data = (await res.json()) as { data?: { id: string }[] }
  return (data.data ?? []).map((m) => ({ id: m.id, label: m.id, free: true, note: 'self-hosted' }))
}
