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

const { GET } = await import('@/app/api/admin/models/route')
const { POST: TEST } = await import('@/app/api/admin/models/test/route')
const { createSession } = await import('@/lib/auth/session')

const fetchMock = vi.fn()
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body })

const list = (provider: string) => GET(new Request(`https://h/api/admin/models?provider=${provider}`))
const probe = (body: unknown) =>
  TEST(new Request('https://h/api/admin/models/test', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

const asAdmin = () => createSession({ email: 'a@b.com', name: 'A', provider: 'google', role: 'admin' })
const asMember = () => createSession({ email: 'm@b.com', name: 'M', provider: 'google', role: 'member' })

beforeEach(() => {
  vi.clearAllMocks()
  jar.store.clear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.GEMINI_API_KEY = 'gk'
  process.env.OPENROUTER_API_KEY = 'ok'
  delete process.env.LLM_BASE_URL
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('listing models is admin only', () => {
  it('refuses without a session, and with a member session', async () => {
    expect((await list('gemini')).status).toBe(401)
    await asMember()
    expect((await list('gemini')).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a provider it does not know', async () => {
    await asAdmin()
    expect((await list('skynet')).status).toBe(400)
  })
})

describe('gemini listing', () => {
  beforeEach(asAdmin)

  it('keeps only models that can generate, and drops the rest', async () => {
    fetchMock.mockResolvedValue(
      json({
        models: [
          { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    )
    const ids = (await (await list('gemini')).json()).models.map((m: { id: string }) => m.id)
    expect(ids).toEqual(['gemini-3.5-flash', 'gemini-3.5-flash-lite'])
  })

  it('asks for a key first rather than calling out without one', async () => {
    delete process.env.GEMINI_API_KEY
    const res = await list('gemini')
    expect(res.status).toBe(502)
    expect(String((await res.json()).error)).toContain('Gemini key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an upstream failure rather than an empty list', async () => {
    fetchMock.mockResolvedValue(json({}, false, 403))
    expect((await list('gemini')).status).toBe(502)
  })
})

describe('openrouter listing', () => {
  beforeEach(asAdmin)

  const catalogue = {
    data: [
      { id: 'a/paid', name: 'Paid', supported_parameters: ['tools'], pricing: { prompt: '0.0000003', completion: '0.0000012' } },
      { id: 'b/free:free', name: 'Free', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
      { id: 'c/no-tools', name: 'No tools', supported_parameters: ['temperature'], pricing: { prompt: '0', completion: '0' } },
    ],
  }

  it('offers only tool-capable models, since the agent needs them', async () => {
    fetchMock.mockResolvedValue(json(catalogue))
    const ids = (await (await list('openrouter')).json()).models.map((m: { id: string }) => m.id)
    expect(ids).not.toContain('c/no-tools')
    expect(ids).toHaveLength(2)
  })

  it('puts free models first and prices the paid ones', async () => {
    fetchMock.mockResolvedValue(json(catalogue))
    const models = (await (await list('openrouter')).json()).models
    expect(models[0]).toMatchObject({ id: 'b/free:free', free: true, note: 'free' })
    expect(models[1]).toMatchObject({ free: false })
    expect(models[1].note).toContain('$0.30 in')
  })
})

describe('self-hosted listing', () => {
  beforeEach(asAdmin)

  it('asks for an endpoint before trying', async () => {
    const res = await list('self-hosted')
    expect(res.status).toBe(502)
    expect(String((await res.json()).error)).toContain('endpoint')
  })

  it('reads whatever the server has loaded', async () => {
    process.env.LLM_BASE_URL = 'http://127.0.0.1:11434/v1/'
    fetchMock.mockResolvedValue(json({ data: [{ id: 'qwen3' }] }))
    const models = (await (await list('self-hosted')).json()).models
    expect(models).toEqual([{ id: 'qwen3', label: 'qwen3', free: true, note: 'self-hosted' }])
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:11434/v1/models')
  })

  it('sends the key when the server checks one', async () => {
    process.env.LLM_BASE_URL = 'http://127.0.0.1:11434/v1'
    process.env.LLM_API_KEY = 'sk-local'
    try {
      fetchMock.mockResolvedValue(json({ data: [] }))
      await list('self-hosted')
      expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers).toMatchObject({
        authorization: 'Bearer sk-local',
      })
    } finally {
      delete process.env.LLM_API_KEY
    }
  })

  it('reports the server saying no', async () => {
    process.env.LLM_BASE_URL = 'http://127.0.0.1:11434/v1'
    fetchMock.mockResolvedValue(json({}, false, 500))
    expect((await list('self-hosted')).status).toBe(502)
  })
})

describe('listing failures across providers', () => {
  beforeEach(asAdmin)

  it('reports openrouter being down as an upstream failure', async () => {
    fetchMock.mockResolvedValue(json({}, false, 503))
    expect((await list('openrouter')).status).toBe(502)
  })

  it('labels the fast and capable ends of the gemini range', async () => {
    fetchMock.mockResolvedValue(json({ models: [
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-pro', supportedGenerationMethods: ['generateContent'] },
    ] }))
    const { models } = await (await list('gemini')).json()
    expect(models.find((m: { id: string }) => m.id.includes('lite')).note).toBe('fastest')
    expect(models.find((m: { id: string }) => m.id.includes('pro')).note).toBe('most capable')
  })
})

describe('testing one model', () => {
  beforeEach(asAdmin)

  it('is admin only', async () => {
    jar.store.clear()
    expect((await probe({ provider: 'openrouter', model: 'x' })).status).toBe(401)
  })

  it('needs a model', async () => {
    expect((await probe({ provider: 'openrouter' })).status).toBe(400)
  })

  it('reports success with the provider that served it', async () => {
    fetchMock.mockResolvedValue(json({ choices: [], provider: 'GMICloud' }))
    const d = await (await probe({ provider: 'openrouter', model: 'a/b:free' })).json()
    expect(d).toMatchObject({ ok: true, servedBy: 'GMICloud' })
    expect(d.reason).toContain('GMICloud')
  })

  it('names a privacy refusal for what it is', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'No endpoints found matching your data policy' } }, false, 404))
    const d = await (await probe({ provider: 'openrouter', model: 'a/b:free' })).json()
    expect(d.ok).toBe(false)
    expect(d.reason).toContain('train on prompts')
  })

  it('refuses to read a rate limit as a verdict', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'Provider returned error', code: 429 } }, false, 429))
    const d = await (await probe({ provider: 'openrouter', model: 'a/b:free' })).json()
    expect(d.ok).toBe(false)
    expect(d.reason).toContain('tells us nothing')
  })

  it('says so when the provider has no key', async () => {
    delete process.env.OPENROUTER_API_KEY
    const d = await (await probe({ provider: 'openrouter', model: 'a/b' })).json()
    expect(d).toMatchObject({ ok: false })
    expect(d.reason).toContain('No key set')
  })

  it('survives a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('socket timed out'))
    const d = await (await probe({ provider: 'gemini', model: 'gemini-3.5-flash' })).json()
    expect(d).toMatchObject({ ok: false, reason: 'Timed out.' })
  })

  it('rejects a malformed body', async () => {
    const res = await TEST(new Request('https://h/api/admin/models/test', { method: 'POST', body: 'nope' }))
    expect(res.status).toBe(400)
  })

  it('probes a self-hosted server at its own base url', async () => {
    process.env.LLM_BASE_URL = 'http://127.0.0.1:11434/v1/'
    fetchMock.mockResolvedValue(json({ choices: [] }))
    const d = await (await probe({ provider: 'self-hosted', model: 'qwen3' })).json()
    expect(d).toMatchObject({ ok: true, reason: 'Answered.' })
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('reads a tool-shape refusal as reachable', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'tools are not supported here' } }))
    const d = await (await probe({ provider: 'openrouter', model: 'x' })).json()
    expect(d.ok).toBe(false)
    expect(String(d.reason)).toContain('refused the request shape')
  })

  it('passes an unrecognised refusal through, trimmed', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: 'x'.repeat(300) } }, false, 500))
    const d = await (await probe({ provider: 'gemini', model: 'g' })).json()
    expect(d.ok).toBe(false)
    expect(String(d.reason).length).toBeLessThanOrEqual(140)
  })
})
