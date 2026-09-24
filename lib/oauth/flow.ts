import { NextResponse } from 'next/server'
import { authorizeUrl, exchangeCode, emailFromIdToken, type Provider } from './providers'
import { signState, verifyState } from './state'
import { upsertMember, saveConnection, connectionFor, recordMessage, memberByTelegramId, allMembersWithLinks, allowedMembers } from '../db/queries'
import { appUrl, idSet } from '../env'
import { send } from '../telegram'
import { createSession, resolveRole } from '../auth/session'
import { hydrateSecrets } from '../settings'

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
    return NextResponse.redirect(authorizeUrl(provider, state, 'signin'))
  }

  const token = url.searchParams.get('t')
  if (!token) return fail('Missing link token. Send /connect to the bot again.')

  let payload
  try {
    payload = await verifyState(token, 'link')
  } catch {
    return fail('That link has expired. Send /connect to the bot again.')
  }
  // The link was DMed to an allowed member; one revoked since has lost it.
  if (!(await memberByTelegramId(payload.tg))?.allowed) {
    return fail('That link is no longer valid. Send /connect to the bot again.')
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

  // Every outcome from here is told to someone in Telegram, and the bot's
  // token may live only in the dashboard's store: an instance that has not
  // read it has no token to send with, and one that read it earlier may hold
  // one replaced since.
  await hydrateSecrets()

  // A link acts for whoever it was sent to, not whoever opens it: forwarded to
  // someone else, it would store their mailbox under the sender. An account
  // the household already knows as another member's is theirs alone, so it is
  // turned away and they are told, in case the "relink" was not their idea.
  const owner = email ? await ownerOf(email, payload.tg) : undefined
  if (owner) {
    await send(
      owner.telegramUserId,
      `Your ${provider} account (${email}) was just offered to Hearth through ${payload.name}'s /connect link, and turned ` +
        `away because it is yours; nothing changed. If you were asked to open a link to relink, that link was ${payload.name}'s, not yours.`,
    ).catch((err) => console.error('[oauth] could not tell the owner of a refused link:', err))
    return fail(`${email} is ${owner.name}'s account in this household, so it cannot be linked to ${payload.name} as well.`)
  }

  // An address in ADMIN_EMAILS is an admin's even before any row says so: a
  // founder who came in through ALLOWED_TELEGRAM_IDS and has only signed in to
  // the dashboard has no address on record and no link for ownerOf to find.
  // Whose it is cannot be told, so every admin hears it was turned away.
  if (email && (await adminsAddress(email, payload.tg))) {
    const admins = (await allowedMembers().catch(() => [])).filter((m) => m.isAdmin)
    for (const admin of admins) {
      await send(
        admin.telegramUserId,
        `An admin's ${provider} account (${email}, in ADMIN_EMAILS) was just offered to Hearth through ${payload.name}'s /connect ` +
          `link, and turned away; nothing changed. If it is yours and you were asked to open a link to relink, that link was ${payload.name}'s, not yours.`,
      ).catch((err) => console.error('[oauth] could not tell an admin of a refused link:', err))
    }
    return fail(`${email} is an admin's address in this household, so it cannot be linked to ${payload.name}.`)
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

/** The other member an address belongs to, whether an admin recorded it or they linked a mailbox with it. */
async function ownerOf(email: string, telegramUserId: string) {
  const same = (a: string | null) => (a ?? '').trim().toLowerCase() === email.trim().toLowerCase()
  return (await allMembersWithLinks()).find(
    (m) => m.telegramUserId !== telegramUserId && (same(m.email) || m.linked.some((l) => same(l.email))),
  )
}

/**
 * Whether an address is an ADMIN_EMAILS one this member may not link: only an
 * admin may, or the member an admin recorded it against. Anyone else holding
 * it would also be who the dashboard takes that admin's sign-in to be.
 */
async function adminsAddress(email: string, telegramUserId: string): Promise<boolean> {
  const address = email.trim().toLowerCase()
  if (![...idSet('ADMIN_EMAILS')].some((e) => e.toLowerCase() === address)) return false
  const linker = await memberByTelegramId(telegramUserId)
  return !linker?.isAdmin && (linker?.email ?? '').trim().toLowerCase() !== address
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
