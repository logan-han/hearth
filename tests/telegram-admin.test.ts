import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

const { GET, POST } = await import('@/app/api/admin/telegram/route')
const { createSession } = await import('@/lib/auth/session')
const { resetHydration } = await import('@/lib/settings')

const fetchMock = vi.fn()
let client: PGlite

const post = (body: unknown) =>
  POST(new Request('https://hearth.han.life/api/admin/telegram', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

const signIn = () => createSession({ email: 'logan@han.life', name: 'Logan', provider: 'google', role: 'admin' })

/** Answer Telegram API calls by method name; each handler sees the request body. */
function telegramAnswers(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
    const method = String(url).split('/').pop()!
    const handler = handlers[method]
    const reply = handler
      ? handler(init?.body ? JSON.parse(String(init.body)) : {})
      : { ok: false, description: `no test handler for ${method}` }
    return { json: async () => reply }
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  jar.store.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.han.life'
  delete process.env.TELEGRAM_BOT_TOKEN
  delete process.env.TELEGRAM_WEBHOOK_SECRET
  const { resetKeyCache } = await import('@/lib/crypto')
  resetKeyCache()
  resetHydration()
  vi.stubGlobal('fetch', fetchMock)
  client = (await freshDb()).client
})
afterEach(async () => { vi.unstubAllGlobals(); await closeDb(client) })

describe('the Telegram admin API', () => {
  it('requires an admin session for both verbs', async () => {
    expect((await GET()).status).toBe(401)
    expect((await post({ register: true })).status).toBe(401)
  })

  it('reports an unconfigured bot without calling Telegram', async () => {
    await signIn()
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(false)
    expect(body.connected).toBe(false)
    expect(body.expectedUrl).toBe('https://hearth.han.life/api/telegram')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a value that is not shaped like a bot token, without calling Telegram', async () => {
    await signIn()
    expect((await post({ token: 'not-a-token' })).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined()
  })

  it('refuses a token Telegram rejects, and keeps nothing', async () => {
    await signIn()
    telegramAnswers({ getMe: () => ({ ok: false, description: 'Unauthorized' }) })
    const res = await post({ token: '123456:WRONG' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Unauthorized')
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined()
  })

  it('saves a token Telegram vouches for and reports the bot', async () => {
    await signIn()
    telegramAnswers({
      getMe: () => ({ ok: true, result: { username: 'hearth_bot' } }),
      getWebhookInfo: () => ({ ok: true, result: { url: '' } }),
    })
    const res = await post({ token: '123456:GOOD-token' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.username).toBe('hearth_bot')
    expect(body.connected).toBe(false)
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('123456:GOOD-token')
  })

  it('will not register a webhook before there is a token', async () => {
    await signIn()
    expect((await post({ register: true })).status).toBe(400)
  })

  it('registers the webhook, minting a secret when none is set', async () => {
    await signIn()
    process.env.TELEGRAM_BOT_TOKEN = '123456:GOOD-token'
    let hooked: Record<string, unknown> = {}
    let commands: unknown = null
    telegramAnswers({
      getMe: () => ({ ok: true, result: { username: 'hearth_bot' } }),
      setWebhook: (body) => { hooked = body; return { ok: true } },
      setMyCommands: (body) => { commands = body.commands; return { ok: true } },
      getWebhookInfo: () => ({ ok: true, result: { url: hooked.url ?? '' } }),
    })
    const res = await post({ register: true })
    expect(res.status).toBe(200)
    expect(hooked.url).toBe('https://hearth.han.life/api/telegram')
    expect(hooked.secret_token).toBe(process.env.TELEGRAM_WEBHOOK_SECRET)
    expect(String(hooked.secret_token)).toMatch(/^[0-9a-f]{64}$/)
    // The "/" menu is registered alongside, so commands are discoverable.
    expect((commands as { command: string }[]).map((c) => c.command)).toContain('watch')
    const body = await res.json()
    expect(body.connected).toBe(true)
  })

  it('keeps an existing webhook secret rather than rotating it', async () => {
    await signIn()
    process.env.TELEGRAM_BOT_TOKEN = '123456:GOOD-token'
    process.env.TELEGRAM_WEBHOOK_SECRET = 'kept-secret'
    let hooked: Record<string, unknown> = {}
    telegramAnswers({
      getMe: () => ({ ok: true, result: { username: 'hearth_bot' } }),
      setWebhook: (body) => { hooked = body; return { ok: true } },
      setMyCommands: () => ({ ok: true }),
      getWebhookInfo: () => ({ ok: true, result: { url: hooked.url ?? '' } }),
    })
    expect((await post({ register: true })).status).toBe(200)
    expect(hooked.secret_token).toBe('kept-secret')
    expect(process.env.TELEGRAM_WEBHOOK_SECRET).toBe('kept-secret')
  })

  it('passes Telegram refusing the webhook through as an error', async () => {
    await signIn()
    process.env.TELEGRAM_BOT_TOKEN = '123456:GOOD-token'
    process.env.TELEGRAM_WEBHOOK_SECRET = 's'
    telegramAnswers({
      setWebhook: () => ({ ok: false, description: 'bad webhook: HTTPS url must be provided' }),
    })
    const res = await post({ register: true })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('HTTPS')
  })

  it('reports Telegram being unreachable rather than pretending', async () => {
    await signIn()
    process.env.TELEGRAM_BOT_TOKEN = '123456:GOOD-token'
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const body = await (await GET()).json()
    expect(body.ok).toBe(false)
    expect(String(body.error)).toContain('ECONNREFUSED')
    expect(body.webhook).toBeNull()
    expect(body.connected).toBe(false)
  })

  it('flags a webhook that points somewhere else as not connected', async () => {
    await signIn()
    process.env.TELEGRAM_BOT_TOKEN = '123456:GOOD-token'
    process.env.TELEGRAM_WEBHOOK_SECRET = 's'
    telegramAnswers({
      getMe: () => ({ ok: true, result: { username: 'hearth_bot' } }),
      getWebhookInfo: () => ({ ok: true, result: { url: 'https://old.example.com/api/telegram', pending_update_count: 3 } }),
    })
    const body = await (await GET()).json()
    expect(body.connected).toBe(false)
    expect(body.webhook.url).toBe('https://old.example.com/api/telegram')
    expect(body.webhook.pending).toBe(3)
  })
})
