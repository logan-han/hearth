export function Denied() {
  return (
    <main className="signin">
      <div className="wordmark" style={{ fontSize: '1.4rem', marginBottom: '1rem' }}>
        <span className="flame">🔥</span> Hearth
      </div>
      <p className="lede">That page is for administrators.</p>
      <a className="btn" href="/">
        <span>Back to Home</span>
        <span aria-hidden>→</span>
      </a>
    </main>
  )
}
