import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'

const sendMail = vi.fn()
const createEvent = vi.fn()
const stub = (provider: string) => ({ provider, sendMail, createEvent, listEvents: vi.fn(), listMail: vi.fn() })
vi.mock('@/lib/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/providers')>()),
  clientFor: (_id: number, p: string) => stub(p),
  clientsFor: async (id: number) => (await q.connectionsFor(id)).map((c) => stub(c.provider)),
}))

const { mailTools, readOnlyRefusal } = await import('@/lib/tools/mail')
const { calendarTools } = await import('@/lib/tools/calendar')
const { ambientContext } = await import('@/lib/agent')

let client: PGlite
let ctx: ToolContext
const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  client = (await freshDb()).client
  const member = await q.upsertMember('111', 'Rowan', { allowed: true })
  ctx = { chatId: '111', member, memberName: 'Rowan', now: new Date(), notices: [] }
  await q.saveConnection({ memberId: member.id, provider: 'google', email: 'r@gmail.example', refreshToken: 'r', scopes: null })
})
afterEach(async () => closeDb(client))

const letter = { to: ['office@example.org'], subject: 'Hello', body: 'Hi' }

describe('an account linked to be read only', () => {
  it('takes no draft, and is not swapped for another account unasked', async () => {
    await q.setConnectionReadOnly(ctx.member!.id, 'google', true)
    expect(await call(mailTools(ctx), 'draft_email', letter)).toEqual({ error: readOnlyRefusal('google') })
    await q.saveConnection({ memberId: ctx.member!.id, provider: 'microsoft', email: 'r@outlook.example', refreshToken: 'r', scopes: null })
    // Asked for by name, the read-only one says so; otherwise the writable one drafts.
    expect(await call(mailTools(ctx), 'draft_email', { ...letter, provider: 'google' })).toEqual({ error: readOnlyRefusal('google') })
    expect((await call(mailTools(ctx), 'draft_email', letter)).from).toBe('microsoft')
    expect(readOnlyRefusal('google')).toBe(
      'Your Google account is linked read-only, so nothing is drafted, sent or put on its calendar through it. Send /readonly google off to allow it again.',
    )
  })

  it('sends nothing from a draft written before it was made read only', async () => {
    const draft = await call(mailTools(ctx), 'draft_email', letter)
    await q.setConnectionReadOnly(ctx.member!.id, 'google', true)
    const r = await call(mailTools({ ...ctx }), 'send_email', { draft_id: draft.draft_id, confirmed: true })
    expect(r).toEqual({ error: readOnlyRefusal('google') })
    expect(sendMail).not.toHaveBeenCalled()
    expect((await q.getDraft(Number(draft.draft_id)))!.status).toBe('pending')
  })

  it('takes no event on its calendar, by name or otherwise', async () => {
    await q.setConnectionReadOnly(ctx.member!.id, 'google', true)
    const event = { title: 'Gym', start: '2027-03-01T09:00', all_day: false }
    expect(await call(calendarTools(ctx), 'create_calendar_event', event)).toEqual({ error: readOnlyRefusal('google') })
    expect(await call(calendarTools(ctx), 'create_calendar_event', { ...event, provider: 'google' })).toEqual({ error: readOnlyRefusal('google') })
    await q.saveConnection({ memberId: ctx.member!.id, provider: 'microsoft', email: 'r@outlook.example', refreshToken: 'r', scopes: null })
    createEvent.mockResolvedValue({ id: 'e', title: 'Gym', start: '2027-02-28T22:00:00Z', end: '2027-02-28T23:00:00Z', allDay: false })
    expect((await call(calendarTools(ctx), 'create_calendar_event', event)).provider).toBe('microsoft')
    expect(createEvent).toHaveBeenCalledTimes(1)
  })

  it('keeps the choice when the account is linked again, says so in the context, and is undone', async () => {
    await q.setConnectionReadOnly(ctx.member!.id, 'google', true)
    await q.saveConnection({ memberId: ctx.member!.id, provider: 'google', email: 'r@gmail.example', refreshToken: 'new', scopes: null })
    expect((await q.connectionsFor(ctx.member!.id))[0].readOnly).toBe(true)
    expect((await ambientContext('111', ctx.member, 'chat')).text).toContain('Rowan (google: r@gmail.example, read only)')
    await q.setConnectionReadOnly(ctx.member!.id, 'google', false)
    expect((await call(mailTools(ctx), 'draft_email', letter)).from).toBe('google')
    expect(await q.setConnectionReadOnly(ctx.member!.id, 'microsoft', true)).toBeUndefined()
  })
})
