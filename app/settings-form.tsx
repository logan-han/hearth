'use client'

import { useEffect, useState } from 'react'
import type { SettingView } from '@/lib/settings'
import { GROUP_NOTES } from '@/lib/settings'
import { ModelPicker, providerFor } from './model-picker'
import { TelegramPanel } from './telegram-panel'

export type GroupStatus = { group: string; items: { name: string; on: boolean; note: string }[] }

export function SettingsForm({
  initial,
  groups,
  status,
}: {
  initial: SettingView[]
  groups: readonly string[]
  /** Live integration state, shown under the group whose keys drive it. */
  status?: GroupStatus[]
}) {
  const [settings, setSettings] = useState(initial)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<{ text: string; bad?: boolean } | null>(null)
  const [health, setHealth] = useState<Record<string, { ok: boolean; error?: string }>>({})

  // A dot should mean "working", not merely "a key is present": each
  // configured integration is probed live once the page is up.
  useEffect(() => {
    fetch('/api/admin/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items?: { name: string; ok: boolean; error?: string }[] } | null) => {
        if (d?.items) setHealth(Object.fromEntries(d.items.map((i) => [i.name, { ok: i.ok, error: i.error }])))
      })
      .catch(() => {})
  }, [])

  async function save(key: string, value: string) {
    setBusy(true)
    setFlash(null)
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not save')
      setSettings(data.settings)
      setFlash({ text: value === '' ? 'Cleared. Back to the deployment value.' : 'Saved.' })
      setEditing(null)
      setDraft('')
    } catch (err) {
      setFlash({ text: err instanceof Error ? err.message : String(err), bad: true })
    } finally {
      setBusy(false)
    }
  }

  // LLM_ORDER is edited by the chain above, not as a row of text.
  const shown = settings.filter((s) => s.key !== 'LLM_ORDER')

  return (
    <>
      {groups.map((group) => {
        const rows = shown.filter((s) => s.group === group)
        if (rows.length === 0) return null
        return (
          <section key={group}>
            <h2>{group}</h2>
            <div className="panel">
              {GROUP_NOTES[group as keyof typeof GROUP_NOTES] ? (
                <p className="group-note">{GROUP_NOTES[group as keyof typeof GROUP_NOTES]}</p>
              ) : null}
              {rows.map((s) => (
                <div className="setting" key={s.key}>
                  <div>
                    <span className="name">{s.label}</span>
                    {s.source === 'dashboard' ? <span className="tag saved">saved here</span> : null}
                    <span className="env">{s.key}</span>
                    {s.help || s.link ? (
                      <span className="help">
                        {s.help}
                        {s.help && s.link ? ' ' : ''}
                        {s.link ? (
                          <a href={s.link.href} target="_blank" rel="noreferrer">
                            Get one at {s.link.text} →
                          </a>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                  <div className={providerFor(s.key) && editing === s.key ? 'full' : 'right'}>
                    {s.options ? (
                      <>
                        <select
                          className="picker-add inline"
                          aria-label={s.label}
                          disabled={busy}
                          value={s.value ?? s.options[0]}
                          onChange={(e) => save(s.key, e.target.value)}
                        >
                          {(s.value && !s.options.includes(s.value) ? [s.value, ...s.options] : s.options).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                        {s.source === 'dashboard' ? (
                          <button disabled={busy} onClick={() => save(s.key, '')}>
                            Clear
                          </button>
                        ) : null}
                      </>
                    ) : s.toggle ? (
                      <>
                        <span className={`val${s.set ? '' : ' unset'}`}>
                          {(s.value ?? '').toLowerCase() === 'on' ? 'on' : 'off'}
                        </span>
                        <button
                          role="switch"
                          aria-checked={(s.value ?? '').toLowerCase() === 'on'}
                          aria-label={s.label}
                          className={`switch${(s.value ?? '').toLowerCase() === 'on' ? ' on' : ''}`}
                          disabled={busy}
                          onClick={() => save(s.key, (s.value ?? '').toLowerCase() === 'on' ? 'off' : 'on')}
                        >
                          <i />
                        </button>
                        {s.source === 'dashboard' ? (
                          <button disabled={busy} onClick={() => save(s.key, '')}>
                            Clear
                          </button>
                        ) : null}
                      </>
                    ) : editing === s.key && providerFor(s.key) ? (
                      <ModelPicker
                        settingKey={s.key}
                        value={s.value ?? ''}
                        busy={busy}
                        onSave={(next) => save(s.key, next)}
                        onCancel={() => setEditing(null)}
                      />
                    ) : editing === s.key ? (
                      <>
                        <input
                          autoFocus
                          type={s.secret ? 'password' : 'text'}
                          value={draft}
                          placeholder={s.secret ? 'paste the new value' : 'value'}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') save(s.key, draft)
                            if (e.key === 'Escape') setEditing(null)
                          }}
                        />
                        <button className="primary" disabled={busy} onClick={() => save(s.key, draft)}>
                          Save
                        </button>
                        <button disabled={busy} onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span className={`val${s.set ? '' : ' unset'}`}>
                          {s.secret ? (s.set ? '••••••••' : 'not set') : s.value || 'not set'}
                        </span>
                        <button
                          onClick={() => {
                            setEditing(s.key)
                            setDraft(s.secret ? '' : (s.value ?? ''))
                          }}
                        >
                          {s.set ? 'Change' : 'Set'}
                        </button>
                        {s.source === 'dashboard' ? (
                          <button disabled={busy} onClick={() => save(s.key, '')}>
                            Clear
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              ))}
              {(() => {
                const live = status?.find((s) => s.group === group)
                if (!live) return null
                return (
                  <div className="hook">
                    <ul className="rows">
                      {live.items.map((i) => {
                        const probe = health[i.name]
                        const failing = i.on && probe?.ok === false
                        return (
                          <li key={i.name} className={i.on && !failing ? '' : 'is-off'}>
                            <span className={`dot ${failing ? 'bad' : i.on ? 'on' : 'off'}`} />
                            <span className="what">{i.name}</span>
                            <span className={`note${failing ? ' warn' : ''}`}>
                              {failing ? (probe?.error ?? 'not answering') : i.on ? i.note : 'off'}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )
              })()}
              {group === 'Telegram' ? <TelegramPanel /> : null}
            </div>
          </section>
        )
      })}
      {flash ? <p className={`flash${flash.bad ? ' bad' : ''}`}>{flash.text}</p> : null}
      <p className="empty">
        Anything saved here is encrypted and takes effect straight away, without a redeploy. Keys are
        never shown back to this page. Clearing one falls back to the deployment&rsquo;s own value.
      </p>
    </>
  )
}
