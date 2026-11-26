import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import type { ToolContext } from '@/lib/tools/context'

/**
 * The edges of the wrapping every tool gets, and of the brief's own runner,
 * reached through tools made odd on purpose: a write that answers with
 * nothing, a tool with nothing to run, a board that cannot run in the brief.
 */
const odd = vi.hoisted(() => ({ boardRuns: true }))

vi.mock('@/lib/tools/lists', () => ({
  listTools: () => ({
    // A write that answers with nothing at all.
    add_to_list: { description: 'add', inputSchema: {}, execute: async () => undefined },
    // A tool with nothing to run.
    show_lists: { description: 'lists', inputSchema: {} },
  }),
}))
vi.mock('@/lib/tools/weather', () => ({
  // A read that answers with nothing, as the brief's runner must take.
  weatherTools: () => ({ weather: { description: 'weather', inputSchema: {}, execute: async () => undefined } }),
}))
vi.mock('@/lib/tools/jira', () => ({
  jiraTools: () => ({
    jira_board_summary: odd.boardRuns
      ? { description: 'board', inputSchema: {}, execute: async () => ({ error: 'Jira is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).' }) }
      : { description: 'board', inputSchema: {} },
  }),
}))
const clientsFor = vi.fn(async () => [] as unknown[])
vi.mock('@/lib/providers', async (orig) => ({ ...(await orig<typeof import('@/lib/providers')>()), clientsFor: () => clientsFor() }))

const { buildTools } = await import('@/lib/tools')
const { briefTools } = await import('@/lib/tools/brief')

let client: PGlite
let ctx: ToolContext
const call = (c: ToolContext, name: string, args: unknown) =>
  ((buildTools(c) as unknown as Record<string, { execute?: (a: unknown, o: unknown) => Promise<unknown> }>)[name].execute!)(args, {})

beforeEach(async () => {
  odd.boardRuns = true
  process.env.APP_URL = 'https://hearth.example'
  client = (await freshDb()).client
  const member = await q.saveMember({ name: 'Rowan', email: 'rowan@hearth.example', allowed: true, isAdmin: false })
  ctx = { member, memberName: 'Rowan', now: new Date(), via: 'mcp' }
})
afterEach(async () => closeDb(client))

describe('the wrapping every tool gets', () => {
  it('leaves a tool with nothing to run as it is', () => {
    const tools = buildTools(ctx) as unknown as Record<string, { execute?: unknown; description?: string }>
    expect(tools.show_lists.execute).toBeUndefined()
    expect(tools.show_lists.description).toBe('lists')
  })

  it('takes a call with no input and a result of nothing, and keeps a write that answered nothing on the record', async () => {
    const run: ToolContext = { ...ctx, typed: ['earlier'] }
    expect(await call(run, 'weather', undefined)).toBeUndefined()
    expect(run.typed).toEqual(['earlier', ''])
    expect(run.seen?.at(-1)).toEqual({ text: '', typed: 2 })
    expect(await call(run, 'add_to_list', { items: ['milk'] })).toBeUndefined()
    expect(run.wrote).toEqual(['add_to_list'])
    expect((await q.recentActivity({ memberId: ctx.member!.id })).map((a) => a.summary)).toEqual(['added milk to the shopping list'])
  })

  it('files a write with no member behind it under nobody', async () => {
    await call({ ...ctx, member: null }, 'add_to_list', { items: ['bread'] })
    expect((await q.recentActivity()).map((a) => [a.summary, a.who])).toEqual([['added bread to the shopping list', null]])
  })

  it('reads a link with no address as nothing to vouch for, and opens no link once outside text is read with nothing seen', async () => {
    const clean: ToolContext = { ...ctx }
    const r = (await call(clean, 'read_url', {})) as Record<string, unknown>
    expect(r.error).toBeDefined()
    expect(clean.seen?.[0]).toEqual({ text: '', typed: 0 })
    const tainted: ToolContext = { ...ctx, readUntrusted: true }
    expect(String(((await call(tainted, 'read_url', { url: 'https://203.0.113.10/x' })) as Record<string, unknown>).error)).toContain('Not opened')
  })
})

describe("the brief's own runner", () => {
  const brief = (c: ToolContext) =>
    ((briefTools(c) as unknown as Record<string, { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }>).morning_brief.execute)({}, {})

  it('takes a tool that answers nothing as an empty answer', async () => {
    const r = await brief(ctx)
    expect(r.weather).toEqual({})
    expect(r.how_to_read).toBeDefined()
  })

  it('refuses a tool it cannot run rather than passing it off as quiet', async () => {
    odd.boardRuns = false
    await expect(brief(ctx)).rejects.toThrow('jira_board_summary cannot run here')
  })
})
