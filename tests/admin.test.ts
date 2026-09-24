import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

const jar = vi.hoisted(() => {
  const store = new Map<string, string>()
  return {
    store,
    cookies: async () => ({
      get: (k: string) => (store.has(k) ? { value: store.get(k) } : undefined),
      set: (k: string, v: string) => void store.set(k, v),
      delete: (k: string) => void store.delete(k),
    }),
  }
})
vi.mock('next/headers', () => ({ cookies: jar.cookies }))

const {
  MANAGED_KEYS, isManaged, isSecretShaped, setSecret, clearSecret, listSettings,
  hydrateSecrets, resetHydration, recheckSecrets, readSecret,
} = await import('@/lib/settings')
const { createSession, readSession, destroySession, resolveRole, requireAdmin, requireMember } = await import('@/lib/auth/session')

let client: PGlite

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.ADMIN_EMAILS = 'rowan@hearth.example'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  // process.env outlives each test; a managed key left in it would read as
  // the deployment's environment and be seeded into the next fresh store.
  for (const key of MANAGED_KEYS) delete process.env[key]
  resetHydration()
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('the managed-key allowlist', () => {
  it('accepts only known settings', () => {
    expect(isManaged('TAVILY_API_KEY')).toBe(true)
    expect(isManaged('AMBIENT_MODE')).toBe(true)
    expect(isManaged('TELEGRAM_BOT_TOKEN')).toBe(true)
    expect(isManaged('TELEGRAM_WEBHOOK_SECRET')).toBe(true)
    expect(isManaged('ALLOWED_TELEGRAM_IDS')).toBe(true)
    expect(isManaged('LANGUAGE')).toBe(true)
    expect(isManaged('UNITS')).toBe(true)
  })

  it('refuses the settings that would let a session take over the deployment', () => {
    for (const dangerous of ['DATABASE_URL', 'TOKEN_ENC_KEY', 'ADMIN_EMAILS', 'APP_URL', 'GOOGLE_CLIENT_SECRET']) {
      expect(isManaged(dangerous)).toBe(false)
    }
  })

  it('classifies credentials as secret and plain settings as not', () => {
    expect(isSecretShaped('OPENROUTER_API_KEY')).toBe(true)
    expect(isSecretShaped('NOTION_TOKEN')).toBe(true)
    expect(isSecretShaped('TELEGRAM_BOT_TOKEN')).toBe(true)
    expect(isSecretShaped('TELEGRAM_WEBHOOK_SECRET')).toBe(true)
    expect(isSecretShaped('GEMINI_MODEL')).toBe(false)
    expect(isSecretShaped('AMBIENT_MODE')).toBe(false)
    expect(isSecretShaped('ALLOWED_TELEGRAM_IDS')).toBe(false)
  })

  it('never lets TOKEN_ENC_KEY be managed, since it decrypts the rest', () => {
    expect(MANAGED_KEYS).not.toContain('TOKEN_ENC_KEY' as never)
  })
})

describe('storing settings', () => {
  it('encrypts at rest and applies immediately', async () => {
    await setSecret('TAVILY_API_KEY', 'tvly-secret', 'rowan@hearth.example')
    expect(process.env.TAVILY_API_KEY).toBe('tvly-secret')

    const { db } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    const raw = await db().execute(sql`select value from secrets where key = 'TAVILY_API_KEY'`)
    expect(String((raw as unknown as { rows: { value: string }[] }).rows[0].value)).not.toContain('tvly-secret')
  })

  it('survives a cold start via hydration', async () => {
    await setSecret('NOTION_TOKEN', 'ntn_stored', 'rowan@hearth.example')
    delete process.env.NOTION_TOKEN
    resetHydration()
    await hydrateSecrets()
    expect(process.env.NOTION_TOKEN).toBe('ntn_stored')
  })

  it('owns a key once it holds a row, whatever the environment says', async () => {
    process.env.GEMINI_MODEL = 'from-env'
    await setSecret('GEMINI_MODEL', 'from-dashboard', 'rowan@hearth.example')
    resetHydration()
    await hydrateSecrets()
    expect(process.env.GEMINI_MODEL).toBe('from-dashboard')
  })

  it('seeds a key from the environment on first sight, then never reads the env var again', async () => {
    process.env.GEMINI_MODEL = 'from-env'
    await hydrateSecrets()
    const seeded = (await listSettings()).find((s) => s.key === 'GEMINI_MODEL')!
    expect(seeded.value).toBe('from-env')
    expect(seeded.origin).toBe('environment')

    // The operator changes the env var and redeploys: the store's value stays.
    process.env.GEMINI_MODEL = 'changed-in-env'
    resetHydration()
    await hydrateSecrets()
    expect(process.env.GEMINI_MODEL).toBe('from-env')
    expect(JSON.stringify(await listSettings())).not.toContain('changed-in-env')
  })

  it('removing a setting unsets it for good, even when the environment still has a value', async () => {
    process.env.GEMINI_MODEL = 'from-env'
    await setSecret('GEMINI_MODEL', 'x', 'rowan@hearth.example')
    await clearSecret('GEMINI_MODEL', 'rowan@hearth.example')
    expect(process.env.GEMINI_MODEL).toBeUndefined()

    // A cold start still carries the env var; the empty row keeps it out.
    process.env.GEMINI_MODEL = 'from-env'
    resetHydration()
    await hydrateSecrets()
    expect(process.env.GEMINI_MODEL).toBeUndefined()
    const shown = (await listSettings()).find((s) => s.key === 'GEMINI_MODEL')!
    expect(shown.set).toBe(false)
    expect(shown.origin).toBeNull()
  })

  it('reads one setting back for a script without seeding or applying anything', async () => {
    await setSecret('OPENROUTER_API_KEY', 'sk-or-stored', 'rowan@hearth.example')
    delete process.env.OPENROUTER_API_KEY
    expect(await readSecret('OPENROUTER_API_KEY')).toBe('sk-or-stored')
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined()

    // The script's own .env.local is not the deployment's: nothing is imported from it.
    process.env.GEMINI_API_KEY = 'from-env-local'
    expect(await readSecret('GEMINI_API_KEY')).toBeNull()
    const { db } = await import('@/lib/db')
    const { secrets } = await import('@/lib/db/schema')
    expect((await db().select().from(secrets)).map((r) => r.key)).toEqual(['OPENROUTER_API_KEY'])

    await clearSecret('OPENROUTER_API_KEY', 'rowan@hearth.example')
    expect(await readSecret('OPENROUTER_API_KEY')).toBeNull()
  })

  it('updating twice keeps one row and the newer value', async () => {
    await setSecret('TAVILY_API_KEY', 'first', 'a@b.com')
    await setSecret('TAVILY_API_KEY', 'second', 'c@d.com')
    const shown = (await listSettings()).find((s) => s.key === 'TAVILY_API_KEY')!
    expect(shown.updatedBy).toBe('c@d.com')
    expect(process.env.TAVILY_API_KEY).toBe('second')
  })
})

describe('listSettings', () => {
  it('never returns a credential value to the browser', async () => {
    await setSecret('OPENROUTER_API_KEY', 'sk-or-secret', 'rowan@hearth.example')
    const shown = (await listSettings()).find((s) => s.key === 'OPENROUTER_API_KEY')!
    expect(shown.set).toBe(true)
    expect(shown.value).toBeNull()
    expect(JSON.stringify(await listSettings())).not.toContain('sk-or-secret')
  })

  it('does return plain settings, which are useful to see', async () => {
    await setSecret('GEMINI_MODEL', 'gemini-3.5-flash-lite', 'rowan@hearth.example')
    const shown = (await listSettings()).find((s) => s.key === 'GEMINI_MODEL')!
    expect(shown.value).toBe('gemini-3.5-flash-lite')
  })

  it('says where each value came from', async () => {
    process.env.TAVILY_API_KEY = 'from-env'
    await setSecret('NOTION_TOKEN', 'from-dash', 'rowan@hearth.example')
    const all = await listSettings()
    const by = (k: string) => all.find((s) => s.key === k)!
    expect(by('NOTION_TOKEN').origin).toBe('dashboard')
    expect(by('TAVILY_API_KEY').origin).toBe('environment')
    expect(by('UP_API_TOKEN').origin).toBeNull()
  })

  it('lists every managed key, set or not', async () => {
    expect((await listSettings()).map((s) => s.key)).toEqual([...MANAGED_KEYS])
  })
})

describe('hydration is resilient', () => {
  it('reads the store on every hydrate, so a key saved on another instance applies at once and shows as set', async () => {
    await hydrateSecrets()
    // Another instance stores a key: this one only sees the database row.
    const { db } = await import('@/lib/db')
    const { secrets } = await import('@/lib/db/schema')
    const { encrypt } = await import('@/lib/crypto')
    await db().insert(secrets).values({ key: 'TAVILY_API_KEY', value: await encrypt('fresh'), updatedBy: 'x' })
    delete process.env.TAVILY_API_KEY

    await hydrateSecrets()
    expect(process.env.TAVILY_API_KEY).toBe('fresh')
    const shown = (await listSettings()).find((s) => s.key === 'TAVILY_API_KEY')!
    expect(shown).toMatchObject({ set: true, origin: 'dashboard', updatedBy: 'x' })
  })

  it('shares one read between hydrates in flight, and reads again once they settle', async () => {
    const { __setDb } = await import('@/lib/db')
    let reads = 0
    __setDb({
      select: () => {
        reads++
        return { from: async () => [] }
      },
    })
    await Promise.all([hydrateSecrets(), hydrateSecrets(), listSettings()])
    expect(reads).toBe(1)
    await hydrateSecrets()
    expect(reads).toBe(2)
  })

  it('reads the store for a caller it would turn away at most once an hour', async () => {
    const { __setDb } = await import('@/lib/db')
    let reads = 0
    __setDb({
      select: () => {
        reads++
        return { from: async () => [] }
      },
    })
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
    // A fresh instance holds nothing yet, so its first look is not counted.
    expect(await recheckSecrets()).toBe(true)
    expect(await recheckSecrets()).toBe(true)
    clock.mockReturnValue(start + 59 * 60_000)
    expect(await recheckSecrets()).toBe(false)
    expect(reads).toBe(2)
    clock.mockReturnValue(start + 60 * 60_000)
    expect(await recheckSecrets()).toBe(true)
    expect(reads).toBe(3)
    clock.mockRestore()
  })

  it('shares a read under way with a caller it would turn away, and counts no read that failed', async () => {
    const { __setDb } = await import('@/lib/db')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let reads = 0
    let down = true
    __setDb({
      select: () => {
        reads++
        return {
          from: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            if (down) throw new Error('no database')
            return []
          },
        }
      },
    })
    // The database is down: each refusal still gets its look, as nothing was learnt.
    expect(await recheckSecrets()).toBe(true)
    expect(await recheckSecrets()).toBe(true)
    expect(reads).toBe(2)
    down = false
    // Callers arriving together share the one read.
    expect(await Promise.all([recheckSecrets(), recheckSecrets(), recheckSecrets()])).toEqual([true, true, true])
    expect(reads).toBe(3)
    // That was this instance's first read that worked; the next starts the hour.
    expect(await recheckSecrets()).toBe(true)
    expect(await recheckSecrets()).toBe(false)
    expect(reads).toBe(4)
  })

  it('skips a row it cannot decrypt and keeps the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await setSecret('GEMINI_MODEL', 'kept', 'rowan@hearth.example')
    const { db } = await import('@/lib/db')
    const { secrets } = await import('@/lib/db/schema')
    await db().insert(secrets).values({ key: 'TAVILY_API_KEY', value: 'not-really-encrypted', updatedBy: 'x' })
    delete process.env.TAVILY_API_KEY
    delete process.env.GEMINI_MODEL
    resetHydration()
    await hydrateSecrets()
    expect(process.env.TAVILY_API_KEY).toBeUndefined()
    expect(process.env.GEMINI_MODEL).toBe('kept')
  })

  it('falls back to the environment when the database is unreachable', async () => {
    const { __setDb } = await import('@/lib/db')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    __setDb({ select: () => { throw new Error('no database') } })
    resetHydration()
    await expect(hydrateSecrets()).resolves.toBeUndefined()
  })

  it('reads back the row another instance wrote while it was importing the same key, rather than its own', async () => {
    process.env.GEMINI_MODEL = 'from-env'
    const { db } = await import('@/lib/db')
    const { secrets } = await import('@/lib/db/schema')
    const crypto = await import('@/lib/crypto')
    const encrypt = crypto.encrypt
    const elsewhere = { key: 'GEMINI_MODEL', value: await encrypt('claimed-elsewhere'), updatedBy: 'other-instance' }
    // The other instance's row lands while this one is still encrypting its import.
    vi.spyOn(crypto, 'encrypt').mockImplementationOnce(async (plain: string) => {
      await db().insert(secrets).values(elsewhere)
      return encrypt(plain)
    })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await hydrateSecrets()
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('GEMINI_MODEL imported'))
    expect(process.env.GEMINI_MODEL).toBe('claimed-elsewhere')
    const shown = (await listSettings()).find((s) => s.key === 'GEMINI_MODEL')!
    expect(shown).toMatchObject({ set: true, origin: 'dashboard', updatedBy: 'other-instance' })
  })
})

describe('admin sessions', () => {
  it('round-trips a signed session through the cookie', async () => {
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
    expect(await readSession()).toEqual({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
  })

  it('has no session before signing in, and none after signing out', async () => {
    expect(await readSession()).toBeNull()
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
    await destroySession()
    expect(await readSession()).toBeNull()
  })

  it('rejects a cookie signed with another key', async () => {
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
    process.env.TOKEN_ENC_KEY = 'b'.repeat(64)
    expect(await readSession()).toBeNull()
  })

  it('rejects a forged cookie', async () => {
    jar.store.set('hearth_session', 'not.a.jwt')
    expect(await readSession()).toBeNull()
  })

  it('stores the cookie as httpOnly is expected by the browser, not readable here', async () => {
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
    expect(jar.store.get('hearth_session')?.split('.')).toHaveLength(3)
  })

  const signRaw = async (claims: Record<string, unknown>, key?: Uint8Array) => {
    const { SignJWT } = await import('jose')
    const { signingSecret } = await import('@/lib/auth/keys')
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(key ?? (await signingSecret('session')))
  }

  it('refuses a cookie signed with TOKEN_ENC_KEY itself, or with the key OAuth state is signed with', async () => {
    const { signingSecret } = await import('@/lib/auth/keys')
    const claims = { email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' }
    jar.store.set('hearth_session', await signRaw(claims, new TextEncoder().encode(process.env.TOKEN_ENC_KEY!)))
    expect(await readSession()).toBeNull()
    jar.store.set('hearth_session', await signRaw(claims, await signingSecret('oauth-state')))
    expect(await readSession()).toBeNull()
    jar.store.set('hearth_session', await signRaw(claims))
    expect(await readSession()).not.toBeNull()
  })

  it('ends every session when everyone is signed out, and leaves what is stored readable', async () => {
    const { signOutEverywhere } = await import('@/lib/auth/keys')
    await setSecret('TAVILY_API_KEY', 'tvly-secret', 'rowan@hearth.example')
    const m = await q.upsertMember('555', 'Linked', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'linked@hearth.example', refreshToken: 'r3fr3sh', scopes: null })
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })

    await signOutEverywhere()
    expect(await readSession()).toBeNull()
    expect(await q.decryptRefreshToken((await q.connectionFor(m.id, 'google'))!)).toBe('r3fr3sh')
    delete process.env.TAVILY_API_KEY
    resetHydration()
    await hydrateSecrets()
    expect(process.env.TAVILY_API_KEY).toBe('tvly-secret')

    // A fresh sign-in is signed under the new epoch, and holds.
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
    expect(await readSession()).not.toBeNull()
  })

  it('turns a made-up cookie away without reading the store', async () => {
    const { __setDb } = await import('@/lib/db')
    jar.store.set('hearth_session', await signRaw({ email: 'rowan@hearth.example', role: 'admin' }, new TextEncoder().encode('made up')))
    let reads = 0
    __setDb(new Proxy({}, { get: () => { reads++; throw new Error('the store was read') } }))
    expect(await readSession()).toBeNull()
    expect(reads).toBe(0)
  })

  it('refuses a token with no email claim', async () => {
    jar.store.set('hearth_session', await signRaw({ name: 'X', provider: 'google', role: 'admin' }))
    expect(await readSession()).toBeNull()
  })

  it('falls back to the email for the name, and calls the provider unknown, when the token lacks them', async () => {
    jar.store.set('hearth_session', await signRaw({ email: 'ada@hearth.example' }))
    expect(await readSession()).toEqual({ email: 'ada@hearth.example', name: 'ada@hearth.example', provider: 'unknown', role: 'member' })
  })
})

describe('what an address is allowed to see', () => {
  it('treats ADMIN_EMAILS as admin, case and space insensitively', async () => {
    expect((await resolveRole('rowan@hearth.example'))?.role).toBe('admin')
    expect((await resolveRole('  ROWAN@HEARTH.EXAMPLE '))?.role).toBe('admin')
  })

  it('recognises nobody else', async () => {
    expect(await resolveRole('someone@else.com')).toBeNull()
    expect(await resolveRole('')).toBeNull()
  })

  it('gives an ordinary member the member role, not admin', async () => {
    await q.saveMember({ telegramUserId: '222', name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
    expect((await resolveRole('ada@hearth.example'))?.role).toBe('member')
  })

  it('recognises an address an admin recorded, before any mailbox is linked', async () => {
    await q.saveMember({ telegramUserId: '444', name: 'Kid', email: 'kid@hearth.example', allowed: true, isAdmin: false })
    const resolved = await resolveRole('kid@hearth.example')
    expect(resolved?.role).toBe('member')
    expect(resolved?.member?.name).toBe('Kid')
  })

  it('recognises an address from a linked mailbox', async () => {
    const m = await q.upsertMember('555', 'Linked', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'linked@hearth.example', refreshToken: 'r', scopes: null })
    expect((await resolveRole('linked@hearth.example'))?.role).toBe('member')
  })

  it('gives an admin family member the admin role', async () => {
    await q.saveMember({ telegramUserId: '666', name: 'Boss', email: 'boss@hearth.example', allowed: true, isAdmin: true })
    expect((await resolveRole('boss@hearth.example'))?.role).toBe('admin')
  })

  it('refuses a member whose access was revoked', async () => {
    await q.saveMember({ telegramUserId: '333', name: 'Old', email: 'old@hearth.example', allowed: true, isAdmin: true })
    await q.saveMember({ telegramUserId: '333', name: 'Old', email: 'old@hearth.example', allowed: false, isAdmin: true })
    expect(await resolveRole('old@hearth.example')).toBeNull()
  })

  it('recognises nobody when nothing is configured and nobody is recorded', async () => {
    delete process.env.ADMIN_EMAILS
    expect(await resolveRole('rowan@hearth.example')).toBeNull()
  })
})

describe('requireAdmin', () => {
  it('lets an admin session through', async () => {
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
    expect(await requireAdmin()).not.toBeNull()
  })

  it('turns a member session away', async () => {
    await createSession({ email: 'ada@hearth.example', name: 'Ada', provider: 'google', role: 'member' })
    expect(await readSession()).not.toBeNull()
    expect(await requireAdmin()).toBeNull()
  })

  it('treats an unknown role claim as member, never as admin', async () => {
    const { SignJWT } = await import('jose')
    const { signingSecret } = await import('@/lib/auth/keys')
    const token = await new SignJWT({ email: 'x@y.com', name: 'X', provider: 'google', role: 'root' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(await signingSecret('session'))
    jar.store.set('hearth_session', token)
    expect((await readSession())?.role).toBe('member')
    expect(await requireAdmin()).toBeNull()
  })

  it('takes the role from the members table on every request, not from the cookie', async () => {
    const q = await import('@/lib/db/queries')
    await q.saveMember({ telegramUserId: '222', name: 'Mal', email: 'mal@hearth.example', allowed: true, isAdmin: true })
    await createSession({ email: 'mal@hearth.example', name: 'Mal', provider: 'google', role: 'admin' })
    expect(await requireAdmin()).not.toBeNull()

    // Demoted: the cookie still says admin, the table no longer does.
    await q.saveMember({ telegramUserId: '222', name: 'Mal', email: 'mal@hearth.example', allowed: true, isAdmin: false })
    expect((await readSession())?.role).toBe('admin')
    expect(await requireAdmin()).toBeNull()
    expect((await requireMember())?.role).toBe('member')

    // Revoked: nothing at all, for the rest of the cookie's twelve hours.
    await q.setMemberAllowed('222', false)
    expect(await requireMember()).toBeNull()
    expect(await requireAdmin()).toBeNull()
  })

  it('hands back the member behind the session, and nobody when signed out', async () => {
    expect(await requireMember()).toBeNull()
    await createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
    expect(await requireMember()).toMatchObject({ email: 'rowan@hearth.example', role: 'admin', memberId: null })
  })
})
