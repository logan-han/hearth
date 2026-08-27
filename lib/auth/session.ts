import { cookies } from 'next/headers'
import { SignJWT, jwtVerify } from 'jose'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { members, connections } from '../db/schema'
import { required, idSet } from '../env'
import type { Member } from '../db/schema'

const COOKIE = 'hearth_session'
const ALG = 'HS256'
const TTL_HOURS = 12

export type Role = 'admin' | 'member'
export type Session = { email: string; name: string; provider: string; role: Role }

function secret(): Uint8Array {
  return new TextEncoder().encode(required('TOKEN_ENC_KEY'))
}

const same = (a: string | null | undefined, b: string) =>
  (a ?? '').trim().toLowerCase() === b

/**
 * What this address may see, or null if it may see nothing.
 *
 * `ADMIN_EMAILS` is the bootstrap. Beyond that an address is recognised if it
 * belongs to an allowed member, either because an admin recorded it or because
 * that member linked a mailbox with it. Admin members get the admin view.
 */
export async function resolveRole(email: string): Promise<{ role: Role; member: Member | null } | null> {
  const normalised = email.trim().toLowerCase()
  if (!normalised) return null

  const configured = new Set([...idSet('ADMIN_EMAILS')].map((e) => e.toLowerCase()))

  const people = await db().select().from(members).where(eq(members.allowed, true))
  const links = await db().select().from(connections)

  const match = people.find(
    (m) =>
      same(m.email, normalised) ||
      links.some((c) => c.memberId === m.id && same(c.email, normalised)),
  )

  if (configured.has(normalised)) return { role: 'admin', member: match ?? null }
  if (!match) return null
  return { role: match.isAdmin ? 'admin' : 'member', member: match }
}

export async function createSession(session: Session): Promise<void> {
  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${TTL_HOURS}h`)
    .sign(secret())

  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: TTL_HOURS * 3600,
  })
}

export async function readSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] })
    const { email, name, provider, role } = payload as Record<string, unknown>
    if (typeof email !== 'string') return null
    return {
      email,
      name: typeof name === 'string' ? name : email,
      provider: typeof provider === 'string' ? provider : 'unknown',
      // Anything other than an explicit admin claim is treated as a member.
      role: role === 'admin' ? 'admin' : 'member',
    }
  } catch {
    return null
  }
}

export async function requireAdmin(): Promise<Session | null> {
  const session = await readSession()
  return session?.role === 'admin' ? session : null
}

export async function destroySession(): Promise<void> {
  ;(await cookies()).delete(COOKIE)
}
