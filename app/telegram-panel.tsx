'use client'

import { useCallback, useEffect, useState } from 'react'
import type { TelegramStatus } from '@/lib/telegram-admin'

/**
 * The live half of the Telegram settings: what Telegram itself says about the
 * bot and its webhook, and the one action the rows above cannot express —
 * pointing that webhook at this deployment.
 */
export function TelegramPanel({ initial }: { initial?: TelegramStatus }) {
  const [status, setStatus] = useState<TelegramStatus | null>(initial ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/telegram')
      if (res.ok) setStatus((await res.json()) as TelegramStatus)
    } catch {
      // Leave whatever is shown; the connect button surfaces real failures.
    }
  }, [])

  useEffect(() => {
    if (!initial) refresh()
  }, [initial, refresh])

  async function connect() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ register: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not connect the webhook')
      setStatus(data as TelegramStatus)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null

  const hookNote = !status.configured
    ? 'set the bot token first'
    : status.connected
      ? status.webhook && status.webhook.pending > 0
        ? `delivering here, ${status.webhook.pending} pending`
        : 'delivering to this deployment'
      : status.webhook?.url
        ? `points at ${status.webhook.url}`
        : 'not registered'

  return (
    <div className="hook">
      <ul className="rows">
        <li className={status.ok ? '' : 'is-off'}>
          <span className={`dot ${status.ok ? 'on' : 'off'}`} />
          <span className="what">Bot</span>
          <span className="note">
            {status.configured ? (status.ok ? `@${status.username}` : (status.error ?? 'token rejected')) : 'no token'}
          </span>
        </li>
        <li className={status.connected ? '' : 'is-off'}>
          <span className={`dot ${status.connected ? 'on' : 'off'}`} />
          <span className="what">Webhook</span>
          <span className="note">{hookNote}</span>
        </li>
      </ul>
      {status.webhook?.lastError ? (
        <p className="empty warn">Telegram&rsquo;s last delivery error: {status.webhook.lastError}</p>
      ) : null}
      <div className="hook-acts">
        <button className="primary" disabled={busy || !status.configured || !status.ok} onClick={connect}>
          {status.connected ? 'Reconnect webhook' : 'Connect webhook'}
        </button>
        <button disabled={busy} onClick={refresh}>
          Check again
        </button>
      </div>
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}
