import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'

const createEvent = vi.fn()
const stub = (provider: string) => ({ provider, createEvent, listEvents: vi.fn() })
vi.mock('@/lib/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/providers')>()),
  clientFor: (_id: number, p: string) => stub(p),
  clientsFor: async (id: number) => (await q.connectionsFor(id)).map((c) => stub(c.provider)),
}))

const { readOnlyRefusal } = await import('@/lib/tools/accounts')
const { calendarTools } = await import('@/lib/tools/calendar')
const { context } = await import('@/lib/mcp')

let client: PGlite
let ctx: ToolContext
const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  client = (await freshDb()).client
  process.env.APP_URL = 'https://hearth.example'
  const member = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
  ctx = { member, memberName: 'Rowan', now: new Date() }
  await q.saveConnection({ memberId: member.id, provider: 'google', email: 'r@gmail.example', refreshToken: 'r', scopes: null })
})
afterEach(async () => closeDb(client))

describe('an account linked to be read only', () => {
  it('takes no event on its calendar, by name or otherwise', async () => {
    await q.setConnectionReadOnly(ctx.member!.id, 'google', true)
    const event = { title: 'Gym', start: '2027-03-01T09:00', all_day: false }
    expect(await call(calendarTools(ctx), 'create_calendar_event', event)).toEqual({ error: readOnlyRefusal('google') })
    expect(await call(calendarTools(ctx), 'create_calendar_event', { ...event, provider: 'google' })).toEqual({ error: readOnlyRefusal('google') })
    await q.saveConnection({ memberId: ctx.member!.id, provider: 'microsoft', email: 'r@outlook.example', refreshToken: 'r', scopes: null })
    createEvent.mockResolvedValue({ id: 'e', title: 'Gym', start: '2027-02-28T22:00:00Z', end: '2027-02-28T23:00:00Z', allDay: false })
    expect((await call(calendarTools(ctx), 'create_calendar_event', event)).provider).toBe('microsoft')
    expect(createEvent).toHaveBeenCalledTimes(1)
    expect(readOnlyRefusal('google')).toBe(
      "Your Google account is linked read-only, so nothing is put on its calendar through it. You can allow it again on Hearth's Connect page: https://hearth.example/connect.",
    )
  })

  it('keeps the choice when the account is linked again, says so in the context, and is undone', async () => {
    await q.setConnectionReadOnly(ctx.member!.id, 'google', true)
    await q.saveConnection({ memberId: ctx.member!.id, provider: 'google', email: 'r@gmail.example', refreshToken: 'new', scopes: null })
    expect((await q.connectionsFor(ctx.member!.id))[0].readOnly).toBe(true)
    expect(await context(ctx.member!)).toContain('Rowan (google: r@gmail.example, read only)')
    await q.setConnectionReadOnly(ctx.member!.id, 'google', false)
    createEvent.mockResolvedValue({ id: 'e', title: 'Gym', start: '2027-02-28T22:00:00Z', end: '2027-02-28T23:00:00Z', allDay: false })
    expect((await call(calendarTools(ctx), 'create_calendar_event', { title: 'Gym', start: '2027-03-01T09:00', all_day: false })).provider).toBe('google')
    expect(await q.setConnectionReadOnly(ctx.member!.id, 'microsoft', true)).toBeUndefined()
  })
})
