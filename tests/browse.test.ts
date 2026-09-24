import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ToolContext } from '@/lib/tools/context'

const extractText = vi.hoisted(() => vi.fn())
vi.mock('unpdf', () => ({ extractText }))
const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))

const { browseTools, htmlToText, looksLikeShell, lookupPublic } = await import('@/lib/tools/browse')

/** Node's own fetch, for the tests that go as far as a connection. */
const realFetch = globalThis.fetch
const fetchMock = vi.fn()
const ctx: ToolContext = { chatId: '-1', member: null, memberName: 'Rowan', now: new Date(), notices: [] }
const read = (url: string) =>
  (browseTools(ctx).read_url.execute as unknown as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)({ url }, {})

const page = (html: string, type = 'text/html') => new Response(html, { status: 200, headers: { 'content-type': type } })
const moved = (location: string, status = 302, extra: object = {}) => ({ ok: false, status, url: '', headers: new Headers({ location }), ...extra })
const resolvesTo = (address: string) => [{ address, family: address.includes(':') ? 6 : 4 }]

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  extractText.mockReset()
  // A documentation address stands in for any public host.
  lookup.mockReset()
  lookup.mockResolvedValue(resolvesTo('203.0.113.10'))
  delete process.env.TAVILY_API_KEY
})
afterEach(() => vi.unstubAllGlobals())

describe('htmlToText', () => {
  it('keeps links beside their labels so the next hop is followable', () => {
    const text = htmlToText('<p>See the <a href="https://x.test/info.pdf">invitation</a> here.</p>')
    expect(text).toContain('invitation [https://x.test/info.pdf]')
  })

  it('drops scripts, styles and tags', () => {
    const text = htmlToText('<style>.a{}</style><script>evil()</script><h1>Athletics Carnival</h1><p>7:30 am start</p>')
    expect(text).toContain('Athletics Carnival')
    expect(text).toContain('7:30 am start')
    expect(text).not.toContain('evil')
  })

  it('drops a script whose end tag is padded or missing altogether', () => {
    expect(htmlToText('<p>Notice</p><script >evil()</script >tail')).not.toContain('evil')
    expect(htmlToText('<p>Notice</p><script>evil()')).not.toContain('evil')
  })

  it('strips tags that only appear once their wrapper is gone', () => {
    expect(htmlToText('<p>Athletics <<b>i>Carnival</p>')).not.toContain('<')
  })

  it('decodes entities once, so escaped markup stays escaped', () => {
    expect(htmlToText('<p>Tom &amp;amp; Jerry &amp;lt;script&amp;gt;</p>')).toBe('Tom &amp; Jerry &lt;script&gt;')
  })

  it('keeps a bare link even when its label is empty', () => {
    const text = htmlToText('<p>Look <a href="https://x.test/blank"></a> there</p>')
    expect(text).toContain('[https://x.test/blank]')
  })

  it('reads an anchor with no href as its text, and a link left unclosed as its text too', () => {
    expect(htmlToText('<a name="top">Top</a> <a href="https://x.test/next">Next</a>')).toBe('Top Next [https://x.test/next]')
    expect(htmlToText('<p>See <a href="https://x.test/form">the form')).toBe('See the form')
  })

  it('reads a crafted page in one pass, however much of its markup is left open', () => {
    // Each of these took from seconds to hours at a megabyte, when every open
    // tag, or every space in a run, read on to the end of the page again.
    for (const bait of ['<a href="x" ', '<a href="x">', '<br', '\r', '&nbsp;']) {
      const started = performance.now()
      htmlToText(bait.repeat(1_000_000 / bait.length))
      expect(performance.now() - started, bait).toBeLessThan(1000)
    }
    const started = performance.now()
    looksLikeShell('', '['.repeat(1_000_000))
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('read_url', () => {
  it('reads a page and hands back its text and links', async () => {
    fetchMock.mockResolvedValue(page(`<html><body><h1>Father's Day Breakfast</h1>${'<p>Details of the morning and what to bring along for everyone attending.</p>'.repeat(12)}<a href="https://x.test/info.pdf">Invitation PDF</a></body></html>`))
    const r = await read('https://school.example/x')
    expect(r.kind).toBe('page')
    expect(String(r.text)).toContain("Father's Day Breakfast")
    expect(String(r.text)).toContain('[https://x.test/info.pdf]')
  })

  it('reads a PDF through the extractor', async () => {
    fetchMock.mockResolvedValue(page('%PDF-1.7 …', 'application/pdf'))
    extractText.mockResolvedValue({ text: 'Gates open 7:15am. One guest per family.', totalPages: 2 })
    const r = await read('https://school.example/info.pdf')
    expect(r).toMatchObject({ kind: 'pdf', pages: 2 })
    expect(String(r.text)).toContain('One guest per family')
  })

  it('refuses private addresses outright, however they are written', async () => {
    for (const url of [
      'http://localhost/x', 'http://127.0.0.1/x', 'http://192.168.1.10/x', 'http://169.254.169.254/meta',
      'http://2130706433/x', 'http://[::1]/x', 'http://[::ffff:127.0.0.1]/x', 'http://[fd00::1]/x', 'http://[fe80::1]/x',
      'http://100.64.0.1/x', 'http://printer.local/x', 'http://metadata.google.internal/x', 'ftp://files.example/x',
    ]) {
      expect(String((await read(url)).error), url).toContain('public')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses a public name that resolves inward, even beside a public address', async () => {
    lookup.mockResolvedValue([...resolvesTo('203.0.113.10'), ...resolvesTo('::ffff:10.0.0.5')])
    fetchMock.mockImplementation(realFetch)
    expect(String((await read('https://sneaky.example/x')).error)).toContain('public')
    expect(lookup).toHaveBeenCalledWith('sneaky.example', expect.objectContaining({ all: true }))
  })

  it('judges a name by the answer the connection dials, so the name cannot answer one way and connect another', async () => {
    // A service on this machine, where a rebinding name would point the bot.
    let reached = 0
    const inside = createServer((_, res) => {
      reached++
      res.end('inside')
    })
    await new Promise<void>((listening) => inside.listen(0, '127.0.0.1', listening))
    lookup.mockResolvedValue(resolvesTo('127.0.0.1'))
    fetchMock.mockImplementation(realFetch)
    try {
      const r = await read(`http://rebind.example:${(inside.address() as AddressInfo).port}/x`)
      expect(r.error).toBe('Only public http(s) addresses can be read.')
      // The request was made, and its connection looked the name up and stopped.
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(lookup).toHaveBeenCalledWith('rebind.example', expect.objectContaining({ all: true }))
      expect(reached).toBe(0)
    } finally {
      inside.close()
    }
  })

  it('answers a connection that wants one address with the first, and one that wants them all with every one', async () => {
    const both = [...resolvesTo('203.0.113.10'), ...resolvesTo('2001:db8::1')]
    lookup.mockResolvedValue(both)
    const ask = (options: object) =>
      new Promise((answered) => lookupPublic('school.example', options, (err, address, family) => answered({ err, address, family })))
    expect(await ask({ family: 0 })).toEqual({ err: null, address: '203.0.113.10', family: 4 })
    expect(await ask({ all: true })).toEqual({ err: null, address: both, family: undefined })
  })

  it('never requests a redirect hop that is private, by address or by what its name resolves to', async () => {
    lookup.mockImplementation(async (host: string) => resolvesTo(host === 'intranet.example' ? '10.1.2.3' : '203.0.113.10'))
    for (const location of ['http://192.168.1.5/admin', 'https://intranet.example/admin']) {
      fetchMock.mockReset()
      // The first hop is answered here; the next goes as far as a real connection.
      fetchMock.mockResolvedValueOnce(moved(location)).mockImplementation(realFetch)
      expect(String((await read('https://bit.example/short')).error)).toBe('That address redirected somewhere private.')
    }
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith('intranet.example', expect.objectContaining({ all: true }))
  })

  it('follows public redirects one hop at a time, relative ones included, and says where it landed', async () => {
    const cancel = vi.fn(async () => {})
    fetchMock
      .mockResolvedValueOnce(moved('https://news.example/letter', 301, { body: { cancel } }))
      .mockResolvedValueOnce(moved('/letter/final'))
      .mockResolvedValueOnce(page('<p>Newsletter</p>'))
    const r = await read('https://bit.example/short')
    expect(r.url).toBe('https://news.example/letter/final')
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
      'https://bit.example/short', 'https://news.example/letter', 'https://news.example/letter/final',
    ])
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
    expect(cancel).toHaveBeenCalled()
  })

  it('gives up on redirects that never land anywhere', async () => {
    fetchMock.mockImplementation(async () => moved('/again'))
    expect(String((await read('https://loop.example/start')).error)).toBe('That address redirected too many times.')
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('says so when the name does not exist', async () => {
    lookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example'), { code: 'ENOTFOUND' }))
    fetchMock.mockImplementation(realFetch)
    expect(String((await read('https://nowhere.example/x')).error)).toBe('That address could not be found.')
  })

  it('spots a template-heavy form shell even when its labels add up to real text', async () => {
    const { looksLikeShell } = await import('@/lib/tools/browse')
    const block = '<div style="display:none"><p>Student name</p><p>Slip due date</p><p>Submit Response</p></div>'
    const raw = `<html><body>${block.repeat(25)}${'<div class="template-scaffolding" data-bind="slip"></div>'.repeat(400)}</body></html>`
    const { htmlToText: strip } = await import('@/lib/tools/browse')
    expect(looksLikeShell(raw, strip(raw))).toBe(true)
  })

  it('flags a shell by its scaffolding id even when the visible text is long enough on its own', async () => {
    const { looksLikeShell } = await import('@/lib/tools/browse')
    const raw = `<div id="root">${'<p>Plenty of real looking paragraph text goes here to pad things out nicely.</p>'.repeat(10)}</div>`
    expect(looksLikeShell(raw, htmlToText(raw))).toBe(true)
  })

  it('flags a JavaScript shell instead of pretending it read it', async () => {
    fetchMock.mockResolvedValue(page('<div id="app"><script>boot()</script></div>'))
    const r = await read('https://spa.example/r/abc')
    expect(String(r.note)).toContain('builds its content in the browser')
  })

  it('falls back to the rendering service for a shell when a key exists', async () => {
    process.env.TAVILY_API_KEY = 'tvly'
    fetchMock.mockImplementation(async (u: unknown) => {
      if (String(u).includes('tavily')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ raw_content: 'Breakfast is on Friday 5 September at 7:30 am in the Junior Schools.' }] }) }
      }
      return page('<div id="app"></div>')
    })
    const r = await read('https://spa.example/r/abc')
    expect(r.rendered).toBe(true)
    expect(String(r.text)).toContain('Junior Schools')
  })

  it('falls back to the shell note when the renderer itself fails', async () => {
    process.env.TAVILY_API_KEY = 'tvly'
    fetchMock.mockImplementation(async (u: unknown) =>
      String(u).includes('tavily')
        ? { ok: false, status: 500, text: async () => 'tavily down' }
        : page('<div id="app"></div>'),
    )
    const r = await read('https://spa.example/r/abc')
    expect(r.rendered).toBeUndefined()
    expect(String(r.note)).toContain('builds its content in the browser')
  })

  it('falls back to the shell note when the renderer returns nothing usable', async () => {
    process.env.TAVILY_API_KEY = 'tvly'
    fetchMock.mockImplementation(async (u: unknown) =>
      String(u).includes('tavily')
        ? { ok: true, status: 200, json: async () => ({ results: [] }) }
        : page('<div id="app"></div>'),
    )
    const r = await read('https://spa.example/r/abc')
    expect(r.rendered).toBeUndefined()
    expect(String(r.note)).toContain('builds its content in the browser')
  })

  it('reports an http failure as such', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    expect(String((await read('https://school.example/gone')).error)).toContain('404')
  })

  it('refuses a malformed address before attempting a fetch', async () => {
    expect(String((await read('not a url at all')).error)).toContain('not a valid address')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to a generic file kind, naming it from the content type when there is one', async () => {
    fetchMock.mockResolvedValueOnce(page('a,b,c', 'text/csv'))
    const withType = await read('https://example.com/data.csv')
    expect(withType.kind).toBe('text/csv')

    // Bytes, unlike a string, give the response no content type of their own.
    fetchMock.mockResolvedValueOnce(new Response(new TextEncoder().encode('a,b,c')))
    const noType = await read('https://example.com/data')
    expect(noType).toMatchObject({ kind: 'file', text: 'a,b,c' })

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), body: null })
    expect(await read('https://example.com/empty')).toMatchObject({ kind: 'file', text: '' })
  })

  it('refuses a file bigger than the read limit', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(3 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/octet-stream' } }))
    expect(String((await read('https://example.com/huge.bin')).error)).toContain('too large')
  })

  /** A body that never ends, counting what was taken from it and whether it was let go. */
  const endless = () => {
    const source = { taken: 0, cancel: vi.fn() }
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        source.taken += 64 * 1024
        controller.enqueue(new Uint8Array(64 * 1024))
      },
      cancel: source.cancel,
    })
    return { source, stream }
  }

  it('refuses a body that declares itself over the limit without reading it', async () => {
    const { source, stream } = endless()
    fetchMock.mockResolvedValue(new Response(stream, { headers: { 'content-type': 'video/mp4', 'content-length': String(700 * 1024 * 1024) } }))
    expect(String((await read('https://example.com/film.mp4')).error)).toContain('too large')
    expect(source.cancel).toHaveBeenCalled()
    // What the stream buffers of its own accord when it is made, and no more.
    expect(source.taken).toBeLessThanOrEqual(64 * 1024)
  })

  it('stops reading a body once it runs past the limit, however long it would go on', async () => {
    const { source, stream } = endless()
    fetchMock.mockResolvedValue(new Response(stream, { headers: { 'content-type': 'application/octet-stream' } }))
    expect(String((await read('https://example.com/stream')).error)).toContain('too large')
    expect(source.cancel).toHaveBeenCalled()
    expect(source.taken).toBeLessThan(4 * 1024 * 1024)
  })

  it('reports a timeout in plain language', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'))
    expect(String((await read('https://slow.example/x')).error)).toBe('The page took too long to answer.')
  })

  it('passes through any other fetch failure as is', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    expect(String((await read('https://down.example/x')).error)).toBe('fetch failed')
  })
})
