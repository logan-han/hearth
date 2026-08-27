import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const accessTokenFor = vi.hoisted(() => vi.fn(async () => 'tok'))
vi.mock('@/lib/providers/token', async (orig) => ({
  ...(await orig<typeof import('@/lib/providers/token')>()),
  accessTokenFor,
}))

const { googleClient } = await import('@/lib/providers/google')
const { microsoftClient } = await import('@/lib/providers/microsoft')

const fetchMock = vi.fn()
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

function reply(body: unknown, ok = true, status = 200) {
  return {
    ok, status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  accessTokenFor.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

const lastCall = (i = 0) => fetchMock.mock.calls[i] as [string, RequestInit]

describe('google mail', () => {
  const message = {
    id: 'm1',
    snippet: 'Photo day is coming',
    labelIds: ['UNREAD', 'INBOX'],
    internalDate: '1788000000000',
    payload: {
      headers: [
        { name: 'From', value: 'School <office@school.edu>' },
        { name: 'To', value: 'parent@example.com' },
        { name: 'Subject', value: 'Photo day' },
      ],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('Photos are on Tuesday.') } },
        { mimeType: 'text/html', body: { data: b64url('<p>Photos</p>') } },
      ],
    },
  }

  it('lists by fetching ids then metadata for each', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ messages: [{ id: 'm1' }] }))
      .mockResolvedValueOnce(reply(message))
    const out = await googleClient(1).listMail({ limit: 5 })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'm1', subject: 'Photo day', unread: true })
    expect(out[0].from).toBe('School <office@school.edu>')
    expect(new Date(out[0].date).toISOString()).toBe('2026-08-29T10:40:00.000Z')
  })

  it('defaults to recent inbox mail and caps the page size', async () => {
    fetchMock.mockResolvedValueOnce(reply({ messages: [] }))
    await googleClient(1).listMail({ limit: 100 })
    const url = new URL(lastCall()[0])
    expect(url.searchParams.get('q')).toBe('in:inbox newer_than:14d')
    expect(url.searchParams.get('maxResults')).toBe('25')
  })

  it('keeps a search inside the inbox by default', async () => {
    fetchMock.mockResolvedValueOnce(reply({ messages: [] }))
    await googleClient(1).listMail({ query: 'from:school' })
    expect(new URL(lastCall()[0]).searchParams.get('q')).toBe('in:inbox from:school')
  })

  it('spans the whole mailbox on scope all, with sent mail kept out', async () => {
    fetchMock.mockResolvedValueOnce(reply({ messages: [] }))
    await googleClient(1).listMail({ query: 'from:school', scope: 'all' })
    expect(new URL(lastCall()[0]).searchParams.get('q')).toBe('from:school -in:sent -in:chats')
  })

  it('copes with an empty mailbox', async () => {
    fetchMock.mockResolvedValueOnce(reply({}))
    expect(await googleClient(1).listMail({})).toEqual([])
  })

  it('prefers the plain text part when reading a body', async () => {
    fetchMock.mockResolvedValueOnce(reply(message))
    const body = await googleClient(1).readMail('m1')
    expect(body.body).toBe('Photos are on Tuesday.')
  })

  it('falls back to stripping html when there is no plain part', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        ...message,
        payload: {
          ...message.payload,
          parts: [
            { mimeType: 'text/html', body: { data: b64url('<style>x{}</style><p>Hello  there</p>') } },
          ],
        },
      }),
    )
    expect((await googleClient(1).readMail('m1')).body).toBe('Hello there')
  })

  it('builds a valid RFC 822 message when sending', async () => {
    fetchMock.mockResolvedValueOnce(reply({}))
    await googleClient(1).sendMail({ to: ['a@b.com'], cc: ['c@d.com'], subject: 'Hi', body: 'Body' })
    const raw = JSON.parse(String(lastCall()[1].body)).raw
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toContain('To: a@b.com')
    expect(decoded).toContain('Cc: c@d.com')
    expect(decoded).toContain('Subject: Hi')
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(decoded.split('\r\n\r\n')[1].trim()).toBe(Buffer.from('Body').toString('base64'))
  })

  it('encodes a non-ASCII subject as an RFC 2047 word', async () => {
    fetchMock.mockResolvedValueOnce(reply({}))
    await googleClient(1).sendMail({ to: ['a@b.com'], subject: 'Café ☕', body: 'x' })
    const decoded = Buffer.from(JSON.parse(String(lastCall()[1].body)).raw, 'base64url').toString('utf8')
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/)
  })

  it('omits the Cc header when there is none', async () => {
    fetchMock.mockResolvedValueOnce(reply({}))
    await googleClient(1).sendMail({ to: ['a@b.com'], subject: 's', body: 'b' })
    const decoded = Buffer.from(JSON.parse(String(lastCall()[1].body)).raw, 'base64url').toString('utf8')
    expect(decoded).not.toContain('Cc:')
  })

  it('surfaces an API error with its status', async () => {
    fetchMock.mockResolvedValueOnce(reply('quota exceeded', false, 429))
    await expect(googleClient(1).listMail({})).rejects.toThrow(/Google API 429/)
  })
})

describe('google calendar', () => {
  it('asks for a single expanded ordered window', async () => {
    fetchMock.mockResolvedValueOnce(reply({ items: [] }))
    await googleClient(1).listEvents(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'))
    const url = new URL(lastCall()[0])
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(url.searchParams.get('orderBy')).toBe('startTime')
    expect(url.searchParams.get('timeMin')).toBe('2026-09-01T00:00:00.000Z')
  })

  it('normalises timed and all-day events alike', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        items: [
          { id: 'a', summary: 'Timed', start: { dateTime: '2026-09-01T09:00:00Z' }, end: { dateTime: '2026-09-01T10:00:00Z' } },
          { id: 'b', start: { date: '2026-09-02' }, end: { date: '2026-09-03' } },
        ],
      }),
    )
    const events = await googleClient(1).listEvents(new Date(), new Date())
    expect(events[0]).toMatchObject({ title: 'Timed', allDay: false })
    expect(events[1]).toMatchObject({ title: '(untitled)', allDay: true, start: '2026-09-02' })
  })

  it('sends a date-only payload for an all-day event', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: 'x', summary: 'Trip' }))
    await googleClient(1).createEvent({
      title: 'Trip', start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-02T00:00:00Z'), allDay: true,
    })
    const sent = JSON.parse(String(lastCall()[1].body))
    expect(sent.start).toEqual({ date: '2026-09-01' })
    expect(sent.end.dateTime).toBeUndefined()
  })

  it('sends attendees as objects', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: 'x' }))
    await googleClient(1).createEvent({
      title: 'Meet', start: new Date(), end: new Date(), attendees: ['a@b.com'],
    })
    expect(JSON.parse(String(lastCall()[1].body)).attendees).toEqual([{ email: 'a@b.com' }])
  })
})

describe('microsoft graph', () => {
  const graphMessage = {
    id: 'g1',
    subject: 'Sports day',
    bodyPreview: 'Sports day is Friday',
    isRead: false,
    receivedDateTime: '2026-09-01T04:00:00Z',
    from: { emailAddress: { name: 'School', address: 'office@school.edu' } },
    toRecipients: [{ emailAddress: { address: 'parent@example.com' } }],
    body: { contentType: 'html', content: '<style>a{}</style><p>Sports&nbsp;day</p>' },
  }

  it('orders by date when there is no search term, reading the inbox folder', async () => {
    fetchMock.mockResolvedValueOnce(reply({ value: [graphMessage] }))
    const out = await microsoftClient(1).listMail({})
    expect(String(lastCall()[0])).toContain('/mailFolders/inbox/messages')
    expect(new URL(lastCall()[0]).searchParams.get('$orderby')).toBe('receivedDateTime desc')
    expect(out[0]).toMatchObject({ subject: 'Sports day', unread: true })
    expect(out[0].from).toBe('School <office@school.edu>')
  })

  it('switches to $search and drops the ordering, which Graph forbids together', async () => {
    fetchMock.mockResolvedValueOnce(reply({ value: [] }))
    await microsoftClient(1).listMail({ query: 'sports"', scope: 'all' })
    const url = new URL(lastCall()[0])
    expect(String(url)).toContain('/me/messages')
    expect(url.searchParams.get('$search')).toBe('"sports"')
    expect(url.searchParams.get('$orderby')).toBeNull()
    expect((lastCall()[1].headers as Record<string, string>).ConsistencyLevel).toBe('eventual')
  })

  it('strips html when reading a body', async () => {
    fetchMock.mockResolvedValueOnce(reply(graphMessage))
    expect((await microsoftClient(1).readMail('g1')).body).toBe('Sports day')
  })

  it('leaves a plain text body alone', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ...graphMessage, body: { contentType: 'text', content: 'plain' } }))
    expect((await microsoftClient(1).readMail('g1')).body).toBe('plain')
  })

  it('uses an address alone when there is no distinct name', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ value: [{ ...graphMessage, from: { emailAddress: { name: 'a@b.com', address: 'a@b.com' } } }] }),
    )
    expect((await microsoftClient(1).listMail({}))[0].from).toBe('a@b.com')
  })

  it('wraps a send in the shape Graph expects', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' })
    await microsoftClient(1).sendMail({ to: ['a@b.com'], cc: ['c@d.com'], subject: 's', body: 'b' })
    const sent = JSON.parse(String(lastCall()[1].body))
    expect(sent.message.toRecipients).toEqual([{ emailAddress: { address: 'a@b.com' } }])
    expect(sent.message.ccRecipients).toEqual([{ emailAddress: { address: 'c@d.com' } }])
    expect(sent.saveToSentItems).toBe(true)
  })

  it('pins calendarView to UTC and marks naive times as UTC', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ value: [{ id: 'e', subject: 'X', start: { dateTime: '2026-09-01T09:00:00.0000000' }, end: { dateTime: '2026-09-01T10:00:00.0000000' } }] }),
    )
    const events = await microsoftClient(1).listEvents(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'))
    expect((lastCall()[1].headers as Record<string, string>).Prefer).toContain('UTC')
    expect(events[0].start).toBe('2026-09-01T09:00:00.0000000Z')
  })

  it('leaves an already-offset time untouched', async () => {
    fetchMock.mockResolvedValueOnce(reply({ value: [{ id: 'e', start: { dateTime: '2026-09-01T09:00:00+10:00' }, end: {} }] }))
    const events = await microsoftClient(1).listEvents(new Date(), new Date())
    expect(events[0].start).toBe('2026-09-01T09:00:00+10:00')
  })

  it('strips the Z when creating, since it sends timeZone separately', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: 'e' }))
    await microsoftClient(1).createEvent({ title: 'T', start: new Date('2026-09-01T09:00:00Z'), end: new Date('2026-09-01T10:00:00Z') })
    const sent = JSON.parse(String(lastCall()[1].body))
    expect(sent.start).toEqual({ dateTime: '2026-09-01T09:00:00.000', timeZone: 'UTC' })
  })

  it('surfaces a Graph error with its status', async () => {
    fetchMock.mockResolvedValueOnce(reply('forbidden', false, 403))
    await expect(microsoftClient(1).listMail({})).rejects.toThrow(/Graph API 403/)
  })
})
