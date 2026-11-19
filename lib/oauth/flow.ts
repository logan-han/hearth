import { NextResponse } from 'next/server'
import { authorizeUrl, exchangeCode, emailFromIdToken, type Provider } from './providers'
import { signState, verifyState, safeNext } from './state'
import { saveConnection, connectionFor, memberById, allMembersWithLinks } from '../db/queries'
import { appUrl, idSet } from '../env'
import { createSession, resolveRole, requireMember } from '../auth/session'
import type { Member } from '../db/schema'

/**
 * Step 1: bounce to the provider. Two entry points share this: anyone signing
 * in to the dashboard, and a signed-in member linking a mailbox from Connect.
 * Sign-in needs no prior token, because the gate is the email check on the
 * way back, not the way out; a link is bound to the member whose session
 * asked for it.
 */
export async function startAuth(req: Request, provider: Provider): Promise<Response> {
  const url = new URL(req.url)

  if (url.searchParams.get('signin') === '1') {
    const next = safeNext(url.searchParams.get('next'))
    const state = await signState({ purpose: 'signin', ...(next ? { next } : {}) }, '10m')
    return NextResponse.redirect(authorizeUrl(provider, state, 'signin'))
  }

  // Linking acts for whoever is signed in, and only for a recognised member:
  // an address in ADMIN_EMAILS with no member row has nobody to link it to.
  const session = await requireMember()
  if (!session?.memberId) return NextResponse.redirect(`${appUrl()}/connect`)
  const state = await signState({ purpose: 'link', member: session.memberId }, '10m')
  return NextResponse.redirect(authorizeUrl(provider, state))
}

/** Step 2: exchange the code and store the encrypted refresh token. */
export async function completeAuth(req: Request, provider: Provider): Promise<Response> {
  const url = new URL(req.url)
  const error = url.searchParams.get('error')
  if (error) return fail(`${provider} returned an error: ${error}`)

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return fail('Missing code or state.')

  let payload
  try {
    payload = await verifyState(state)
  } catch {
    return fail('That sign-in expired before it completed. Start again from the Hearth dashboard.')
  }

  let tokens
  try {
    tokens = await exchangeCode(provider, code)
  } catch (err) {
    console.error('[oauth] code exchange failed:', err)
    return fail('Could not complete the link with the provider. Please try again.')
  }

  const email = emailFromIdToken(tokens.id_token)

  if (payload.purpose === 'signin') {
    if (!email) return fail(`${provider} did not tell us which account signed in.`)
    const resolved = await resolveRole(email)
    if (!resolved) {
      return fail(`${email} is not recognised. Ask whoever runs this Hearth to add your address.`)
    }

    // The consent screen already asked for the full mail and calendar scopes,
    // so a recognised member's sign-in doubles as the mailbox link: the family
    // cannot be expected to know signing in and linking are different
    // ceremonies. Fill a gap or refresh the same account, but never repoint an
    // existing link at a different address; and never let a failed save cost
    // the session, which is what this flow is actually for.
    if (resolved.member && tokens.refresh_token) {
      try {
        const existing = await connectionFor(resolved.member.id, provider)
        if (!existing || (existing.email ?? '').toLowerCase() === email.toLowerCase()) {
          await saveConnection({
            memberId: resolved.member.id,
            provider,
            email,
            refreshToken: tokens.refresh_token,
            scopes: tokens.scope ?? null,
          })
        }
      } catch (err) {
        console.error('[oauth] sign-in could not store the connection:', err)
      }
    }

    await createSession({
      email,
      name: resolved.member?.name ?? email,
      provider,
      role: resolved.role,
    })
    return NextResponse.redirect(`${appUrl()}${payload.next ?? ''}`)
  }

  // The link was asked for by a member's own session; one revoked since has lost it.
  const member = await memberById(payload.member)
  if (!member?.allowed) return fail('That link is no longer valid. Sign in to the Hearth dashboard and try again.')

  if (!tokens.refresh_token) {
    // Google only re-issues a refresh token with prompt=consent; without one the
    // link would silently stop working in an hour, so refuse it.
    return fail(
      'No refresh token was returned. Remove Hearth from your account permissions and link again.',
    )
  }

  // An account the household already knows as another member's is theirs
  // alone, so it is turned away: one member must never collect another's
  // mailbox, whatever account they happen to be signed in to in the browser.
  const owner = email ? await ownerOf(email, member.id) : undefined
  if (owner) {
    return fail(`${email} is ${owner.name}'s account in this household, so it cannot be linked to ${member.name} as well.`)
  }

  // An address in ADMIN_EMAILS is an admin's even before any row says so, and
  // whoever holds it is who the dashboard takes that admin's sign-in to be.
  if (email && adminsAddress(email, member)) {
    return fail(`${email} is an admin's address in this household, so it cannot be linked to ${member.name}.`)
  }

  await saveConnection({
    memberId: member.id,
    provider,
    email,
    refreshToken: tokens.refresh_token,
    scopes: tokens.scope ?? null,
  })

  return NextResponse.redirect(`${appUrl()}/connect?linked=${provider}`)
}

/** The other member an address belongs to, whether an admin recorded it or they linked a mailbox with it. */
async function ownerOf(email: string, memberId: number) {
  const same = (a: string | null) => (a ?? '').trim().toLowerCase() === email.trim().toLowerCase()
  return (await allMembersWithLinks()).find(
    (m) => m.id !== memberId && (same(m.email) || m.linked.some((l) => same(l.email))),
  )
}

/**
 * Whether an address is an ADMIN_EMAILS one this member may not link: only an
 * admin may, or the member an admin recorded it against. Anyone else holding
 * it would also be who the dashboard takes that admin's sign-in to be.
 */
function adminsAddress(email: string, linker: Member): boolean {
  const address = email.trim().toLowerCase()
  if (![...idSet('ADMIN_EMAILS')].some((e) => e.toLowerCase() === address)) return false
  return !linker.isAdmin && (linker.email ?? '').trim().toLowerCase() !== address
}

function fail(message: string): Response {
  // The person sees this page once and moves on; the log line is what turns
  // "auth is broken" reports into a diagnosis later.
  console.warn('[oauth] flow refused:', message)
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hearth</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#2b2b2b}h1{font-size:1.3rem}</style>
<h1>Couldn't link that account</h1><p>${escapeHtml(message)}</p>`
  return new Response(html, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
