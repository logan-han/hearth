import { requireMember } from '@/lib/auth/session'
import { calendarToken, connectionsFor, memberById } from '@/lib/db/queries'
import { appUrl } from '@/lib/env'
import { SignIn } from '../sign-in'
import { Denied } from '../denied'
import { AccountActions } from './account-actions'

export const dynamic = 'force-dynamic'

type Search = { linked?: string }

/**
 * Where a signed-in member links the accounts Hearth may read for them, makes
 * one read-only or unlinks it, and finds the family calendar's address. A
 * link acts for whoever is signed in, never for whoever a link was sent to.
 */
export default async function Connect({ searchParams }: { searchParams: Promise<Search> }) {
  const { linked } = await searchParams
  const session = await requireMember()
  if (!session) return <SignIn />
  // An address in ADMIN_EMAILS with no member behind it has nobody to link an account to.
  const member = session.memberId ? await memberById(session.memberId) : undefined
  if (!member) return <Denied message="Accounts are linked by family members, and this address is not one yet. An admin can add you in Settings." />

  const existing = await connectionsFor(member.id)
  const icsUrl = `${appUrl()}/api/calendar/${await calendarToken()}/family.ics`

  return (
    <main>
      <div className="mark">🔥</div>
      {linked ? <span className="badge">{linked} linked ✓</span> : null}
      <h1>Hello, {member.name}</h1>
      <p className="lede">
        Link the accounts Hearth may read on your behalf. Your MCP clients read your mail and calendar through
        them, and nobody else&rsquo;s client ever does.
      </p>

      <div className="card">
        <h2>Your accounts</h2>
        {(['google', 'microsoft'] as const).map((provider) => {
          const link = existing.find((c) => c.provider === provider)
          return (
            <div key={provider}>
              <a className="btn" href={`/api/oauth/${provider}`}>
                <span>{provider === 'google' ? 'Google' : 'Microsoft'}{link?.email ? ` · ${link.email}` : ''}</span>
                <span className="arrow">{link ? 'relink →' : 'link →'}</span>
              </a>
              {link ? <AccountActions provider={provider} readOnly={link.readOnly} /> : null}
            </div>
          )
        })}
        <p className="note">
          Google will warn that this app is unverified. It is a private family deployment, so that warning is
          expected: choose <em>Advanced → continue</em>. Read only means Hearth reads the account and never drafts,
          sends or adds events through it.
        </p>
      </div>

      <div className="card">
        <h2>Family calendar</h2>
        <code className="url">{icsUrl}</code>
        <p className="note">
          Subscribe by URL in Google Calendar (Other calendars → From URL), Apple Calendar, or Outlook. It
          refreshes on their schedule, which can take a few hours.
        </p>
      </div>

      <div className="card">
        <h2>Claude, and anything else that speaks MCP</h2>
        <code className="url">{`${appUrl()}/api/mcp`}</code>
        <p className="note">
          Hearth&rsquo;s own tools, over the Model Context Protocol: the family calendar and lists, what it
          remembers, and your mail and calendar. Make a key for each client on <a href="/">Home</a>, under Claude
          and other MCP clients, and revoke it there when you are done with it. A client that signs in with OAuth
          asks you to approve it instead.
        </p>
      </div>

      <footer>Refresh tokens are encrypted at rest. Hearth never sends email without your yes.</footer>
    </main>
  )
}
