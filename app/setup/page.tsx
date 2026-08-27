import { readSession } from '@/lib/auth/session'
import { hydrateSecrets, SETTING_META } from '@/lib/settings'
import { telegramStatus } from '@/lib/telegram-admin'
import { allowedMembers } from '@/lib/db/queries'
import { idSet, timezone, language, units } from '@/lib/env'
import { Shell } from '../shell'
import { SignIn } from '../sign-in'
import { Denied } from '../denied'
import { SetupWizard } from '../setup-wizard'

export const dynamic = 'force-dynamic'

/**
 * The first-run walkthrough: everything between "deployed" and "the family is
 * talking to it", in order. Home sends fresh admins here; it stays reachable
 * afterwards for reconnecting the webhook or adding people.
 */
export default async function SetupPage() {
  const session = await readSession()
  if (!session) return <SignIn />
  if (session.role !== 'admin') return <Denied />

  await hydrateSecrets()
  const [status, people] = await Promise.all([telegramStatus(), allowedMembers()])

  return (
    <Shell session={session} here="/setup">
      <SetupWizard
        status={status}
        members={people.map((m) => ({ name: m.name, telegramUserId: m.telegramUserId, isAdmin: m.isAdmin }))}
        seeded={[...idSet('ALLOWED_TELEGRAM_IDS')]}
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
