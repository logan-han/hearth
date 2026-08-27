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
  hydrateSecrets, resetHydration,
} = await import('@/lib/settings')
const { createSession, readSession, destroySession, resolveRole, requireAdmin } = await import('@/lib/auth/session')

let client: PGlite

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.ADMIN_EMAILS = 'logan@han.life'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
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
    await setSecret('TAVILY_API_KEY', 'tvly-secret', 'logan@han.life')
    expect(process.env.TAVILY_API_KEY).toBe('tvly-secret')

    const { db } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    const raw = await db().execute(sql`select value from secrets where key = 'TAVILY_API_KEY'`)
    expect(String((raw as unknown as { rows: { value: string }[] }).rows[0].value)).not.toContain('tvly-secret')
  })

  it('survives a cold start via hydration', async () => {
    await setSecret('NOTION_TOKEN', 'ntn_stored', 'logan@han.life')
    delete process.env.NOTION_TOKEN
    resetHydration()
    await hydrateSecrets()
    expect(process.env.NOTION_TOKEN).toBe('ntn_stored')
  })

  it('overrides the deployment environment, being the later intent', async () => {
    process.env.GEMINI_MODEL = 'from-env'
    await setSecret('GEMINI_MODEL', 'from-dashboard', 'logan@han.life')
    resetHydration()
    await hydrateSecrets()
    expect(process.env.GEMINI_MODEL).toBe('from-dashboard')
  })

  it('clearing removes the override', async () => {
    await setSecret('GEMINI_MODEL', 'x', 'logan@han.life')
    await clearSecret('GEMINI_MODEL')
    expect(process.env.GEMINI_MODEL).toBeUndefined()
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
    await setSecret('OPENROUTER_API_KEY', 'sk-or-secret', 'logan@han.life')
    const shown = (await listSettings()).find((s) => s.key === 'OPENROUTER_API_KEY')!
    expect(shown.set).toBe(true)
    expect(shown.value).toBeNull()
    expect(JSON.stringify(await listSettings())).not.toContain('sk-or-secret')
  })

  it('does return plain settings, which are useful to see', async () => {
    await setSecret('GEMINI_MODEL', 'gemini-3.5-flash-lite', 'logan@han.life')
    const shown = (await listSettings()).find((s) => s.key === 'GEMINI_MODEL')!
    expect(shown.value).toBe('gemini-3.5-flash-lite')
  })

  it('says where each value came from', async () => {
    process.env.TAVILY_API_KEY = 'from-env'
    delete process.env.UP_API_TOKEN
    await setSecret('NOTION_TOKEN', 'from-dash', 'logan@han.life')
    const all = await listSettings()
    const by = (k: string) => all.find((s) => s.key === k)!
    expect(by('NOTION_TOKEN').source).toBe('dashboard')
    expect(by('TAVILY_API_KEY').source).toBe('environment')
    expect(by('UP_API_TOKEN').source).toBe('unset')
  })

  it('lists every managed key, set or not', async () => {
    expect((await listSettings()).map((s) => s.key)).toEqual([...MANAGED_KEYS])
  })
})

describe('hydration is resilient', () => {
  it('re-reads the store once its memo goes stale, so warm instances catch up', async () => {
    vi.useFakeTimers()
    try {
      await hydrateSecrets()
      // Another instance stores a key: this one only sees the database row.
      const { db } = await import('@/lib/db')
      const { secrets } = await import('@/lib/db/schema')
      const { encrypt } = await import('@/lib/crypto')
      await db().insert(secrets).values({ key: 'TAVILY_API_KEY', value: await encrypt('fresh'), updatedBy: 'x' })
      delete process.env.TAVILY_API_KEY

      await hydrateSecrets()
      expect(process.env.TAVILY_API_KEY).toBeUndefined() // memo still warm

      vi.advanceTimersByTime(61_000)
      await hydrateSecrets()
      expect(process.env.TAVILY_API_KEY).toBe('fresh')
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips a row it cannot decrypt and keeps the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await setSecret('GEMINI_MODEL', 'kept', 'logan@han.life')
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
})

describe('admin sessions', () => {
  it('round-trips a signed session through the cookie', async () => {
    await createSession({ email: 'logan@han.life', name: 'Logan', provider: 'google', role: 'admin' })
    expect(await readSession()).toEqual({ email: 'logan@han.life', name: 'Logan', provider: 'google', role: 'admin' })
  })

  it('has no session before signing in, and none after signing out', async () => {
    expect(await readSession()).toBeNull()
    await createSession({ email: 'logan@han.life', name: 'Logan', provider: 'google', role: 'admin' })
    await destroySession()
    expect(await readSession()).toBeNull()
  })

  it('rejects a cookie signed with another key', async () => {
    await createSession({ email: 'logan@han.life', name: 'Logan', provider: 'google', role: 'admin' })
    process.env.TOKEN_ENC_KEY = 'b'.repeat(64)
    expect(await readSession()).toBeNull()
  })

  it('rejects a forged cookie', async () => {
    jar.store.set('hearth_session', 'not.a.jwt')
    expect(await readSession()).toBeNull()
  })

  it('stores the cookie as httpOnly is expected by the browser, not readable here', async () => {
    await createSession({ email: 'logan@han.life', name: 'Logan', provider: 'google', role: 'admin' })
    expect(jar.store.get('hearth_session')?.split('.')).toHaveLength(3)
  })
})

describe('what an address is allowed to see', () => {
  it('treats ADMIN_EMAILS as admin, case and space insensitively', async () => {
    expect((await resolveRole('logan@han.life'))?.role).toBe('admin')
    expect((await resolveRole('  LOGAN@HAN.LIFE '))?.role).toBe('admin')
  })

  it('recognises nobody else', async () => {
    expect(await resolveRole('someone@else.com')).toBeNull()
    expect(await resolveRole('')).toBeNull()
  })

  it('gives an ordinary member the member role, not admin', async () => {
    await q.saveMember({ telegramUserId: '222', name: 'Ada', email: 'ada@han.life', allowed: true, isAdmin: false })
    expect((await resolveRole('ada@han.life'))?.role).toBe('member')
  })

  it('recognises an address an admin recorded, before any mailbox is linked', async () => {
    await q.saveMember({ telegramUserId: '444', name: 'Kid', email: 'kid@han.life', allowed: true, isAdmin: false })
    const resolved = await resolveRole('kid@han.life')
    expect(resolved?.role).toBe('member')
    expect(resolved?.member?.name).toBe('Kid')
  })

  it('recognises an address from a linked mailbox', async () => {
    const m = await q.upsertMember('555', 'Linked', { allowed: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: 'linked@han.life', refreshToken: 'r', scopes: null })
    expect((await resolveRole('linked@han.life'))?.role).toBe('member')
  })

  it('gives an admin family member the admin role', async () => {
    await q.saveMember({ telegramUserId: '666', name: 'Boss', email: 'boss@han.life', allowed: true, isAdmin: true })
    expect((await resolveRole('boss@han.life'))?.role).toBe('admin')
  })

  it('refuses a member whose access was revoked', async () => {
    await q.saveMember({ telegramUserId: '333', name: 'Old', email: 'old@han.life', allowed: true, isAdmin: true })
    await q.saveMember({ telegramUserId: '333', name: 'Old', email: 'old@han.life', allowed: false, isAdmin: true })
    expect(await resolveRole('old@han.life')).toBeNull()
  })

  it('recognises nobody when nothing is configured and nobody is recorded', async () => {
    delete process.env.ADMIN_EMAILS
    expect(await resolveRole('logan@han.life')).toBeNull()
  })
})

describe('requireAdmin', () => {
  it('lets an admin session through', async () => {
    await createSession({ email: 'logan@han.life', name: 'Logan', provider: 'google', role: 'admin' })
    expect(await requireAdmin()).not.toBeNull()
  })

  it('turns a member session away', async () => {
    await createSession({ email: 'ada@han.life', name: 'Ada', provider: 'google', role: 'member' })
    expect(await readSession()).not.toBeNull()
    expect(await requireAdmin()).toBeNull()
  })

  it('treats an unknown role claim as member, never as admin', async () => {
    const { SignJWT } = await import('jose')
    const token = await new SignJWT({ email: 'x@y.com', name: 'X', provider: 'google', role: 'root' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.TOKEN_ENC_KEY!))
    jar.store.set('hearth_session', token)
    expect((await readSession())?.role).toBe('member')
    expect(await requireAdmin()).toBeNull()
  })
})
