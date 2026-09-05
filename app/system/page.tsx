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
  const pulse = stats.scheduler
  const health = stats.chainHealth
  // Every configured slot, in chain order, whether or not it has been used this week.
  const slotOrder = stats.chain.flatMap((tier) =>
    tier.models.map((m) => `${tier.name === 'self-hosted' ? 'local' : tier.name}:${m}`),
  )
  const healthRows = [
    ...slotOrder.map((slot) => health?.slots.find((s) => s.slot === slot) ?? { slot, answered: 0, failed: 0, reasons: [], medianMs: null }),
    ...(health?.slots.filter((s) => !slotOrder.includes(s.slot)) ?? []),
  ]

  return (
    <Shell session={session} here="/system" footnote={`Times are the household's, ${stats.timezone}.`}>
      <div className="strip">
        <Stat value={t.members} label="Family" note={`${t.admins} admin`} />
        <Stat value={t.connections} label="Mailboxes linked" />
        <Stat value={t.messages} label="Messages" />
        <Stat value={t.events} label="On the calendar" />
        <Stat value={t.memories} label="Remembered" />
        <Stat value={t.sent} label="Emails sent" note={t.drafts ? `${t.drafts} awaiting yes` : undefined} />
        <Stat
          value={pulse.minutesAgo === null ? 'never' : pulse.minutesAgo === 0 ? 'just now' : `${pulse.minutesAgo} min ago`}
          label="Last tick"
          note={pulse.stale ? (pulse.lastTick ? 'scheduler has gone quiet' : 'no tick recorded yet') : undefined}
        />
      </div>

      <section>
        <h2>Chain health, last 7 days</h2>
        <div className="panel">
          {!health || health.calls === 0 ? (
            <Empty>No model calls recorded yet. Each call lands here from now on: who answered, who was skipped and why.</Empty>
          ) : (
            <>
              <ul className="listing chain-health">
                {healthRows.map((s) => (
                  <li key={s.slot}>
                    <span className="title mono">{s.slot}</span>
                    <span className="meta">
                      {s.answered} answered
                      {s.medianMs !== null ? `, typically ${(s.medianMs / 1000).toFixed(1)} s` : ''}
                      {s.failed > 0 ? (
                        <span className="warn">
                          {' '}· skipped {s.failed} {s.failed === 1 ? 'time' : 'times'}: {s.reasons.map((r) => `${r.kind} ×${r.count}`).join(', ')}
                        </span>
                      ) : (
                        ' · never skipped'
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="empty" style={{ marginTop: '0.8rem' }}>
                {health.calls} model calls in all, counting the gate, the checks behind each watcher post and the
                reply judgement, not just chat replies. A skip is what sends a call to the next slot down.
                {health.claimRetries > 0
                  ? ` ${health.claimRetries} ${health.claimRetries === 1 ? 'reply was' : 'replies were'} sent back for reporting a change no tool had made.`
                  : ' No reply has had to be sent back for reporting a change no tool had made.'}
              </p>
            </>
          )}
        </div>
      </section>

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
