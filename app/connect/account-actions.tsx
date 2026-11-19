'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/** Read-only or unlink for one of the signed-in member's own linked accounts. */
export function AccountActions({ provider, readOnly }: { provider: 'google' | 'microsoft'; readOnly: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/family', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'That did not work.')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wizard-row">
      <label>
        <input
          type="checkbox"
          disabled={busy}
          checked={readOnly}
          onChange={(e) => act({ action: 'set_read_only', provider, readOnly: e.target.checked })}
        />{' '}
        read only
      </label>
      <button
        disabled={busy}
        onClick={() => confirm(`Unlink your ${provider === 'google' ? 'Google' : 'Microsoft'} account?`) && act({ action: 'unlink_account', provider })}
      >
        Unlink
      </button>
      {error ? <span className="flash bad">{error}</span> : null}
    </div>
  )
}
