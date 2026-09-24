import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ReactElement } from 'react'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { recordModelEvent } from '@/lib/model-events'

/**
 * The dashboard's pages, awaited and rendered to HTML as the server would.
 * Each page does its own sign-in and admin check before it reads anything, so
 * a page that lost its check would show the family's settings and members to
 * whoever asked; these hold every page to its gate.
 */

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
// Home's panels refresh through the app router, which only a real Next mounts.
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: () => {} }),
}))
vi.mock('@/lib/settings', async (orig) => ({
  ...(await orig<typeof import('@/lib/settings')>()),
  hydrateSecrets: async () => {},
}))

const { default: HomePage } = await import('@/app/page')
const { default: SystemPage } = await import('@/app/system/page')
const { default: SettingsPage } = await import('@/app/settings/page')
const { default: SetupPage } = await import('@/app/setup/page')
const { default: PageError } = await import('@/app/error')
const { createSession } = await import('@/lib/auth/session')

let client: PGlite

const html = (page: ReactElement) => renderToStaticMarkup(page)
const home = async (month?: string) => html(await HomePage({ searchParams: Promise.resolve({ month }) }))

const asAdmin = () => createSession({ email: 'rowan@hearth.example', name: 'Rowan', provider: 'google', role: 'admin' })
// The cookie claims admin; the members table, read on every request, says otherwise.
const asMember = () => createSession({ email: 'ada@hearth.example', name: 'Ada', provider: 'google', role: 'admin' })

const SIGN_IN = 'Continue with Google'
const DENIED = 'That page is for administrators.'

beforeEach(async () => {
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  process.env.ADMIN_EMAILS = 'rowan@hearth.example'
  process.env.TELEGRAM_BOT_TOKEN = '123:abc'
  process.env.GEMINI_API_KEY = 'k'
  process.env.GEMINI_MODEL = 'gemini-flash'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
  await q.saveMember({ telegramUserId: '222', name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
  await q.saveMember({ telegramUserId: '333', name: 'Juno', email: 'juno@hearth.example', allowed: true, isAdmin: false })
})
afterEach(async () => closeDb(client))

describe('Home', () => {
  it('asks a stranger to sign in, and shows them nothing of the household', async () => {
    await q.addFamilyEvent({ title: 'Swimming lessons', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000) })
    const page = await home()
    expect(page).toContain(SIGN_IN)
    expect(page).not.toContain('Swimming lessons')
  })

  it('asks a member who has since been removed to sign in again', async () => {
    await asMember()
    await q.setMemberAllowed('222', false)
    expect(await home()).toContain(SIGN_IN)
  })

  it('shows a member the household, without the admin tabs', async () => {
    await q.addFamilyEvent({ title: 'Swimming lessons', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000) })
    await q.addListItems((await q.findOrCreateList('groceries')).id, ['oat milk'])
    await asMember()
    const page = await home()
    expect(page).toContain('Swimming lessons')
    expect(page).toContain('oat milk')
    expect(page).toContain('Next up')
    expect(page).not.toContain('href="/settings"')
    expect(page).not.toContain('href="/system"')
  })

  it('sends an admin to setup while there is no bot token, and shows the house once there is', async () => {
    await asAdmin()
    delete process.env.TELEGRAM_BOT_TOKEN
    await expect(home()).rejects.toMatchObject({ digest: expect.stringContaining('/setup') })

    process.env.TELEGRAM_BOT_TOKEN = '123:abc'
    const page = await home('2026-09')
    expect(page).toContain('September 2026')
    expect(page).toContain('href="/settings"')
  })

  it('leaves a member on Home whatever state the bot is in', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    await asMember()
    expect(await home()).toContain('Next up')
  })
})

describe('System', () => {
  it('is refused to anyone signed out, and to a member', async () => {
    expect(html(await SystemPage())).toContain(DENIED)
    await asMember()
    const page = html(await SystemPage())
    expect(page).toContain(DENIED)
    expect(page).not.toContain('Mailboxes linked')
  })

  it('shows an admin a new house as empty, not broken', async () => {
    await asAdmin()
    const page = html(await SystemPage())
    expect(page).toContain('Mailboxes linked')
    expect(page).toContain('No model calls recorded yet.')
    expect(page).toContain('No messages in the last fortnight.')
    expect(page).toContain('Nothing answered yet.')
    expect(page).toContain('no tick recorded yet')
  })

  it('shows an admin how the chain has fared, the traffic and the rooms', async () => {
    await q.rememberChat('-100', 'group', 'The Kitchen')
    await q.rememberChat('444', 'private', null)
    await q.noteStranger('-100', { id: '999', name: 'Unknown' })
    await q.recordMessage({ chatId: '-100', role: 'user', content: 'hi' })
    await q.recordMessage({ chatId: '-100', role: 'assistant', content: 'hello', model: 'gemini:gemini-flash' })
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.chat', outcome: 'answered', ms: 1200 })
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.chat', outcome: 'failed', error: '429 Too Many Requests' })
    // A slot since taken out of the chain still shows what it did this week.
    await recordModelEvent({ slot: 'openrouter:retired', purpose: 'hearth.chat', outcome: 'answered', ms: 800 })
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.chat', outcome: 'claim_retry' })
    await q.recordTick(new Date())
    await asAdmin()

    const page = html(await SystemPage())
    expect(page).toContain('gemini:gemini-flash')
    expect(page).toContain('typically 1.2 s')
    expect(page).toContain('skipped 1 time: rate limited ×1')
    expect(page).toContain('openrouter:retired')
    expect(page).toContain('never skipped')
    expect(page).toContain('1 reply was sent back')
    expect(page).toContain('Grey is what the family asked')
    expect(page).toContain('100%')
    expect(page).toContain('The Kitchen')
    expect(page).toContain('Someone (444)')
    expect(page).toContain('Quiet here: 1 person unrecognised')
    expect(page).toContain('just now')
    expect(page).not.toContain(DENIED)
  })
})

describe('Settings', () => {
  it('is refused to a member, who sees no one else and no settings', async () => {
    await asMember()
    const page = html(await SettingsPage())
    expect(page).toContain(DENIED)
    expect(page).not.toContain('juno@hearth.example')
    expect(page).not.toContain('Who answers')
  })

  it('shows an admin the family, the chain and the settings', async () => {
    await asAdmin()
    const page = html(await SettingsPage())
    expect(page).toContain('juno@hearth.example')
    expect(page).toContain('Who answers')
    expect(page).not.toContain(DENIED)
  })
})

describe('Setup', () => {
  it('asks a stranger to sign in, and refuses a member', async () => {
    expect(html(await SetupPage())).toContain(SIGN_IN)
    await asMember()
    expect(html(await SetupPage())).toContain(DENIED)
  })

  it('walks an admin through the first run, with the family listed', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    await asAdmin()
    const page = html(await SetupPage())
    expect(page).toContain('Light the fire')
    expect(page).toContain('Juno')
  })
})

describe('a page that throws', () => {
  it('points at the server log and the setup page', () => {
    const error = Object.assign(new Error('bad setting'), { digest: 'd1g3st' })
    const page = html(createElement(PageError, { error, retry: () => {} }))
    expect(page).toContain('under d1g3st')
    expect(page).toContain('href="/setup"')
    expect(html(createElement(PageError, { error: new Error('bad'), retry: () => {} }))).not.toContain('under')
  })
})
