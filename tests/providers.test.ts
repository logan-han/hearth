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

  it('hands a quoted display name back bare, as Graph does', async () => {
    const quoted = {
      ...message,
      payload: {
        ...message.payload,
        headers: [
          { name: 'From', value: '"Hillside Grammar, Office" <office@hillsidegrammar.example>' },
          { name: 'To', value: '"Rowan \\"Ro\\" Fixture" <rowan@hearth.example>, other@hearth.example' },
          { name: 'Subject', value: 'Photo day' },
        ],
      },
    }
    fetchMock.mockResolvedValueOnce(reply({ messages: [{ id: 'm1' }] })).mockResolvedValueOnce(reply(quoted))
    const [m] = await googleClient(1).listMail({ limit: 5 })
    expect(m.from).toBe('Hillside Grammar, Office <office@hillsidegrammar.example>')
    expect(m.to).toBe('Rowan "Ro" Fixture <rowan@hearth.example>, other@hearth.example')
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

  const withPdf = {
    ...message,
    payload: {
      ...message.payload,
      mimeType: 'multipart/mixed',
      parts: [
        ...message.payload.parts,
        { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }], body: { attachmentId: 'logo', size: 10 } },
        { mimeType: 'application/pdf', filename: 'Renewal.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="Renewal.pdf"' }], body: { attachmentId: 'ANGjdJ_long_id', size: 1234 } },
      ],
    },
  }

  it('lists the files attached to a message, leaving an inline logo out', async () => {
    fetchMock.mockResolvedValueOnce(reply(withPdf))
    const m = await googleClient(1).readMail('m1')
    expect(m.attachments).toEqual([{ filename: 'Renewal.pdf', mimeType: 'application/pdf', size: 1234 }])
    expect(m.body).toBe('Photos are on Tuesday.')
  })

  it('keeps a part marked inline as a real attachment when its type is not declared, since it cannot be confirmed as a picture', async () => {
    const withInlineUnknown = {
      ...message,
      payload: {
        ...message.payload,
        mimeType: 'multipart/mixed',
        parts: [
          ...message.payload.parts,
          { filename: 'mystery', headers: [{ name: 'Content-Disposition', value: 'inline; filename="mystery"' }], body: { attachmentId: 'myst1' } },
        ],
      },
    }
    fetchMock.mockResolvedValueOnce(reply(withInlineUnknown))
    const m = await googleClient(1).readMail('m1')
    expect(m.attachments).toEqual([{ filename: 'mystery', mimeType: 'application/octet-stream', size: 0 }])
  })

  it('fetches an attachment by its filename, whatever its case, and decodes the web-safe base64', async () => {
    fetchMock.mockResolvedValueOnce(reply(withPdf)).mockResolvedValueOnce(reply({ size: 4, data: b64url('%PDF') }))
    const f = await googleClient(1).readAttachment('m1', 'renewal.PDF')
    expect(String(lastCall(1)[0])).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/ANGjdJ_long_id')
    expect(f).toMatchObject({ filename: 'Renewal.pdf', mimeType: 'application/pdf', size: 4 })
    expect(new TextDecoder().decode(f.bytes)).toBe('%PDF')
  })

  it('fills in sensible defaults for a sparse attachment with no disposition, type or size', async () => {
    const sparse = {
      ...message,
      payload: {
        ...message.payload,
        mimeType: 'multipart/mixed',
        parts: [...message.payload.parts, { filename: 'note.txt', body: { attachmentId: 'att1' } }],
      },
    }
    fetchMock.mockResolvedValueOnce(reply(sparse))
    const m = await googleClient(1).readMail('m1')
    expect(m.attachments).toEqual([{ filename: 'note.txt', mimeType: 'application/octet-stream', size: 0 }])

    fetchMock.mockResolvedValueOnce(reply(sparse)).mockResolvedValueOnce(reply({}))
    const f = await googleClient(1).readAttachment('m1', 'note.txt')
    expect(f.bytes).toHaveLength(0)
  })

  it('says when there is no attachment by that name, without fetching anything else', async () => {
    fetchMock.mockResolvedValueOnce(reply(withPdf))
    await expect(googleClient(1).readAttachment('m1', 'invoice.pdf')).rejects.toThrow(/No attachment called "invoice.pdf"/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

  it('reads a bare message without inventing headers, and a body-less one as empty', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: 'bare' }))
    const m = await googleClient(1).readMail('bare')
    expect(m).toEqual({ id: 'bare', from: '', to: '', subject: '(no subject)', snippet: '', date: '', unread: false, body: '', attachments: [] })
  })

  it('skips parts with no data and decodes a lone html part', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        id: 'x',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [{ mimeType: 'text/plain' }, { mimeType: 'text/plain', body: { data: b64url('second wins') } }],
        },
      }),
    )
    expect((await googleClient(1).readMail('x')).body).toBe('second wins')

    fetchMock.mockResolvedValueOnce(reply({ id: 'y', payload: { mimeType: 'text/html', body: { data: b64url('<i>only</i> html') } } }))
    expect((await googleClient(1).readMail('y')).body).toBe('only html')

    fetchMock.mockResolvedValueOnce(reply({ id: 'z', payload: { mimeType: 'text/html' } }))
    expect((await googleClient(1).readMail('z')).body).toBe('')
  })

  it('defaults a whole-mailbox listing to recent mail when there is no search term', async () => {
    fetchMock.mockResolvedValueOnce(reply({ messages: [] }))
    await googleClient(1).listMail({ scope: 'all' })
    expect(new URL(lastCall()[0]).searchParams.get('q')).toBe('newer_than:14d -in:sent -in:chats')
  })

  it('treats a 204 from a send as success, and an empty calendar as no events', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => { throw new Error('no body') }, text: async () => '' })
    expect(await googleClient(1).sendMail({ to: ['a@b.com'], subject: 's', body: 'b' })).toEqual({ ok: true })
    fetchMock.mockResolvedValueOnce(reply({}))
    expect(await googleClient(1).listEvents(new Date(), new Date())).toEqual([])
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

  it('sends an all-day event as the household\'s dates, not the UTC dates of its midnights', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: 'x', summary: 'School photos' }))
    // Melbourne midnights, as the tool hands them over: 13:00 UTC the day before.
    await googleClient(1).createEvent({
      title: 'School photos', start: new Date('2026-10-09T13:00:00Z'), end: new Date('2026-10-10T13:00:00Z'), allDay: true,
    })
    const sent = JSON.parse(String(lastCall()[1].body))
    expect(sent.start).toEqual({ date: '2026-10-10' })
    expect(sent.end).toEqual({ date: '2026-10-11' })
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
    subject: 'Athletics carnival',
    bodyPreview: 'Athletics carnival is Friday',
    isRead: false,
    receivedDateTime: '2026-09-01T04:00:00Z',
    from: { emailAddress: { name: 'School', address: 'office@school.edu' } },
    toRecipients: [{ emailAddress: { address: 'parent@example.com' } }],
    body: { contentType: 'html', content: '<style>a{}</style><p>Athletics&nbsp;carnival</p>' },
  }

  it('orders by date when there is no search term, reading the inbox folder', async () => {
    fetchMock.mockResolvedValueOnce(reply({ value: [graphMessage] }))
    const out = await microsoftClient(1).listMail({})
    expect(String(lastCall()[0])).toContain('/mailFolders/inbox/messages')
    expect(new URL(lastCall()[0]).searchParams.get('$orderby')).toBe('receivedDateTime desc')
    expect(out[0]).toMatchObject({ subject: 'Athletics carnival', unread: true })
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
    expect((await microsoftClient(1).readMail('g1')).body).toBe('Athletics carnival')
  })

  it('leaves a plain text body alone', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ...graphMessage, body: { contentType: 'text', content: 'plain' } }))
    expect((await microsoftClient(1).readMail('g1')).body).toBe('plain')
  })

  it('reads a message with no attachments in one call', async () => {
    fetchMock.mockResolvedValueOnce(reply(graphMessage))
    expect((await microsoftClient(1).readMail('g1')).attachments).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lists attachments only when the message says it has some, leaving inline pictures and linked items out', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ...graphMessage, hasAttachments: true })).mockResolvedValueOnce(
      reply({
        value: [
          { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'Renewal.pdf', contentType: 'application/pdf', size: 1234, isInline: false },
          { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a2', name: 'logo.png', contentType: 'image/png', size: 10, isInline: true },
          { '@odata.type': '#microsoft.graph.itemAttachment', id: 'a3', name: 'Fwd: a message', size: 99 },
        ],
      }),
    )
    const m = await microsoftClient(1).readMail('g1')
    expect(m.attachments).toEqual([{ filename: 'Renewal.pdf', mimeType: 'application/pdf', size: 1234 }])
    expect(decodeURIComponent(String(lastCall(1)[0]))).toContain('/messages/g1/attachments?$select=id,name,contentType,size,isInline')
  })

  it('fetches an attachment by name and decodes its bytes', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ value: [{ id: 'a1', name: 'Renewal.pdf', contentType: 'application/pdf', size: 4 }] }))
      .mockResolvedValueOnce(reply({ id: 'a1', name: 'Renewal.pdf', contentType: 'application/pdf', size: 4, contentBytes: Buffer.from('%PDF').toString('base64') }))
    const f = await microsoftClient(1).readAttachment('g1', 'renewal.pdf')
    expect(String(lastCall(1)[0])).toBe('https://graph.microsoft.com/v1.0/me/messages/g1/attachments/a1')
    expect(f).toMatchObject({ filename: 'Renewal.pdf', mimeType: 'application/pdf', size: 4 })
    expect(new TextDecoder().decode(f.bytes)).toBe('%PDF')
  })

  it('fills in sensible defaults for a sparse attachment with no name, type or size', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ ...graphMessage, hasAttachments: true }))
      .mockResolvedValueOnce(reply({ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', isInline: false }] }))
    const m = await microsoftClient(1).readMail('g1')
    expect(m.attachments).toEqual([{ filename: 'attachment', mimeType: 'application/octet-stream', size: 0 }])
  })

  it('treats a listing with no value field as no attachments at all', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ...graphMessage, hasAttachments: true })).mockResolvedValueOnce(reply({}))
    expect((await microsoftClient(1).readMail('g1')).attachments).toEqual([])
  })

  it('says when there is no attachment by that name, even one with no name of its own', async () => {
    fetchMock.mockResolvedValueOnce(reply({ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', isInline: false }] }))
    await expect(microsoftClient(1).readAttachment('g1', 'missing.pdf')).rejects.toThrow(/No attachment called "missing.pdf"/)
  })

  it('treats a fetched attachment with no content as empty bytes', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ value: [{ id: 'a1', name: 'blank.txt' }] }))
      .mockResolvedValueOnce(reply({ id: 'a1', name: 'blank.txt' }))
    const f = await microsoftClient(1).readAttachment('g1', 'blank.txt')
    expect(f.bytes).toHaveLength(0)
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

  it('reads a bare message without inventing fields', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: 'bare' }))
    const m = await microsoftClient(1).readMail('bare')
    expect(m).toEqual({ id: 'bare', from: '', to: '', subject: '(no subject)', snippet: '', date: '', unread: false, body: '', attachments: [] })
  })

  it('shows a name alone when the address is missing, and drops recipients with neither', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({
        value: [{
          ...graphMessage,
          from: { emailAddress: { name: 'Only Name' } },
          toRecipients: [{ emailAddress: { address: 'a@b.com' } }, { emailAddress: {} }, {}],
        }],
      }),
    )
    const [m] = await microsoftClient(1).listMail({})
    expect(m.from).toBe('Only Name')
    expect(m.to).toBe('a@b.com')
  })

  it('treats a listing or calendar with no value as empty', async () => {
    fetchMock.mockResolvedValueOnce(reply({}))
    expect(await microsoftClient(1).listMail({})).toEqual([])
    fetchMock.mockResolvedValueOnce(reply({}))
    expect(await microsoftClient(1).listEvents(new Date(), new Date())).toEqual([])
  })

  it('sends no cc recipients when there is no cc', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}), text: async () => '' })
    await microsoftClient(1).sendMail({ to: ['a@b.com'], subject: 's', body: 'b' })
    expect(JSON.parse(String(lastCall()[1].body)).message.ccRecipients).toEqual([])
  })

  it('passes a description and location through when creating an event', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: 'e', subject: 'Dentist', location: { displayName: 'Clinic' } }))
    const created = await microsoftClient(1).createEvent({
      title: 'Dentist', description: 'Check-up', location: 'Clinic',
      start: new Date('2026-09-01T09:00:00Z'), end: new Date('2026-09-01T10:00:00Z'), allDay: false,
    })
    const sent = JSON.parse(String(lastCall()[1].body))
    expect(sent.body).toEqual({ contentType: 'Text', content: 'Check-up' })
    expect(sent.location).toEqual({ displayName: 'Clinic' })
    expect(created).toMatchObject({ title: 'Dentist', location: 'Clinic' })
  })

  it('sends an all-day event as midnight to midnight in the household\'s zone, which is all Graph accepts', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: 'e', subject: 'Camp' }))
    await microsoftClient(1).createEvent({
      title: 'Camp', start: new Date('2026-09-24T14:00:00Z'), end: new Date('2026-09-27T14:00:00Z'), allDay: true,
    })
    const sent = JSON.parse(String(lastCall()[1].body))
    expect(sent.isAllDay).toBe(true)
    expect(sent.start).toEqual({ dateTime: '2026-09-25T00:00:00', timeZone: 'Australia/Melbourne' })
    expect(sent.end).toEqual({ dateTime: '2026-09-28T00:00:00', timeZone: 'Australia/Melbourne' })
  })

  it('sends attendees as required participants', async () => {
    fetchMock.mockResolvedValueOnce(reply({ id: 'e' }))
    await microsoftClient(1).createEvent({
      title: 'Trip', start: new Date('2026-09-01T09:00:00Z'), end: new Date('2026-09-01T10:00:00Z'), attendees: ['a@b.com'],
    })
    const sent = JSON.parse(String(lastCall()[1].body))
    expect(sent.attendees).toEqual([{ emailAddress: { address: 'a@b.com' }, type: 'required' }])
  })
})
