import { requireAdmin } from '@/lib/auth/session'
import { hydrateSecrets, listSettings, SETTING_GROUPS, GROUP_NOTES } from '@/lib/settings'
import { allMembersWithLinks, calendarToken, FEED_EDGE_SECONDS } from '@/lib/db/queries'
import { appUrl } from '@/lib/env'
import { gatherStats } from '@/lib/stats'
import { Shell } from '../shell'
import { SettingsForm } from '../settings-form'
import { MembersForm } from '../members-form'
import { ChainForm } from '../chain-form'
import { Denied } from '../denied'
import { FeedAddress } from '../feed-address'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const session = await requireAdmin()
  if (!session) return <Denied />

  await hydrateSecrets()
  const [settings, members, stats, feedToken] = await Promise.all([
    listSettings(),
    allMembersWithLinks(),
    gatherStats(),
    calendarToken(),
  ])

  return (
    <Shell session={session} here="/settings">
      <MembersForm initial={members} />
      <section>
        <h2>Sign-ins</h2>
        <div className="panel">
          <p className="empty">
            For a session left open somewhere it should not be: ends every dashboard session, this
            one too, and voids every account link started but not finished. Linked accounts, MCP keys
            and stored settings are untouched; a key is revoked by its member on Home.
          </p>
          <form action="/api/admin/logout" method="post" style={{ marginTop: '0.8rem' }}>
            <input type="hidden" name="everywhere" value="1" />
            <button>Sign everyone out</button>
          </form>
        </div>
      </section>
      <FeedAddress initial={`${appUrl()}/api/calendar/${feedToken}/family.ics`} edgeHours={FEED_EDGE_SECONDS / 3600} />
      <ChainForm initial={stats.chain} shares={stats.models} />
      <SettingsForm initial={settings} groups={SETTING_GROUPS} notes={GROUP_NOTES} status={stats.connected} />
    </Shell>
  )
}
