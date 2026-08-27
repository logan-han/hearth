import type { Session } from '@/lib/auth/session'

const TABS = [
  { href: '/', label: 'Home', adminOnly: false },
  { href: '/system', label: 'System', adminOnly: true },
  { href: '/settings', label: 'Settings', adminOnly: true },
]

export function Shell({
  session, here, children, footnote,
}: {
  session: Session
  here: string
  children: React.ReactNode
  footnote?: string
}) {
  const tabs = TABS.filter((t) => !t.adminOnly || session.role === 'admin')

  return (
    <>
      <div className="topbar">
        <div className="topbar-inner">
          <a className="wordmark" href="/">
            <span className="flame">🔥</span> Hearth
          </a>
          {/* A lone Home pill is nothing to navigate; the wordmark already links there. */}
          {tabs.length > 1 ? (
            <nav className="tabs">
              {tabs.map((t) => (
                <a key={t.href} href={t.href} className={t.href === here ? 'on' : ''}>
                  {t.label}
                </a>
              ))}
            </nav>
          ) : null}
          <div className="whoami">
            <span className="hide-small">{session.name}</span>
            <form action="/api/admin/logout" method="post">
              <button>Sign out</button>
            </form>
          </div>
        </div>
      </div>
      <main>
        {children}
        {footnote ? <footer>{footnote}</footer> : null}
      </main>
    </>
  )
}
