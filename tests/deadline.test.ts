import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The mailbox clients ask this for their token; what is under test is the request after it.
vi.mock('@/lib/providers/token', async (orig) => ({
  ...(await orig<typeof import('@/lib/providers/token')>()),
  accessTokenFor: vi.fn(async () => 'tok'),
}))

const { deadline, UnconfirmedError } = await import('@/lib/deadline')
const { accessTokenFor } = await import('@/lib/providers/token')
const { googleClient } = await import('@/lib/providers/google')
const { microsoftClient } = await import('@/lib/providers/microsoft')
const jira = await import('@/lib/providers/jira')
const notion = await import('@/lib/providers/notion')
const pocketsmith = await import('@/lib/providers/pocketsmith')
const up = await import('@/lib/providers/up')
const weather = await import('@/lib/providers/weather')
const { refreshAccessToken } = await import('@/lib/oauth/providers')
const { searchTools } = await import('@/lib/tools/search')

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response('{}'))
  Object.assign(process.env, {
    APP_URL: 'https://hearth.example',
    JIRA_BASE_URL: 'https://example.atlassian.net',
    JIRA_EMAIL: 'rowan@hearth.example',
    JIRA_API_TOKEN: 'token',
    NOTION_TOKEN: 'secret',
    POCKETSMITH_DEVELOPER_KEY: 'key',
    UP_API_TOKEN: 'up',
    OPENWEATHER_API_KEY: 'owm',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    TAVILY_API_KEY: 'tvly',
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('deadline', () => {
  it('gives a request twenty seconds unless told otherwise', () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    deadline()
    deadline(35_000)
    expect(timeout.mock.calls).toEqual([[20_000], [35_000]])
  })

  const requests: [string, () => Promise<unknown>][] = [
    ['Gmail', () => googleClient(1).listMail({})],
    ['Microsoft Graph', () => microsoftClient(1).listMail({})],
    ['Jira', () => jira.searchIssues('project = HTL')],
    ['a Jira upload', () => jira.attachFile('HTL-1', { filename: 'a.txt', mimeType: 'text/plain', bytes: new Uint8Array(1) })],
    ['Notion', () => notion.search({ query: 'rates' })],
    ['PocketSmith', () => pocketsmith.listAccounts()],
    ['Up', () => up.listAccounts()],
    ['OpenWeatherMap', () => weather.geocode('Melbourne')],
    ['a token refresh', () => refreshAccessToken('google', 'refresh')],
    ['a web search', () => (searchTools.web_search.execute as (a: unknown, o: unknown) => Promise<unknown>)({ query: 'rates', depth: 'basic' }, {})],
  ]

  it.each(requests)('is on every request to %s, so a service that never answers cannot hold the turn', async (_, request) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    // Only that the request went out with its deadline matters here, not what came back.
    await request().catch(() => {})
    expect(fetchMock).toHaveBeenCalled()
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(timeout.mock.results[0].value)
  })
})

describe('a write that runs out of time', () => {
  const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const draft = { to: ['a@b.com'], subject: 's', body: 'b' }
  const event = { title: 'Dentist', start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-10-01T01:00:00Z') }

  const writes: [string, () => Promise<unknown>][] = [
    ['a Gmail send', () => googleClient(1).sendMail(draft)],
    ['a Graph send', () => microsoftClient(1).sendMail(draft)],
    ['a Google event', () => googleClient(1).createEvent(event)],
    ['a Graph event', () => microsoftClient(1).createEvent(event)],
    ['a new Jira issue', () => jira.createIssue({ projectKey: 'HTL', summary: 'Rates' })],
    ['a Jira comment', () => jira.addComment('HTL-1', 'Paid')],
    ['a Jira upload', () => jira.attachFile('HTL-1', { filename: 'a.txt', mimeType: 'text/plain', bytes: new Uint8Array(1) })],
    ['a Notion append', () => notion.appendToPage('p1', 'milk')],
  ]

  it.each(writes)('is unconfirmed for %s, since the service may have acted on it', async (_, write) => {
    fetchMock.mockRejectedValue(timedOut())
    await expect(write()).rejects.toBeInstanceOf(UnconfirmedError)
  })

  it('stays a plain timeout when it is the token that ran out, before anything was sent', async () => {
    vi.mocked(accessTokenFor).mockRejectedValueOnce(timedOut()).mockRejectedValueOnce(timedOut())
    for (const write of [() => googleClient(1).sendMail(draft), () => microsoftClient(1).createEvent(event)]) {
      const err = await write().catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(UnconfirmedError)
      expect((err as Error).name).toBe('TimeoutError')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves any other failure as it was', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    const err = await jira.addComment('HTL-1', 'Paid').catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(UnconfirmedError)
    expect(String(err)).toContain('Jira API 500')
  })
})
