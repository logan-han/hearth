'use client'

import { useState } from 'react'

type Tier = { name: string; label: string; models: string[]; configured: boolean }

const UNCONFIGURED: Record<string, string> = {
  'self-hosted': 'not set up · an OpenAI-compatible server you run yourself',
  gemini: 'no key set · Google AI Studio',
  openrouter: 'no key set · openrouter.ai',
}
type Share = { model: string; count: number }

/**
 * The fallback chain, which is this app's defining mechanic: try, fall through,
 * try again. Numbering is real here because the order genuinely decides who
 * answers first, so the thing you read is also the thing you edit.
 */
export function ChainForm({ initial, shares }: { initial: Tier[]; shares: Share[] }) {
  const [tiers, setTiers] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  // gatherStats already excludes replies from before model tracking.
  const attributed = shares
  const answered = attributed.reduce((s, m) => s + m.count, 0)
  const shareOf = (tier: Tier) =>
    attributed.filter((s) => s.model.startsWith(`${tierPrefix(tier.name)}:`)).reduce((s, m) => s + m.count, 0)
  // Within a tier the slots are tried in order too, so each model shows its own count:
  // a tail that has never answered reads 0, and one that answers often is a head that keeps failing.
  const countOf = (tier: Tier, model: string) =>
    attributed.find((s) => s.model === `${tierPrefix(tier.name)}:${model}`)?.count ?? 0

  async function move(from: number, to: number) {
    if (to < 0 || to >= tiers.length) return
    const next = [...tiers]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setTiers(next)

    setBusy(true)
    setFlash(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'LLM_ORDER', value: next.map((t) => t.name).join(',') }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not save')
      setFlash(`${moved.label} now answers ${ordinal(to + 1)}.`)
    } catch (err) {
      setTiers(tiers)
      setFlash(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2>Who answers</h2>
      <div className="panel">
        {flash ? <p className="flash">{flash}</p> : null}
        <ol className="chain">
          {tiers.map((tier, i) => {
            const count = shareOf(tier)
            const pct = answered ? Math.round((count / answered) * 100) : 0
            return (
              <li key={tier.name} className={tier.configured ? '' : 'idle'}>
                <span className="rank">{i + 1}</span>
                <div>
                  <span className="tier-name">{tier.label}</span>
                  <span className="tier-models">
                    {!tier.configured
                      ? (UNCONFIGURED[tier.name] ?? 'not set up')
                      : tier.models.map((m, j) => (
                          <span key={m} className="tier-model">
                            {j > 0 ? <span className="sep"> · </span> : null}
                            {m}
                            {answered > 0 ? (
                              <em title={`${countOf(tier, m)} of ${answered} replies in the last 30 days`}>
                                {' '}
                                {countOf(tier, m)}
                              </em>
                            ) : null}
                          </span>
                        ))}
                  </span>
                  {tier.configured && answered > 0 ? (
                    <div className="share">
                      <span className="track">
                        <i style={{ width: `${pct}%` }} />
                      </span>
                      <span className="pct">{pct}%</span>
                    </div>
                  ) : null}
                </div>
                <span className="move">
                  <button disabled={busy || i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${tier.label} earlier`}>
                    ↑
                  </button>
                  <button
                    disabled={busy || i === tiers.length - 1}
                    onClick={() => move(i, i + 1)}
                    aria-label={`Move ${tier.label} later`}
                  >
                    ↓
                  </button>
                </span>
              </li>
            )
          })}
        </ol>
        <p className="empty" style={{ marginTop: '0.9rem' }}>
          The first one that works answers.{' '}
          {answered > 0
            ? `Percentages and the count beside each model are the last 30 days (${answered} replies), so the top of the list carrying almost everything is the healthy shape.`
            : 'Once replies start being recorded, each row will show the share it carried.'}
        </p>
      </div>
    </section>
  )
}

function tierPrefix(name: string): string {
  return name === 'self-hosted' ? 'local' : name
}

function ordinal(n: number): string {
  return ['first', 'second', 'third', 'fourth'][n - 1] ?? `${n}th`
}
