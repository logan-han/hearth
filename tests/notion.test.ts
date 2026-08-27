import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as notion from '@/lib/providers/notion'
import { notionTools } from '@/lib/tools/notion'
import type { ToolContext } from '@/lib/tools/context'

const fetchMock = vi.fn()
const ctx = { chatId: '-100', member: null, memberName: 'Logan', now: new Date(), notices: [] } as ToolContext

const call = (name: string, args: unknown) => {
  const tools = notionTools(ctx) as Record<string, { execute: unknown; inputSchema: { parse: (a: unknown) => unknown } }>
  const parsed = tools[name].inputSchema.parse(args)
  return (tools[name].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(parsed, {})
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const rich = (t: string) => [{ plain_text: t }]

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NOTION_TOKEN = 'ntn_test'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('request shape', () => {
  it('pins the API version and sends a bearer token', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }))
    await notion.search({})
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://api.notion.com/v1/search')
    expect(headers.authorization).toBe('Bearer ntn_test')
    // Bumping this is a breaking change, not an upgrade.
    expect(headers['Notion-Version']).toBe('2025-09-03')
  })

  it('refuses to run without a token', async () => {
    delete process.env.NOTION_TOKEN
    expect(notion.notionConfigured()).toBe(false)
    expect(String((await call('notion_search', {})).error)).toContain('NOTION_TOKEN')
    expect(String((await call('notion_read_page', { id: 'x' })).error)).toContain('NOTION_TOKEN')
  })

  it('surfaces an API error with its status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'object_not_found' })
    expect(String((await call('notion_read_page', { id: 'nope' })).error)).toContain('Notion API 404')
  })
})

describe('readProperty', () => {
  const cases: [string, unknown, string][] = [
    ['title', { type: 'title', title: rich('Hungary') }, 'Hungary'],
    ['rich_text', { type: 'rich_text', rich_text: rich('some note') }, 'some note'],
    ['number', { type: 'number', number: 42 }, '42'],
    ['number zero', { type: 'number', number: 0 }, '0'],
    ['number null', { type: 'number', number: null }, ''],
    ['select', { type: 'select', select: { name: 'Done' } }, 'Done'],
    ['select empty', { type: 'select', select: null }, ''],
    ['status', { type: 'status', status: { name: 'In progress' } }, 'In progress'],
    ['multi_select', { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] }, 'a, b'],
    ['date', { type: 'date', date: { start: '2026-03-02', end: '2026-03-04' } }, '2026-03-02 to 2026-03-04'],
    ['date start only', { type: 'date', date: { start: '2026-03-02' } }, '2026-03-02'],
    ['checkbox true', { type: 'checkbox', checkbox: true }, 'yes'],
    ['checkbox false', { type: 'checkbox', checkbox: false }, 'no'],
    ['url', { type: 'url', url: 'https://x' }, 'https://x'],
    ['people', { type: 'people', people: [{ name: 'Logan' }] }, 'Logan'],
    ['relation', { type: 'relation', relation: [{}, {}] }, '2 linked'],
    ['formula', { type: 'formula', formula: { type: 'number', number: 7 } }, '7'],
    ['rollup', { type: 'rollup', rollup: { type: 'number', number: 3 } }, '3'],
    ['unique_id', { type: 'unique_id', unique_id: { prefix: 'HTL', number: 12 } }, 'HTL-12'],
    ['unknown type', { type: 'wormhole' }, ''],
    ['missing', undefined, ''],
  ]

  for (const [name, input, expected] of cases) {
    it(`reads ${name}`, () => expect(notion.readProperty(input)).toBe(expected))
  }
})

describe('notion_search', () => {
  it('returns titles pulled from either shape', async () => {
    fetchMock.mockResolvedValue(
      json({
        results: [
          { object: 'data_source', id: 'ds1', title: rich('Travel Plans'), url: 'https://n/ds1', last_edited_time: 't' },
          { object: 'page', id: 'p1', properties: { Name: { type: 'title', title: rich('Health') } }, url: 'https://n/p1' },
        ],
      }),
    )
    const r = await call('notion_search', { limit: 20 })
    expect(r.count).toBe(2)
    expect((r.results as { title: string }[]).map((x) => x.title)).toEqual(['Travel Plans', 'Health'])
  })

  it('falls back to (untitled) rather than blank', async () => {
    fetchMock.mockResolvedValue(json({ results: [{ object: 'page', id: 'p', properties: {} }] }))
    expect((await call('notion_search', { limit: 5 })).results).toMatchObject([{ title: '(untitled)' }])
  })

  it('explains the sharing requirement when nothing comes back', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }))
    expect(String((await call('notion_search', { query: 'x', limit: 5 })).note)).toContain('Connections')
  })

  it('passes the query and type filter through', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }))
    await call('notion_search', { query: 'travel', type: 'data_source', limit: 5 })
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.query).toBe('travel')
    expect(body.filter).toEqual({ property: 'object', value: 'data_source' })
  })
})

describe('notion_query_database', () => {
  const sources = json({
    results: [{ object: 'data_source', id: 'ds-travel', title: rich('Travel Plans'), url: null }],
  })
  const rows = json({
    results: [
      {
        id: 'r1', url: 'https://n/r1',
        properties: {
          Name: { type: 'title', title: rich('Hungary') },
          Status: { type: 'select', select: { name: 'Done' } },
          Notes: { type: 'rich_text', rich_text: [] },
        },
      },
    ],
  })

  it('resolves a database by name and flattens its rows', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/search') ? sources : rows,
    )
    const r = await call('notion_query_database', { database: 'travel', limit: 20 })
    expect(r.database).toBe('Travel Plans')
    expect(r.rows).toEqual([{ Name: 'Hungary', Status: 'Done' }])
  })

  it('drops empty properties instead of sending blanks to the model', async () => {
    fetchMock.mockImplementation(async (url: string) => (url.endsWith('/search') ? sources : rows))
    const r = await call('notion_query_database', { database: 'travel', limit: 20 })
    expect(Object.keys((r.rows as Record<string, string>[])[0])).not.toContain('Notes')
  })

  it('queries the data source endpoint, not the old database one', async () => {
    fetchMock.mockImplementation(async (url: string) => (url.endsWith('/search') ? sources : rows))
    await call('notion_query_database', { database: 'travel', limit: 20 })
    const queried = fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/query'))
    expect(queried).toBe('https://api.notion.com/v1/data_sources/ds-travel/query')
  })

  it('says which database it could not find, and why', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }))
    const r = await call('notion_query_database', { database: 'reading list', limit: 20 })
    expect(String(r.error)).toContain('reading list')
    expect(String(r.error)).toContain('Connections')
  })
})

describe('notion_read_page', () => {
  it('combines properties with the page text', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/blocks/')
        ? json({
            results: [
              { type: 'heading_1', heading_1: { rich_text: rich('Notes') } },
              { type: 'paragraph', paragraph: { rich_text: rich('Body text') } },
              { type: 'to_do', to_do: { rich_text: rich('Book flights'), checked: true } },
              { type: 'bulleted_list_item', bulleted_list_item: { rich_text: rich('A point') } },
              { type: 'image', image: {} },
              { type: 'paragraph', paragraph: { rich_text: [] } },
            ],
          })
        : json({ object: 'page', id: 'p1', url: 'https://n/p1', properties: { Name: { type: 'title', title: rich('Health') } } }),
    )
    const r = await call('notion_read_page', { id: 'p1' })
    expect(r.title).toBe('Health')
    expect(r.content).toBe('## Notes\nBody text\n[x] Book flights\n- A point')
  })
})

describe('notion_append_to_page', () => {
  it('adds one paragraph per line', async () => {
    fetchMock.mockResolvedValue(json({}))
    const r = await call('notion_append_to_page', { id: 'p1', text: 'first\n\nsecond' })
    expect(r.added).toBe(2)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.notion.com/v1/blocks/p1/children')
    expect(init.method).toBe('PATCH')
    const body = JSON.parse(String(init.body))
    expect(body.children[0].paragraph.rich_text[0].text.content).toBe('first')
  })

  it('refuses an empty append rather than calling the API', async () => {
    expect(String((await call('notion_append_to_page', { id: 'p1', text: '   \n ' })).error)).toContain('Nothing to add')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('is additive only: it never issues a delete or a page update', async () => {
    fetchMock.mockResolvedValue(json({}))
    await call('notion_append_to_page', { id: 'p1', text: 'x' })
    const methods = fetchMock.mock.calls.map(([, i]) => (i as RequestInit).method)
    expect(methods).toEqual(['PATCH'])
    expect(methods).not.toContain('DELETE')
  })
})
