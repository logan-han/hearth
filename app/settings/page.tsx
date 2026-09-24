import { requireAdmin } from '@/lib/auth/session'
import { hydrateSecrets, listSettings, SETTING_GROUPS } from '@/lib/settings'
import { allMembersWithLinks } from '@/lib/db/queries'
import { gatherStats } from '@/lib/stats'
import { Shell } from '../shell'
import { SettingsForm } from '../settings-form'
import { MembersForm } from '../members-form'
import { ChainForm } from '../chain-form'
import { Denied } from '../denied'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const session = await requireAdmin()
  if (!session) return <Denied />

  await hydrateSecrets()
  const [settings, members, stats] = await Promise.all([
    listSettings(),
    allMembersWithLinks(),
    gatherStats(),
  ])

  return (
    <Shell session={session} here="/settings">
      <MembersForm initial={members} />
      <section>
        <h2>Sign-ins</h2>
        <div className="panel">
          <p className="empty">
            For a session left open somewhere it should not be: ends every dashboard session, this
            one too, and voids every /connect link not yet used. Linked accounts and stored keys are
            untouched.
          </p>
          <form action="/api/admin/logout" method="post" style={{ marginTop: '0.8rem' }}>
            <input type="hidden" name="everywhere" value="1" />
            <button>Sign everyone out</button>
          </form>
        </div>
      </section>
      <ChainForm initial={stats.chain} shares={stats.models} />
      <SettingsForm initial={settings} groups={SETTING_GROUPS} status={stats.connected} />
    </Shell>
  )
}
