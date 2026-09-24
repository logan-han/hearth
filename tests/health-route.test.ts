import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'

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
const { modelsList } = vi.hoisted(() => ({ modelsList: vi.fn() }))
vi.mock('@typesafe-ai/sdk', async (orig) => {
  const actual = await orig<typeof import('@typesafe-ai/sdk')>()
  class TypeSafeClient {
    models = { list: modelsList }
    systemOne = vi.fn()
  }
  return { ...actual, TypeSafeClient }
})
vi.mock('@/lib/settings', async (orig) => ({
  ...(await orig<typeof import('@/lib/settings')>()),
  hydrateSecrets: async () => {},
}))

const { GET } = await import('@/app/api/admin/health/route')
const { createSession } = await import('@/lib/auth/session')

const fetchMock = vi.fn()

// A session is checked against the members table on every request; one
// database for the file is enough, since nothing here writes to it.
let client: PGlite
beforeAll(async () => { client = (await freshDb()).client })
afterAll(async () => closeDb(client))

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.ADMIN_EMAILS = 'a@b.com'
  for (const k of ['UP_API_TOKEN', 'POCKETSMITH_DEVELOPER_KEY', 'NOTION_TOKEN', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'OPENWEATHER_API_KEY', 'TYPESAFE_API_KEY']) {
    delete process.env[k]
  }
  ;(await import('@/lib/jev')).resetJevClient()
  vi.stubGlobal('fetch', fetchMock)
  const weather = await import('@/lib/providers/weather')
  weather.clearWeatherCache()
  const ps = await import('@/lib/providers/pocketsmith')
  ps.resetUserCache()
})
afterEach(() => vi.unstubAllGlobals())

describe('the health probe', () => {
  it('is admin only', async () => {
    expect((await GET()).status).toBe(401)
  })

  it('probes only what is configured, and tells validity from presence', async () => {
    await createSession({ email: 'a@b.com', name: 'A', provider: 'google', role: 'admin' })
    process.env.UP_API_TOKEN = 'dead-token'
    process.env.OPENWEATHER_API_KEY = 'good-key'
    fetchMock.mockImplementation(async (u: unknown) => {
      const url = String(u)
      if (url.includes('up.com.au')) return { ok: false, status: 401, text: async () => 'Not Authorized' }
      if (url.includes('openweathermap')) return { ok: true, status: 200, json: async () => [{ name: 'Melbourne', lat: 1, lon: 2 }], text: async () => '' }
      throw new Error(`unexpected probe: ${url}`)
    })

    const { items } = await (await GET()).json()
    expect(items).toHaveLength(2)
    const by = (n: string) => items.find((i: { name: string }) => i.name === n)
    expect(by('Up Bank').ok).toBe(false)
    expect(String(by('Up Bank').error)).toContain('401')
    expect(by('OpenWeatherMap').ok).toBe(true)
    expect(by('Notion')).toBeUndefined()
  })

  it('proves a Jev key by listing the account models, and reports a refused one', async () => {
    await createSession({ email: 'a@b.com', name: 'A', provider: 'google', role: 'admin' })
    process.env.TYPESAFE_API_KEY = 'ts-key'
    modelsList.mockResolvedValueOnce([{ id: 'jev-1.13.0' }])
    let { items } = await (await GET()).json()
    expect(items).toEqual([{ name: 'Jev', ok: true }])
    modelsList.mockRejectedValueOnce(new Error('HTTP 401: invalid api key'))
    ;({ items } = await (await GET()).json())
    expect(items[0]).toMatchObject({ name: 'Jev', ok: false, error: expect.stringContaining('401') })
  })

  it('also probes PocketSmith, Notion and Jira with their cheapest calls', async () => {
    await createSession({ email: 'a@b.com', name: 'A', provider: 'google', role: 'admin' })
    process.env.POCKETSMITH_DEVELOPER_KEY = 'ps-key'
    process.env.NOTION_TOKEN = 'ntn_x'
    process.env.JIRA_BASE_URL = 'https://example.atlassian.net'
    process.env.JIRA_EMAIL = 'rowan@hearth.example'
    process.env.JIRA_API_TOKEN = 'jira-token'
    fetchMock.mockImplementation(async (u: unknown) => {
      const url = String(u)
      if (url.includes('pocketsmith.com')) return { ok: true, status: 200, json: async () => ({ id: 42 }), text: async () => '' }
      if (url.includes('notion.com')) return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' }
      if (url.includes('atlassian.net')) return { ok: false, status: 401, json: async () => ({}), text: async () => 'Unauthorized' }
      throw new Error(`unexpected probe: ${url}`)
    })

    const { items } = await (await GET()).json()
    const by = (n: string) => items.find((i: { name: string }) => i.name === n)
    expect(by('PocketSmith').ok).toBe(true)
    expect(by('Notion').ok).toBe(true)
    expect(by('Jira').ok).toBe(false)
    expect(String(by('Jira').error)).toContain('401')
  })

  it('reports a probe that never answers as a timeout, without waiting six seconds for it', async () => {
    await createSession({ email: 'a@b.com', name: 'A', provider: 'google', role: 'admin' })
    process.env.UP_API_TOKEN = 'dead-token'
    fetchMock.mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const res = GET()
      // Once the probe has called out, its six-second clock is running.
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(6000)
      const { items } = await (await res).json()
      expect(items).toEqual([{ name: 'Up Bank', ok: false, error: 'No answer within 6s.' }])
    } finally {
      vi.useRealTimers()
    }
  })
})
