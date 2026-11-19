import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement, type ReactElement } from 'react'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { Member } from '@/lib/db/schema'
import { recordModelEvent } from '@/lib/model-events'
import { jar } from './helpers/next-headers'

/**
 * The dashboard's pages, awaited and rendered to HTML as the server would.
 * Each page does its own sign-in and admin check before it reads anything, so
 * a page that lost its check would show the family's settings and members to
 * whoever asked; these hold every page to its gate.
 */

vi.mock('next/headers', async () => ({ cookies: (await import('./helpers/next-headers')).jar.cookies }))
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
let ada: Member

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
  process.env.GEMINI_API_KEY = 'k'
  process.env.GEMINI_MODEL = 'gemini-flash'
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  client = (await freshDb()).client
  ada = await q.saveMember({ name: 'Ada', email: 'ada@hearth.example', allowed: true, isAdmin: false })
  await q.saveMember({ name: 'Juno', email: 'juno@hearth.example', allowed: true, isAdmin: false })
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
    await q.saveMember({ id: ada.id, name: 'Ada', email: ada.email, allowed: false, isAdmin: false })
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

  it("shows a member their own reports, keys and drafts, and where to connect a client, and never another member's", async () => {
    const juno = (await q.allMembers()).find((m) => m.name === 'Juno')!
    await q.addReport({ memberId: ada.id, automationId: null, label: 'Camp dates', status: 'held', body: 'Camp is 3 to 5 March', detail: 'Held back: unsure' })
    await q.addReport({ memberId: juno.id, automationId: null, label: 'Juno only', status: 'ready', body: 'Not for Ada' })
    await q.issueMcpKey(ada.id, 'Claude on the laptop')
    await q.issueMcpKey(juno.id, 'Juno phone')
    await q.createDraft({ memberId: ada.id, provider: 'google', to: ['school@example.com'], subject: 'Absence note', body: 'b' })
    await q.addProposal({ title: 'Working bee', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000) })
    await asMember()

    const page = await home()
    expect(page).toContain('Reports')
    expect(page).toContain('Camp dates')
    expect(page).toContain('held back')
    expect(page).not.toContain('Juno only')
    expect(page).toContain('Claude and other MCP clients')
    expect(page).toContain('Claude on the laptop')
    expect(page).not.toContain('Juno phone')
    expect(page).toContain('https://hearth.example/api/mcp')
    expect(page).toContain('Absence note')
    expect(page).toContain('Working bee')
  })

  it('sends an admin to setup while nobody is in the family, and shows the house once someone is', async () => {
    await client.query('delete from members')
    await asAdmin()
    await expect(home()).rejects.toMatchObject({ digest: expect.stringContaining('/setup') })

    await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: true })
    const page = await home('2026-09')
    expect(page).toContain('September 2026')
    expect(page).toContain('href="/settings"')
  })

  it('tells an admin with no member behind their address that a key needs one', async () => {
    await asAdmin()
    const page = await home()
    expect(page).toContain('A key acts as a family member, and this address is not one yet.')
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
    expect(page).toContain('MCP keys')
    expect(page).toContain('No model calls recorded yet.')
    expect(page).toContain('Nothing changed in the last fortnight.')
    expect(page).toContain('No scheduled run yet.')
    expect(page).toContain('No keys yet.')
    expect(page).toContain('None scheduled.')
    expect(page).toContain('no tick recorded yet')
    expect(page).not.toMatch(/chat|telegram/i)
  })

  it('shows an admin how the chain has fared, the changes, the keys and the reminders', async () => {
    await q.recordActivity({ memberId: ada.id, via: 'mcp', tool: 'add_to_list', summary: 'added milk' })
    await q.recordActivity({ memberId: ada.id, via: 'watcher', tool: 'propose_family_event', summary: 'proposed' })
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.watcher', outcome: 'answered', ms: 1200 })
    await recordModelEvent({ slot: 'gemini:gemini-flash', purpose: 'hearth.watcher', outcome: 'failed', error: '429 Too Many Requests' })
    // A slot since taken out of the chain still shows what it did this week.
    await recordModelEvent({ slot: 'openrouter:retired', purpose: 'hearth.decision', outcome: 'answered', ms: 800 })
    await q.issueMcpKey(ada.id, 'Claude Desktop')
    await q.addAutomation({ memberId: ada.id, label: 'Bin night', cronExpr: '0 19 * * 1', instruction: 'x', nextRunAt: new Date(Date.now() + 86_400_000) })
    await q.recordTick(new Date())
    await asAdmin()

    const page = html(await SystemPage())
    expect(page).toContain('gemini:gemini-flash')
    expect(page).toContain('typically 1.2 s')
    expect(page).toContain('skipped 1 time: rate limited ×1')
    expect(page).toContain('openrouter:retired')
    expect(page).toContain('never skipped')
    expect(page).toContain('Grey is what members changed')
    expect(page).toContain('100%')
    expect(page).toContain('Claude Desktop')
    expect(page).toContain('not used yet')
    expect(page).toContain('Bin night')
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

  it('shows an admin the family, the chain and the settings, with nothing of a chat bot', async () => {
    await asAdmin()
    const page = html(await SettingsPage())
    expect(page).toContain('juno@hearth.example')
    expect(page).toContain('Who answers')
    expect(page).toContain('Sign everyone out')
    expect(page).not.toContain(DENIED)
    expect(page).not.toMatch(/telegram|webhook|bot token/i)
  })
})

describe('Setup', () => {
  it('asks a stranger to sign in, and refuses a member', async () => {
    expect(html(await SetupPage())).toContain(SIGN_IN)
    await asMember()
    expect(html(await SetupPage())).toContain(DENIED)
  })

  it('walks an admin through the first run, with the family listed by address', async () => {
    await asAdmin()
    const page = html(await SetupPage())
    expect(page).toContain('Light the fire')
    expect(page).toContain('Juno')
    expect(page).toContain('juno@hearth.example')
    expect(page).toContain('Connect an MCP client')
    expect(page).not.toMatch(/telegram|botfather|webhook/i)
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
