export function SignIn() {
  return (
    <main className="signin">
      <div className="wordmark" style={{ fontSize: '1.6rem', marginBottom: '1.75rem' }}>
        <span className="flame">🔥</span> Hearth
      </div>
      <a className="btn" href="/api/oauth/google?signin=1">
        <span>Continue with Google</span>
        <span aria-hidden>→</span>
      </a>
      <a className="btn" href="/api/oauth/microsoft?signin=1">
        <span>Continue with Microsoft</span>
        <span aria-hidden>→</span>
      </a>
    </main>
  )
}
