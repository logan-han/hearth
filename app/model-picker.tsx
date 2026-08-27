'use client'

import { useEffect, useState } from 'react'

type Option = { id: string; label: string; free: boolean; note: string }

const PROVIDER_OF: Record<string, string> = {
  GEMINI_MODEL: 'gemini',
  OPENROUTER_MODEL: 'openrouter',
  LLM_MODEL: 'self-hosted',
}

export function providerFor(key: string): string | undefined {
  return PROVIDER_OF[key]
}

/**
 * Models are an ordered list, not a sentence, so this edits them as one: pick
 * from what the provider actually serves, and drag the order that decides who
 * is tried first. Only tool-capable models are offered.
 */
export function ModelPicker({
  settingKey,
  value,
  onSave,
  onCancel,
  busy,
}: {
  settingKey: string
  value: string
  onSave: (next: string) => void
  onCancel: () => void
  busy: boolean
}) {
  const provider = providerFor(settingKey)!
  const [chosen, setChosen] = useState<string[]>(
    value.split(',').map((s) => s.trim()).filter(Boolean),
  )
  const [options, setOptions] = useState<Option[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [tested, setTested] = useState<Record<string, { ok: boolean; reason: string } | 'testing'>>({})

  useEffect(() => {
    let live = true
    fetch(`/api/admin/models?provider=${provider}`)
      .then(async (r) => {
        const d = await r.json()
        if (!r.ok) throw new Error(d.error ?? 'Could not list models')
        return d.models as Option[]
      })
      .then((m) => live && setOptions(m))
      .catch((e) => live && setProblem(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [provider])

  const available = (options ?? []).filter((o) => !chosen.includes(o.id))
  const describe = (id: string) => options?.find((o) => o.id === id)

  const move = (i: number, by: number) => {
    const to = i + by
    if (to < 0 || to >= chosen.length) return
    const next = [...chosen]
    const [m] = next.splice(i, 1)
    next.splice(to, 0, m)
    setChosen(next)
  }

  return (
    <div className="picker">
      {chosen.length === 0 ? (
        <p className="empty">Nothing chosen. This provider will be skipped.</p>
      ) : (
        <ol className="picked">
          {chosen.map((id, i) => {
            const meta = describe(id)
            return (
              <li key={id}>
                <span className="rank">{i + 1}</span>
                <span className="picked-id mono">{id}</span>
                {meta ? <span className={`tag${meta.free ? ' saved' : ''}`}>{meta.note || 'paid'}</span> : null}
                {tested[id] && tested[id] !== 'testing' ? (
                  <span className={`probe ${(tested[id] as { ok: boolean }).ok ? 'good' : 'bad'}`}>
                    {(tested[id] as { reason: string }).reason}
                  </span>
                ) : null}
                <span className="picked-acts">
                  <button
                    disabled={tested[id] === 'testing'}
                    onClick={async () => {
                      setTested((t) => ({ ...t, [id]: 'testing' }))
                      const r = await fetch('/api/admin/models/test', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ provider, model: id }),
                      })
                      const d = await r.json()
                      setTested((t) => ({ ...t, [id]: { ok: Boolean(d.ok), reason: d.reason ?? d.error ?? '' } }))
                    }}
                  >
                    {tested[id] === 'testing' ? '…' : 'Test'}
                  </button>
                  <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Try earlier">↑</button>
                  <button disabled={i === chosen.length - 1} onClick={() => move(i, 1)} aria-label="Try later">↓</button>
                  <button onClick={() => setChosen(chosen.filter((c) => c !== id))} aria-label={`Remove ${id}`}>×</button>
                </span>
              </li>
            )
          })}
        </ol>
      )}

      {problem ? (
        <p className="flash bad">{problem}</p>
      ) : options === null ? (
        <p className="empty">Loading what this provider serves…</p>
      ) : (
        <select
          className="picker-add"
          value=""
          onChange={(e) => {
            if (e.target.value) setChosen([...chosen, e.target.value])
          }}
        >
          <option value="">Add a model…</option>
          {available.map((o) => (
            <option key={o.id} value={o.id}>
              {o.id}
              {o.note ? ` — ${o.note}` : ''}
            </option>
          ))}
        </select>
      )}

      <div className="picker-acts">
        <button className="primary" disabled={busy} onClick={() => onSave(chosen.join(','))}>
          Save
        </button>
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <span className="empty">Tried top to bottom. Every model must support tool calling.</span>
      </div>
    </div>
  )
}
