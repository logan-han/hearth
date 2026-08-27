import { requireAdmin } from '@/lib/auth/session'
import { hydrateSecrets } from '@/lib/settings'
import { gatherStats } from '@/lib/stats'
import { Shell } from '../shell'
import { Stat, Empty } from '../ui'
import { Denied } from '../denied'

export const dynamic = 'force-dynamic'

export default async function SystemPage() {
  const session = await requireAdmin()
  if (!session) return <Denied />

  await hydrateSecrets()
  const stats = await gatherStats()
  const t = stats.totals
  const muted = stats.chats.filter((c) => c.strangers > 0)

  return (
    <Shell session={session} here="/system" footnote={`Times are the household's, ${stats.timezone}.`}>
      <div className="strip">
        <Stat value={t.members} label="Family" note={`${t.admins} admin`} />
        <Stat value={t.connections} label="Mailboxes linked" />
        <Stat value={t.messages} label="Messages" />
        <Stat value={t.events} label="On the calendar" />
        <Stat value={t.memories} label="Remembered" />
        <Stat value={t.sent} label="Emails sent" note={t.drafts ? `${t.drafts} awaiting yes` : undefined} />
      </div>

      <section>
        <h2>Traffic, last fortnight</h2>
        <div className="panel">
          {stats.activity.every((d) => d.asked === 0 && d.answered === 0) ? (
            <Empty>No messages in the last fortnight.</Empty>
          ) : (
            <>
              <Spark data={stats.activity} />
              <p className="empty">Grey is what the family asked, ember is what the bot answered.</p>
            </>
          )}
        </div>
      </section>

      <div className="cols">
        <section>
          <h2>Answered by, last 30 days</h2>
          <div className="panel">
            {stats.models.length === 0 ? (
              <Empty>Nothing answered yet.</Empty>
            ) : (
              <>
                <ul className="listing">
                  {stats.models.map((m) => {
                    const total = stats.models.reduce((sum, x) => sum + x.count, 0)
                    const pct = Math.round((m.count / total) * 100)
                    return (
                      <li key={m.model}>
                        <span className="title mono">{m.model}</span>
                        <div className="share">
                          <span className="track">
                            <i style={{ width: `${pct}%` }} />
                          </span>
                          <span className="pct">{pct}%</span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
                <p className="empty" style={{ marginTop: '0.8rem' }}>
                  The chain&rsquo;s head carrying nearly everything is the healthy shape. Reorder it under
                  Settings.
                </p>
              </>
            )}
          </div>
        </section>

        <section>
          <h2>Where it talks</h2>
          <div className="panel">
            <ul className="listing">
              {stats.chats.map((c) => (
                <li key={c.id}>
                  <span className="title">
                    {c.type === 'private' ? (c.person ?? `Someone (${c.id})`) : (c.title ?? 'Unnamed group')}{' '}
                    <span className="tag none">{c.type === 'private' ? 'direct message' : c.type === 'channel' ? 'channel' : 'group chat'}</span>
                  </span>
                  <span className="meta">{c.messages} messages</span>
                  {c.strangers > 0 ? (
                    <span className="meta warn">
                      Quiet here: {c.strangers} {c.strangers === 1 ? 'person' : 'people'} unrecognised
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {muted.length === 0 ? null : (
              <p className="empty" style={{ marginTop: '0.8rem' }}>
                Add them under Settings, or remove them from the chat, and the bot starts answering again.
              </p>
            )}
          </div>
        </section>
      </div>
    </Shell>
  )
}

function Spark({ data }: { data: { day: string; asked: number; answered: number }[] }) {
  const peak = Math.max(...data.map((d) => Math.max(d.asked, d.answered)), 1)
  // A quiet day draws nothing. Giving zero a minimum height turned every empty
  // day into a stub that read as activity.
  const bar = (n: number) => (n === 0 ? undefined : { height: `${Math.max((n / peak) * 100, 3)}%` })

  return (
    <div className="spark" role="img" aria-label="Messages per day over the last fortnight">
      {data.map((d) => (
        <div key={d.day} className="spark-day" title={`${d.day}: ${d.asked} asked, ${d.answered} answered`}>
          {d.asked > 0 ? <i className="asked" style={bar(d.asked)} /> : <i className="blank" />}
          {d.answered > 0 ? <i className="answered" style={bar(d.answered)} /> : <i className="blank" />}
          <em>{d.day.slice(8)}</em>
        </div>
      ))}
    </div>
  )
}
