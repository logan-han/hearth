import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/session'
import { hydrateSecrets } from '@/lib/settings'
import * as up from '@/lib/providers/up'
import * as ps from '@/lib/providers/pocketsmith'
import * as notion from '@/lib/providers/notion'
import * as jira from '@/lib/providers/jira'
import * as weather from '@/lib/providers/weather'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Live validity, not mere presence: each configured integration gets the
 * cheapest authenticated call its API offers, so a revoked key shows up on the
 * Settings page instead of failing silently at 9pm in a watcher.
 */
const PROBES: { name: string; configured: () => boolean; run: () => Promise<unknown> }[] = [
  { name: 'Up Bank', configured: up.upConfigured, run: () => up.ping() },
  { name: 'PocketSmith', configured: ps.pocketsmithConfigured, run: () => ps.userId() },
  { name: 'Notion', configured: notion.notionConfigured, run: () => notion.search({ limit: 1 }) },
  { name: 'Jira', configured: jira.jiraConfigured, run: () => jira.ping() },
  { name: 'OpenWeatherMap', configured: weather.weatherConfigured, run: () => weather.geocode('melbourne') },
]

function timeboxed(work: Promise<unknown>, ms = 6000): Promise<unknown> {
  return Promise.race([
    work,
    new Promise((_, reject) => setTimeout(() => reject(new Error('No answer within 6s.')), ms)),
  ])
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Not an administrator' }, { status: 401 })
  await hydrateSecrets()

  const items = await Promise.all(
    PROBES.filter((p) => p.configured()).map(async (p) => {
      try {
        await timeboxed(p.run())
        return { name: p.name, ok: true as const }
      } catch (err) {
        return { name: p.name, ok: false as const, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) }
      }
    }),
  )
  return NextResponse.json({ items })
}
