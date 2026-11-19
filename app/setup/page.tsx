import { requireMember } from '@/lib/auth/session'
import { hydrateSecrets, SETTING_META } from '@/lib/settings'
import { allowedMembers } from '@/lib/db/queries'
import { timezone, language, units } from '@/lib/env'
import { Shell } from '../shell'
import { SignIn } from '../sign-in'
import { Denied } from '../denied'
import { SetupWizard } from '../setup-wizard'

export const dynamic = 'force-dynamic'

/**
 * The first-run walkthrough: everything between "deployed" and "the family is
 * using it", in order. Home sends an admin here while the household has
 * nobody in it; it stays reachable afterwards for adding people.
 */
export default async function SetupPage() {
  const session = await requireMember()
  if (!session) return <SignIn />
  if (session.role !== 'admin') return <Denied />

  await hydrateSecrets()
  const people = await allowedMembers()

  return (
    <Shell session={session} here="/setup">
      <SetupWizard
        members={people.map((m) => ({ name: m.name, email: m.email, isAdmin: m.isAdmin }))}
        llm={{
          gemini: Boolean(process.env.GEMINI_API_KEY),
          openrouter: Boolean(process.env.OPENROUTER_API_KEY),
          // The self-hosted tier contributes nothing without a model name.
          local: Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL?.trim()),
        }}
        timezone={timezone()}
        language={language()}
        units={units()}
        languageOptions={SETTING_META.LANGUAGE.options!}
      />
    </Shell>
  )
}
