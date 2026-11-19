import { NextResponse } from 'next/server'
import { requireMember } from '@/lib/auth/session'
import { memberById } from '@/lib/db/queries'
import { checkAuthorise, consentToken, decide, describeClient } from '@/lib/oauth/server'
import { appUrl } from '@/lib/env'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Where an MCP client sends its member to be approved. Signed out, they sign
 * in first and come straight back; signed in as a family member, they are
 * shown who is asking and where it will send them, and say yes or no. A yes
 * sends the client a code it can trade, once, for a key in their name.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const checked = await checkAuthorise(url.searchParams)
  if ('page' in checked) return page('Hearth could not start that sign-in', `<p>${escapeHtml(checked.page)}</p>`, 400)

  const back = `${url.pathname}${url.search}`
  const session = await requireMember()
  const member = session?.memberId ? await memberById(session.memberId) : undefined
  if (!member) {
    const next = encodeURIComponent(back)
    const signedInAs = session ? `<p>You are signed in as ${escapeHtml(session.email)}, which is not a family member here, so it cannot approve a client.</p>` : ''
    return page(
      'Sign in to Hearth',
      `${signedInAs}<p>An MCP client wants to connect to Hearth as you. Sign in first, and you will come straight back here to say yes or no.</p>
<a class="btn" href="/api/oauth/google?signin=1&amp;next=${next}">Continue with Google</a>
<a class="btn" href="/api/oauth/microsoft?signin=1&amp;next=${next}">Continue with Microsoft</a>`,
    )
  }

  const { name, returnsTo } = describeClient(checked.ok)
  const token = await consentToken(checked.ok, member.id)
  return page(
    'Connect a client to Hearth',
    `<p><b>${escapeHtml(name)}</b> wants to act as <b>${escapeHtml(member.name)}</b> in Hearth: your mail and calendar, the family calendar and lists, what the household remembers, the money feed, Notion and the board, with your name on whatever it changes.</p>
<p>It will send you back to <b class="mono">${escapeHtml(returnsTo)}</b>. Say yes only if you started connecting this client yourself just now; anyone can ask under any name.</p>
<p>It gets a key of its own, listed on Home under Claude and other MCP clients, where you can revoke it at any time.</p>
<form method="post" action="/api/oauth/authorize">
<input type="hidden" name="consent" value="${escapeHtml(token)}">
<button class="primary" name="decision" value="allow">Allow</button>
<button name="decision" value="deny">No</button>
</form>`,
  )
}

/** The member's answer, from the page above. The token it carries says what was asked and for whom. */
export async function POST(req: Request) {
  const session = await requireMember()
  if (!session?.memberId) return page('Sign in to Hearth', '<p>Your session ended before you answered. Start connecting the client again.</p>', 401)
  const form = await req.formData().catch(() => null)
  const token = String(form?.get('consent') ?? '')
  const allow = form?.get('decision') === 'allow'
  const to = await decide(token, session.memberId, allow)
  if (!to) return page('That approval has run out', '<p>The page sat too long, or was not yours. Start connecting the client again.</p>', 400)
  // 303, so the client's address is fetched with GET whatever answered the form.
  return NextResponse.redirect(to, 303)
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:10vh auto;padding:0 1rem;color:#2b2b2b;background:#faf8f5}
h1{font-size:1.3rem}.mono{font-family:ui-monospace,monospace}
.btn,button{display:block;width:100%;box-sizing:border-box;margin:.5rem 0;padding:.7rem 1rem;border:1px solid #d8d2c8;border-radius:8px;background:#fff;color:inherit;font:inherit;text-decoration:none;text-align:left;cursor:pointer}
button.primary{background:#c2562b;border-color:#c2562b;color:#fff}
@media (prefers-color-scheme: dark){body{background:#1c1a17;color:#ece6dc}.btn,button{background:#26231f;border-color:#3a352e}}
</style>
<h1>🔥 ${escapeHtml(title)}</h1>${body}
<p style="margin-top:2rem;font-size:.85rem;opacity:.7"><a href="${escapeHtml(appUrl())}" style="color:inherit">Hearth</a></p>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The approval must not be framed by another site and clicked through.
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
      'cache-control': 'no-store',
    },
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
