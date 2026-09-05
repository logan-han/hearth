import { redirect } from 'next/navigation'
import { readSession } from '@/lib/auth/session'
import { hydrateSecrets } from '@/lib/settings'
import { gatherFamilyStats } from '@/lib/stats'
import { Shell } from './shell'
import { Calendar } from './calendar'
import { NextUp, Reminders, FamilyLists, Proposals } from './family-panels'
import { SignIn } from './sign-in'

export const dynamic = 'force-dynamic'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const session = await readSession()
  if (!session) return <SignIn />

  await hydrateSecrets()
  // A deployment with no bot token has not been set up yet; walk the admin
  // through it rather than presenting an empty house.
  if (session.role === 'admin' && !process.env.TELEGRAM_BOT_TOKEN) redirect('/setup')

  const { month } = await searchParams
  const stats = await gatherFamilyStats(month)

  return (
    <Shell
      session={session}
      here="/"
      footnote={`Times are the household's, ${stats.timezone}, wherever you are reading this.`}
    >
      {stats.proposals.length > 0 ? (
        <section>
          <h2>Waiting on a yes</h2>
          <Proposals proposals={stats.proposals} />
        </section>
      ) : null}

      <Calendar month={stats.calendar} />

      <div className="cols">
        <section>
          <h2>Next up</h2>
          <NextUp events={stats.upcoming} />
        </section>

        <section>
          <h2>Reminders</h2>
          <Reminders automations={stats.automations} />
        </section>

        <section>
          <h2>Lists</h2>
          <FamilyLists lists={stats.lists} />
        </section>
      </div>
    </Shell>
  )
}
