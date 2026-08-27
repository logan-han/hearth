import { verifyState } from '@/lib/oauth/state'
import { calendarToken, memberByTelegramId, connectionsFor } from '@/lib/db/queries'
import { appUrl } from '@/lib/env'

export const dynamic = 'force-dynamic'

type Search = { t?: string; linked?: string }

export default async function Connect({ searchParams }: { searchParams: Promise<Search> }) {
  const { t, linked } = await searchParams

  if (!t) {
    return (
      <main>
        <div className="mark">🔥</div>
        <h1>Connect an account</h1>
        <p className="lede">
          This page needs a personal link. Send <strong>/connect</strong> to Hearth on Telegram and
          it will DM you one.
        </p>
        {linked ? <span className="badge">{linked} linked ✓</span> : null}
      </main>
    )
  }

  let payload
  try {
    payload = await verifyState(t)
  } catch {
    return (
      <main>
        <div className="mark">🔥</div>
        <h1>That link has expired</h1>
        <p className="lede">Links last 30 minutes. Send /connect to the bot again for a fresh one.</p>
      </main>
    )
  }

  const member = await memberByTelegramId(payload.tg)
  const existing = member ? await connectionsFor(member.id) : []
  const linkedSet = new Set(existing.map((c) => c.provider))
  const icsUrl = `${appUrl()}/api/calendar/${await calendarToken()}/family.ics`

  return (
    <main>
      <div className="mark">🔥</div>
      {linked ? <span className="badge">{linked} linked ✓</span> : null}
      <h1>Hello, {payload.name}</h1>
      <p className="lede">
        Link the accounts Hearth may read on your behalf. You can unlink at any time by sending
        <strong> /unlink google</strong> or <strong>/unlink microsoft</strong> to the bot.
      </p>

      <div className="card">
        <h2>Your accounts</h2>
        <a className="btn" href={`/api/oauth/google?t=${encodeURIComponent(t)}`}>
          <span>Google</span>
          <span className="arrow">{linkedSet.has('google') ? 'relink →' : 'link →'}</span>
        </a>
        <a className="btn" href={`/api/oauth/microsoft?t=${encodeURIComponent(t)}`}>
          <span>Microsoft</span>
          <span className="arrow">{linkedSet.has('microsoft') ? 'relink →' : 'link →'}</span>
        </a>
        <p className="note">
          Google will warn that this app is unverified. It is a private family deployment, so that
          warning is expected: choose <em>Advanced → continue</em>.
        </p>
      </div>

      <div className="card">
        <h2>Family calendar</h2>
        <code className="url">{icsUrl}</code>
        <p className="note">
          Subscribe by URL in Google Calendar (Other calendars → From URL), Apple Calendar, or
          Outlook. It refreshes on their schedule, which can take a few hours.
        </p>
      </div>

      <footer>Refresh tokens are encrypted at rest. Hearth never sends email without your yes.</footer>
    </main>
  )
}
