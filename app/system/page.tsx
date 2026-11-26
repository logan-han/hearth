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
        <Stat value={t.connections} label="Calendars linked" />
        <Stat value={t.keys} label="MCP keys" />
        <Stat value={t.events} label="On the calendar" />
        <Stat value={t.memories} label="Remembered" note="listed on Home" />
        <Stat
          value={pulse.minutesAgo === null ? 'never' : pulse.minutesAgo === 0 ? 'just now' : `${pulse.minutesAgo} min ago`}
          label="Last tick"
          note={
            pulse.stale
              ? (pulse.lastTick ? 'scheduler has gone quiet' : 'no tick recorded yet')
              : (pulse.grid ?? (pulse.everyMinutes ? `every ${pulse.everyMinutes} min` : undefined))
          }
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
                {health.calls} model calls in all, counting the checks behind each scheduled report, not just the
                runs themselves. A skip is what sends a call to the next slot down.
              </p>
            </>
          )}
        </div>
      </section>

      <section>
        <h2>Changes, last fortnight</h2>
        <div className="panel">
          {stats.activity.every((d) => d.mcp + d.web + d.scheduled === 0) ? (
            <Empty>Nothing changed in the last fortnight.</Empty>
          ) : (
            <>
              <Spark data={stats.activity} />
              <p className="empty">Grey is what members changed, through their MCP clients or on Home; ember is what their scheduled jobs changed.</p>
            </>
          )}
        </div>
      </section>

      <div className="cols">
        <section>
          <h2>Scheduled runs by, last 30 days</h2>
          <div className="panel">
            {stats.models.length === 0 ? (
              <Empty>No scheduled run yet.</Empty>
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
          <h2>MCP keys</h2>
          <div className="panel">
            {stats.keys.length === 0 ? (
              <Empty>No keys yet. Each member makes their own on Home.</Empty>
            ) : (
              <>
                <ul className="listing">
                  {stats.keys.map((k) => (
                    <li key={k.id}>
                      <span className="title">
                        {k.label} <span className="tag none">{k.member}</span>
                      </span>
                      <span className="meta">
                        made {k.created} · {k.lastUsed ? `last used ${k.lastUsed}` : 'not used yet'}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="empty" style={{ marginTop: '0.8rem' }}>
                  A key is revoked by its member on Home; removing or revoking the member revokes every key of theirs.
                </p>
              </>
            )}
          </div>
        </section>
      </div>

      <section>
        <h2>Reminders</h2>
        <div className="panel">
          {stats.automations.length === 0 ? (
            <Empty>None scheduled.</Empty>
          ) : (
            <>
              <ul className="listing">
                {stats.automations.map((a) => (
                  <li key={a.id}>
                    <span className="title">
                      {a.label} {a.owner ? <span className="tag none">{a.owner}</span> : null}
                      {a.enabled ? null : <span className="tag none">paused</span>}
                      {a.offGrid ? <span className="tag none">off the tick</span> : null}
                    </span>
                    <span className="meta mono">{a.cron}</span>
                    <span className="meta">
                      {!a.enabled ? 'will not run' : a.offGrid ? `due ${a.nextRun}, runs ${a.runsAt}` : `next ${a.nextRun}`}
                      {a.lastRun ? ` · last ran ${a.lastRun}` : ' · not run yet'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="empty" style={{ marginTop: '0.8rem' }}>
                Each member pauses, resumes or deletes their own on Home.
              </p>
            </>
          )}
        </div>
      </section>
    </Shell>
  )
}

function Spark({ data }: { data: { day: string; mcp: number; web: number; scheduled: number }[] }) {
  const peak = Math.max(...data.map((d) => Math.max(d.mcp + d.web, d.scheduled)), 1)
  // A quiet day draws nothing. Giving zero a minimum height turned every empty
  // day into a stub that read as activity.
  const bar = (n: number) => (n === 0 ? undefined : { height: `${Math.max((n / peak) * 100, 3)}%` })

  return (
    <div className="spark" role="img" aria-label="Changes per day over the last fortnight">
      {data.map((d) => {
        const asked = d.mcp + d.web
        return (
          <div key={d.day} className="spark-day" title={`${d.day}: ${d.mcp} through MCP, ${d.web} on Home, ${d.scheduled} scheduled`}>
            {asked > 0 ? <i className="asked" style={bar(asked)} /> : <i className="blank" />}
            {d.scheduled > 0 ? <i className="answered" style={bar(d.scheduled)} /> : <i className="blank" />}
            <em>{d.day.slice(8)}</em>
          </div>
        )
      })}
    </div>
  )
}
