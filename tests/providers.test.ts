import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const accessTokenFor = vi.hoisted(() => vi.fn(async () => 'tok'))
vi.mock('@/lib/providers/token', async (orig) => ({
  ...(await orig<typeof import('@/lib/providers/token')>()),
  accessTokenFor,
}))

const { googleClient } = await import('@/lib/providers/google')
const { microsoftClient } = await import('@/lib/providers/microsoft')
const { MAX_EVENTS } = await import('@/lib/providers/types')

const fetchMock = vi.fn()

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

/** Google's Calendar MCP server answering one tool call with this content. */
const answer = (content: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: content } }), {
    headers: { 'content-type': 'application/json' },
  })
/** The tool and arguments of one call made to Google's server. */
const toolCall = (i = 0) => {
  const [url, init] = lastCall(i)
  const { params } = JSON.parse(String(init.body)) as { params: { name: string; arguments: Record<string, unknown> } }
  return { url, name: params.name, args: params.arguments }
}

describe('google calendar', () => {
  it("asks Google's Calendar server for one ordered window of the primary calendar", async () => {
    fetchMock.mockResolvedValueOnce(answer({ events: [] }))
    await googleClient(1).listEvents(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'))
    expect(toolCall()).toEqual({
      url: 'https://calendarmcp.googleapis.com/mcp/v1',
      name: 'list_events',
      args: {
        calendarId: 'primary',
        startTime: '2026-09-01T00:00:00.000Z',
        endTime: '2026-09-02T00:00:00.000Z',
        orderBy: 'startTime',
        pageSize: MAX_EVENTS + 1,
      },
    })
  })

  it('normalises timed and all-day events alike', async () => {
    fetchMock.mockResolvedValueOnce(
      answer({
        events: [
          { id: 'a', summary: 'Timed', start: { dateTime: '2026-09-01T09:00:00Z' }, end: { dateTime: '2026-09-01T10:00:00Z' }, organizer: { email: 'o@x.com' } },
          { id: 'b', start: { date: '2026-09-02' }, end: { date: '2026-09-03' } },
        ],
      }),
    )
    const { events } = await googleClient(1).listEvents(new Date(), new Date())
    expect(events[0]).toEqual({ id: 'a', title: 'Timed', start: '2026-09-01T09:00:00Z', end: '2026-09-01T10:00:00Z', allDay: false, location: undefined, organizer: 'o@x.com' })
    expect(events[1]).toMatchObject({ title: '(untitled)', allDay: true, start: '2026-09-02', end: '2026-09-03' })
  })

  it('reads an answer with no events, or none at all, as an empty calendar', async () => {
    fetchMock.mockResolvedValueOnce(answer({}))
    expect(await googleClient(1).listEvents(new Date(), new Date())).toEqual({ events: [], more: false })
    fetchMock.mockResolvedValueOnce(answer(undefined))
    expect(await googleClient(1).listEvents(new Date(), new Date())).toEqual({ events: [], more: false })
  })

  it('follows the page token past a short page, reading to one past the most it lists', async () => {
    const events = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `e${from + i}`, start: { dateTime: '2026-09-01T09:00:00Z' } }))
    fetchMock.mockResolvedValueOnce(answer({ events: events(3), nextPageToken: 'p2' })).mockResolvedValueOnce(answer({ events: events(2, 3) }))
    const short = await googleClient(1).listEvents(new Date(), new Date())
    expect(short.events.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4'])
    expect(short.more).toBe(false)
    expect(toolCall(0).args).not.toHaveProperty('pageToken')
    expect(toolCall(1).args.pageToken).toBe('p2')

    // Exactly the most it lists, and a token onto an empty page: not more.
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(answer({ events: events(MAX_EVENTS), nextPageToken: 'p2' })).mockResolvedValueOnce(answer({ events: [] }))
    expect((await googleClient(1).listEvents(new Date(), new Date())).more).toBe(false)

    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(answer({ events: events(MAX_EVENTS + 1), nextPageToken: 'p2' }))
    const long = await googleClient(1).listEvents(new Date(), new Date())
    expect(long.events).toHaveLength(MAX_EVENTS)
    expect(long.more).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("sends an all-day event as midnight to midnight on the household's dates, not the UTC dates of its midnights", async () => {
    fetchMock.mockResolvedValueOnce(answer({ id: 'x', summary: 'School photos', start: { date: '2026-10-10' }, end: { date: '2026-10-11' } }))
    // Melbourne midnights, as the tool hands them over: 13:00 UTC the day before.
    const created = await googleClient(1).createEvent({
      title: 'School photos', start: new Date('2026-10-09T13:00:00Z'), end: new Date('2026-10-10T13:00:00Z'), allDay: true,
    })
    expect(toolCall().name).toBe('create_event')
    expect(toolCall().args).toMatchObject({
      summary: 'School photos', allDay: true, startTime: '2026-10-10T00:00:00', endTime: '2026-10-11T00:00:00', timeZone: 'Australia/Melbourne',
    })
    expect(created).toMatchObject({ id: 'x', title: 'School photos', allDay: true, start: '2026-10-10' })
  })

  it("sends a timed event as the household's wall clock beside its zone, the way the server asks for one", async () => {
    fetchMock.mockResolvedValueOnce(answer({ id: 'x' }))
    // 9:30 on a Melbourne morning in daylight time, eleven hours ahead of UTC.
    await googleClient(1).createEvent({ title: 'Dentist', start: new Date('2026-10-09T22:30:00Z'), end: new Date('2026-10-09T23:30:00Z') })
    const { args } = toolCall()
    expect(args).toMatchObject({ startTime: '2026-10-10T09:30:00', endTime: '2026-10-10T10:30:00', timeZone: 'Australia/Melbourne' })
    expect(args).not.toHaveProperty('allDay')
    expect(args).not.toHaveProperty('location')
    expect(args).not.toHaveProperty('attendees')
  })

  it('puts guests on the event without emailing them, and carries a place and a note', async () => {
    fetchMock.mockResolvedValueOnce(answer({ id: 'x' }))
    await googleClient(1).createEvent({
      title: 'Meet', start: new Date(), end: new Date(), attendees: ['a@b.com'], location: 'Clinic', description: 'Check-up',
    })
    expect(toolCall().args).toMatchObject({ attendees: [{ email: 'a@b.com' }], notificationLevel: 'NONE', location: 'Clinic', description: 'Check-up' })
  })
})

describe('microsoft graph', () => {
  it('pins calendarView to UTC and marks naive times as UTC', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ value: [{ id: 'e', subject: 'X', start: { dateTime: '2026-09-01T09:00:00.0000000' }, end: { dateTime: '2026-09-01T10:00:00.0000000' } }] }),
    )
    const { events } = await microsoftClient(1).listEvents(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-02T00:00:00Z'))
    expect((lastCall()[1].headers as Record<string, string>).Prefer).toContain('UTC')
    expect(events[0].start).toBe('2026-09-01T09:00:00.0000000Z')
  })

  it('follows the next link with the time zone pinned on every page, and says when the range holds more', async () => {
    const events = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, start: { dateTime: '2026-09-01T09:00:00' } }))
    const next = 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=50'
    fetchMock
      .mockResolvedValueOnce(reply({ value: events(50), '@odata.nextLink': next }))
      .mockResolvedValueOnce(reply({ value: events(30) }))
    const month = await microsoftClient(1).listEvents(new Date(), new Date())
    expect(month).toMatchObject({ more: false })
    expect(month.events).toHaveLength(80)
    expect(lastCall(1)[0]).toBe(next)
    expect((lastCall(1)[1].headers as Record<string, string>).Prefer).toContain('UTC')

    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => reply({ value: events(50), '@odata.nextLink': next }))
    const busy = await microsoftClient(1).listEvents(new Date(), new Date())
    expect(busy.events).toHaveLength(MAX_EVENTS)
    expect(busy.more).toBe(true)
    // Pages of 50 until one past the most it lists, and no further.
    expect(fetchMock).toHaveBeenCalledTimes(Math.floor(MAX_EVENTS / 50) + 1)
  })

  it('leaves an already-offset time untouched', async () => {
    fetchMock.mockResolvedValueOnce(reply({ value: [{ id: 'e', start: { dateTime: '2026-09-01T09:00:00+10:00' }, end: {} }] }))
    const { events } = await microsoftClient(1).listEvents(new Date(), new Date())
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
    await expect(microsoftClient(1).listEvents(new Date(), new Date())).rejects.toThrow(/Graph API 403/)
  })

  it('treats a calendar with no value as empty', async () => {
    fetchMock.mockResolvedValueOnce(reply({}))
    expect(await microsoftClient(1).listEvents(new Date(), new Date())).toEqual({ events: [], more: false })
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
