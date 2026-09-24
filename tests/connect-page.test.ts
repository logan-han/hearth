import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { signState, connectLink } from '@/lib/oauth/state'
import { startAuth } from '@/lib/oauth/flow'
import Connect from '@/app/connect/page'

let client: PGlite

beforeEach(async () => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  process.env.GOOGLE_CLIENT_ID = 'gid'
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

const render = async (t?: string) => renderToStaticMarkup(await Connect({ searchParams: Promise.resolve({ t }) }))

describe('/connect', () => {
  it('shows an allowed member their accounts and the family feed', async () => {
    await q.upsertMember('111', 'Rowan', { allowed: true })
    const t = new URL(await connectLink('https://hearth.example', { tg: '111', name: 'Rowan', chat: '' })).searchParams.get('t')!
    const html = await render(t)
    expect(html).toContain('Hello, Rowan')
    expect(html).toContain(`/api/calendar/${await q.calendarToken()}/family.ics`)
  })

  it('tells a member whose MCP key has stopped working to send /mcp new, not /mcp', async () => {
    // Plain /mcp only reports a key that is already there, and every key from
    // before keys carried a tag is one of those.
    await q.upsertMember('111', 'Rowan', { allowed: true })
    const t = new URL(await connectLink('https://hearth.example', { tg: '111', name: 'Rowan', chat: '' })).searchParams.get('t')!
    const html = await render(t)
    expect(html).toContain('have stopped working')
    expect(html).toMatch(/<strong> ?\/mcp new<\/strong>/)
  })

  it('shows nothing of the household to the sign-in state anyone can ask for', async () => {
    const res = await startAuth(new Request('https://hearth.example/api/oauth/google?signin=1'), 'google')
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!
    const html = await render(state)
    expect(html).toContain('expired')
    expect(html).not.toContain('/api/calendar/')
  })

  it('shows nothing to a link whose member has since been revoked, or never was', async () => {
    await q.upsertMember('222', 'Sam', { allowed: true })
    await q.setMemberAllowed('222', false)
    for (const tg of ['222', '333']) {
      const html = await render(await signState({ tg, name: 'Someone', chat: '' }, '30m'))
      expect(html).toContain('no longer valid')
      expect(html).not.toContain('/api/calendar/')
    }
  })

  it('asks for a personal link when given none', async () => {
    expect(await render()).toContain('needs a personal link')
  })
})
