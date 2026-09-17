import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
vi.mock('@/lib/settings', async (orig) => ({
  ...(await orig<typeof import('@/lib/settings')>()),
  hydrateSecrets: async () => {},
}))

const { GET } = await import('@/app/api/admin/health/route')
const { createSession } = await import('@/lib/auth/session')

const fetchMock = vi.fn()

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  for (const k of ['UP_API_TOKEN', 'POCKETSMITH_DEVELOPER_KEY', 'NOTION_TOKEN', 'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'OPENWEATHER_API_KEY']) {
    delete process.env[k]
  }
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
})
