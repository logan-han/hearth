import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ToolContext } from '@/lib/tools/context'

const extractText = vi.hoisted(() => vi.fn())
vi.mock('unpdf', () => ({ extractText }))

const { browseTools, htmlToText } = await import('@/lib/tools/browse')

const fetchMock = vi.fn()
const ctx: ToolContext = { chatId: '-1', member: null, memberName: 'Rowan', now: new Date(), notices: [] }
const read = (url: string) =>
  (browseTools(ctx).read_url.execute as unknown as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)({ url }, {})

const page = (html: string, type = 'text/html', url = 'https://school.example/x') => ({
  ok: true,
  status: 200,
  url,
  headers: new Headers({ 'content-type': type }),
  arrayBuffer: async () => new TextEncoder().encode(html).buffer,
})

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  extractText.mockReset()
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

  it('refuses private addresses outright', async () => {
    for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://192.168.1.10/x', 'http://169.254.169.254/meta']) {
      expect(String((await read(url)).error)).toContain('public')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a redirect that lands somewhere private', async () => {
    fetchMock.mockResolvedValue(page('<p>hi</p>', 'text/html', 'http://192.168.1.5/admin'))
    expect(String((await read('https://bit.example/short')).error)).toContain('private')
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
      return page('<div id="app"></div>', 'text/html', 'https://spa.example/r/abc')
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
        : page('<div id="app"></div>', 'text/html', 'https://spa.example/r/abc'),
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
        : page('<div id="app"></div>', 'text/html', 'https://spa.example/r/abc'),
    )
    const r = await read('https://spa.example/r/abc')
    expect(r.rendered).toBeUndefined()
    expect(String(r.note)).toContain('builds its content in the browser')
  })

  it('reports an http failure as such', async () => {
    fetchMock.mockResolvedValue({ ...page(''), ok: false, status: 404 })
    expect(String((await read('https://school.example/gone')).error)).toContain('404')
  })

  it('refuses a malformed address before attempting a fetch', async () => {
    expect(String((await read('not a url at all')).error)).toContain('not a valid address')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to a generic file kind, naming it from the content type when there is one', async () => {
    fetchMock.mockResolvedValueOnce(page('a,b,c', 'text/csv', 'https://example.com/data.csv'))
    const withType = await read('https://example.com/data.csv')
    expect(withType.kind).toBe('text/csv')

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: 'https://example.com/data',
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode('a,b,c').buffer,
    })
    const noType = await read('https://example.com/data')
    expect(noType.kind).toBe('file')
  })

  it('refuses a file bigger than the read limit', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://example.com/huge.bin',
      headers: new Headers({ 'content-type': 'application/octet-stream' }),
      arrayBuffer: async () => new ArrayBuffer(3 * 1024 * 1024 + 1),
    })
    expect(String((await read('https://example.com/huge.bin')).error)).toContain('too large')
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
