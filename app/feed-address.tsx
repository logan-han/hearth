'use client'

import { useState } from 'react'

/**
 * The family calendar's subscription address, and the one way to replace it
 * when it has got out: everyone subscribed has to subscribe again with the
 * new one, so the button asks first.
 */
export function FeedAddress({ initial, edgeHours }: { initial: string; edgeHours: number }) {
  const [url, setUrl] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  async function replace() {
    if (!confirm('Replace the family calendar address? Everyone subscribed will have to subscribe again with the new one.')) return
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/admin/calendar', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not replace it.')
      setUrl(data.url)
      setNote({ text: `Replaced. The old address stops working now, though a copy cached at the edge can still be served for up to ${edgeHours} hour${edgeHours === 1 ? '' : 's'}.` })
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), bad: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h2>Family calendar address</h2>
      <div className="panel">
        <code className="url">{url}</code>
        <p className="empty" style={{ marginTop: '0.6rem' }}>
          Anyone with this address can read the family calendar. If it has got out, replace it and pass the new one on.
        </p>
        <div className="wizard-row">
          <button disabled={busy} onClick={replace}>
            Replace the address
          </button>
        </div>
        {note ? <p className={`flash${note.bad ? ' bad' : ''}`}>{note.text}</p> : null}
      </div>
    </section>
  )
}
