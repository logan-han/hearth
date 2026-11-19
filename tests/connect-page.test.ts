import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { jar } from './helpers/next-headers'

vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))
// The account buttons refresh through the app router, which only a real Next mounts.
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: () => {} }),
}))

const { default: Connect } = await import('@/app/connect/page')
const { createSession } = await import('@/lib/auth/session')

let client: PGlite

beforeEach(async () => {
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  process.env.GOOGLE_CLIENT_ID = 'gid'
  delete process.env.ADMIN_EMAILS
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

const render = async (linked?: string) => renderToStaticMarkup(await Connect({ searchParams: Promise.resolve({ linked }) }))
const signIn = (email: string) => createSession({ email, name: email, provider: 'google', role: 'member' })

describe('/connect', () => {
  it('shows a signed-in member their accounts, the family feed and where their keys live', async () => {
    await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
    await signIn('rowan@hearth.example')
    const html = await render()
    expect(html).toContain('Hello, Rowan')
    expect(html).toContain('href="/api/oauth/google"')
    expect(html).toContain('href="/api/oauth/microsoft"')
    expect(html).toContain(`/api/calendar/${await q.calendarToken()}/family.ics`)
    expect(html).toContain('https://hearth.example/api/mcp')
    expect(html).toContain('Make a key for each client')
    expect(html).not.toMatch(/telegram|\/mcp new|\/unlink|send \/connect/i)
  })

  it('offers a relink, read only and unlink for an account already linked, and says what was just linked', async () => {
    const rowan = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
    await q.saveConnection({ memberId: rowan.id, provider: 'google', email: 'rowan@gmail.example', refreshToken: 'r', scopes: null })
    await q.setConnectionReadOnly(rowan.id, 'google', true)
    await signIn('rowan@hearth.example')
    const html = await render('google')
    expect(html).toContain('google linked ✓')
    expect(html).toContain('Google · rowan@gmail.example')
    expect(html).toContain('relink →')
    expect(html).toContain('read only')
    expect(html).toContain('checked=""')
    expect(html).toContain('Unlink')
    // Microsoft is not linked, so it offers a link and nothing to undo.
    expect(html.match(/Unlink/g)).toHaveLength(1)
  })

  it('asks anyone signed out to sign in, showing nothing of the household', async () => {
    const html = await render()
    expect(html).toContain('Continue with Google')
    expect(html).not.toContain('/api/calendar/')
  })

  it('shows nothing to a member revoked since they signed in', async () => {
    const sam = await q.saveMember({ name: 'Sam', email: 'sam@hearth.example', allowed: true, isAdmin: false })
    await signIn('sam@hearth.example')
    await q.saveMember({ id: sam.id, name: 'Sam', email: sam.email, allowed: false, isAdmin: false })
    const html = await render()
    expect(html).toContain('Continue with Google')
    expect(html).not.toContain('/api/calendar/')
  })

  it('tells an ADMIN_EMAILS address with no member behind it that accounts are linked by members', async () => {
    process.env.ADMIN_EMAILS = 'boss@hearth.example'
    await createSession({ email: 'boss@hearth.example', name: 'Boss', provider: 'google', role: 'admin' })
    const html = await render()
    expect(html).toContain('Accounts are linked by family members, and this address is not one yet.')
    expect(html).not.toContain('/api/calendar/')
  })
})
