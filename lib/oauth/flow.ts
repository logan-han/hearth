import { NextResponse } from 'next/server'
import { authorizeUrl, exchangeCode, emailFromIdToken, type Provider } from './providers'
import { signState, verifyState } from './state'
import { upsertMember, saveConnection, connectionFor, recordMessage } from '../db/queries'
import { appUrl } from '../env'
import { send } from '../telegram'
import { createSession, resolveRole } from '../auth/session'

/**
 * Step 1: bounce to the provider. Two entry points share this: a family member
 * following their personal /connect link, and an admin signing in to the
 * dashboard. The admin path needs no prior token, because the gate is the
 * email check on the way back, not the way out.
 */
export async function startAuth(req: Request, provider: Provider): Promise<Response> {
  const url = new URL(req.url)

  if (url.searchParams.get('signin') === '1') {
    const state = await signState({ tg: '', name: '', chat: '', purpose: 'signin' }, '10m')
    return NextResponse.redirect(authorizeUrl(provider, state))
  }

  const token = url.searchParams.get('t')
  if (!token) return fail('Missing link token. Send /connect to the bot again.')

  let payload
  try {
    payload = await verifyState(token)
  } catch {
    return fail('That link has expired. Send /connect to the bot again.')
  }

  // Re-sign with a short TTL: the round-trip through the provider is quick.
  const state = await signState({ ...payload, purpose: 'link' }, '10m')
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
    return fail('That authorisation expired before it completed. Send /connect and try again.')
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
      return fail(
        `${email} is not recognised. Ask whoever runs this bot to add your address.`,
      )
    }

    // The consent screen already asked for the full mail/calendar scopes, so a
    // recognised member's sign-in doubles as the mailbox link — the family
    // cannot be expected to know the web button and /connect are different
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
    return NextResponse.redirect(appUrl())
  }

  if (!tokens.refresh_token) {
    // Google only re-issues a refresh token with prompt=consent; without one the
    // link would silently stop working in an hour, so refuse it.
    return fail(
      'No refresh token was returned. Remove Hearth from your account permissions and link again.',
    )
  }

  const member = await upsertMember(payload.tg, payload.name)
  await saveConnection({
    memberId: member.id,
    provider,
    email,
    refreshToken: tokens.refresh_token,
    scopes: tokens.scope ?? null,
  })

  // Confirm in Telegram so the member sees it without switching back, and
  // into that DM's history so their next reply has its context.
  const confirmation = `Your ${provider} account is linked. You can ask me about your email and calendar now.`
  send(payload.tg, confirmation)
    .then(() => recordMessage({ chatId: payload.tg, role: 'assistant', content: confirmation }))
    .catch(() => {})

  return NextResponse.redirect(`${appUrl()}/connect?linked=${provider}`)
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
