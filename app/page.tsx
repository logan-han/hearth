import { redirect } from 'next/navigation'
import { requireMember } from '@/lib/auth/session'
import { hydrateSecrets } from '@/lib/settings'
import { gatherFamilyStats } from '@/lib/stats'
import { Shell } from './shell'
import { Calendar } from './calendar'
import { NextUp, Reminders, FamilyLists, Proposals, Remembered, Lately, Goals, Drafts, Helpers, Reports } from './family-panels'
import { McpKeys } from './mcp-keys'
import { allowedMembers } from '@/lib/db/queries'
import { appUrl } from '@/lib/env'
import { SignIn } from './sign-in'

export const dynamic = 'force-dynamic'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const session = await requireMember()
  if (!session) return <SignIn />

  await hydrateSecrets()
  // A household with nobody in it has not been set up yet; walk the admin
  // through it rather than presenting an empty house.
  if (session.role === 'admin' && (await allowedMembers()).length === 0) redirect('/setup')

  const { month } = await searchParams
  const stats = await gatherFamilyStats(month, session.memberId)

  return (
    <Shell
      session={session}
      here="/"
      footnote={`Times are the household's, ${stats.timezone}, wherever you are reading this.`}
    >
      {stats.proposals.length > 0 || stats.drafts.length > 0 ? (
        <section>
          <h2>Waiting on a yes</h2>
          {stats.drafts.length > 0 ? <Drafts drafts={stats.drafts} /> : null}
          {stats.proposals.length > 0 ? <Proposals proposals={stats.proposals} /> : null}
        </section>
      ) : null}

      {stats.reports.length > 0 ? (
        <section>
          <h2>Reports</h2>
          <Reports reports={stats.reports} />
        </section>
      ) : null}

      <Calendar month={stats.calendar} />

      {stats.goals.length > 0 ? (
        <section>
          <h2>Goals</h2>
          <Goals goals={stats.goals} />
        </section>
      ) : null}

      <div className="cols">
        <section>
          <h2>Next up</h2>
          <NextUp events={stats.upcoming} />
        </section>

        <section>
          <h2>Reminders</h2>
          <Reminders automations={stats.automations} scheduler={stats.scheduler} />
        </section>

        <section>
          <h2>Lists</h2>
          <FamilyLists lists={stats.lists} />
        </section>
      </div>

      <section>
        <h2>Remembered</h2>
        <Remembered memories={stats.memories} questions={stats.questions} />
      </section>

      {stats.helpers.length > 0 ? (
        <section>
          <h2>Helpers</h2>
          <Helpers helpers={stats.helpers} />
        </section>
      ) : null}

      <section>
        <h2>Lately</h2>
        <Lately activity={stats.activity} />
      </section>

      <section>
        <h2>Claude and other MCP clients</h2>
        <McpKeys initial={stats.keys} endpoint={`${appUrl()}/api/mcp`} member={session.memberId !== null} />
      </section>
    </Shell>
  )
}
