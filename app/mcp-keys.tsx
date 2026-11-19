'use client'

import { useState } from 'react'
import { Empty } from './ui'

type Key = { id: number; label: string; created: string; lastUsed: string | null }

/**
 * The signed-in member's keys for MCP clients: make one per client, see when
 * each was last used, and revoke one without touching the others. A key is
 * shown once, as it is made, with the line that adds it to Claude Code; only
 * its digest is kept, so a lost one is revoked and replaced, never looked up.
 */
export function McpKeys({ initial, endpoint, member }: { initial: Key[]; endpoint: string; member: boolean }) {
  const [keys, setKeys] = useState(initial)
  const [label, setLabel] = useState('')
  const [made, setMade] = useState<{ key: string; connect: string; label: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function call(method: 'POST' | 'DELETE', url: string, body?: unknown) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'That did not work.')
      setKeys(data.keys as Key[])
      return data
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setBusy(false)
    }
  }

  async function make() {
    const data = await call('POST', '/api/mcp-keys', { label: label.trim() })
    if (!data) return
    setMade({ key: data.key, connect: data.connect, label: label.trim() })
    setLabel('')
    setCopied(false)
  }

  async function revoke(k: Key) {
    if (!confirm(`Revoke "${k.label}"? Anything using it stops working at once.`)) return
    if (await call('DELETE', `/api/mcp-keys?id=${k.id}`)) setMade(null)
  }

  if (!member) {
    return (
      <div className="panel">
        <Empty>A key acts as a family member, and this address is not one yet. Add yourself to the family in Settings.</Empty>
      </div>
    )
  }

  return (
    <div className="panel">
      <p className="group-note">
        Hearth&rsquo;s tools for Claude Code, Claude Desktop or any client that speaks MCP, at{' '}
        <span className="mono">{endpoint}</span>. A key acts as you: your mail, your calendar, your name on what it changes. Make
        one per client, so each can be revoked on its own. Clients that sign in with OAuth need no key; they ask you here to
        approve them, and appear in this list once you do.
      </p>
      {made ? (
        <div className="key-made">
          <p className="subhead">Your new key for {made.label}, shown this once</p>
          <code className="url">{made.key}</code>
          <p className="meta">Add it to Claude Code with:</p>
          <code className="url">{made.connect}</code>
          <div className="wizard-row">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(made.connect).then(() => setCopied(true), () => setCopied(false))
              }}
            >
              {copied ? 'Copied' : 'Copy the line'}
            </button>
            <button onClick={() => setMade(null)}>Done, hide it</button>
          </div>
        </div>
      ) : null}
      {keys.length === 0 ? (
        <Empty>No keys yet.</Empty>
      ) : (
        <ul className="listing doable">
          {keys.map((k) => (
            <li key={k.id}>
              <span className="grow">
                <span className="title">{k.label}</span>
                <span className="meta">
                  made {k.created} · {k.lastUsed ? `last used ${k.lastUsed}` : 'not used yet'}
                </span>
              </span>
              <span className="row-acts">
                <button disabled={busy} title={`Revoke ${k.label}`} onClick={() => revoke(k)}>
                  Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="wizard-row">
        <input
          placeholder="Which client, e.g. Claude Code on the laptop"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && label.trim() && !busy && make()}
        />
        <button className="primary" disabled={busy || !label.trim()} onClick={make}>
          Make a key
        </button>
      </div>
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}
