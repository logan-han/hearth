'use client'

import { useEffect } from 'react'

/**
 * What a page shows when it throws, rather than a blank screen. A bad
 * setting is the usual cause, and /setup is the page least likely to be
 * broken by one, so that is where this points.
 */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="signin">
      <div className="wordmark" style={{ fontSize: '1.4rem', marginBottom: '1rem' }}>
        <span className="flame">🔥</span> Hearth
      </div>
      <p className="lede">
        This page could not be shown.{error.digest ? ` The server log has the details under ${error.digest}.` : ''} A
        setting changed just before is the usual cause, and the setup page can put it right.
      </p>
      <button type="button" className="btn" onClick={() => retry()}>
        <span>Try again</span>
        <span aria-hidden>↻</span>
      </button>
      <a className="btn" href="/setup">
        <span>Open setup</span>
        <span aria-hidden>→</span>
      </a>
    </main>
  )
}
