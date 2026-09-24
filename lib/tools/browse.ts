import { lookup } from 'node:dns/promises'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import type { Agent } from 'undici'
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './context'
import { decodeEntities, stripBlocks, stripTags } from '../html'
import { describeError } from '../errors'
import { deadline } from '../deadline'

/**
 * Following links is what separates "the email mentions a form" from actually
 * knowing what the form says. Direct fetch first (free, fast, and it reads
 * PDFs); when a page turns out to be a JavaScript shell with no content,
 * Tavily's extractor renders it as a fallback.
 */

const MAX_BYTES = 3 * 1024 * 1024
const MAX_CHARS = 9000
const MAX_REDIRECTS = 5

/**
 * Where the bot must never reach, whatever name led there: loopback, the
 * private ranges, link-local (cloud metadata lives at 169.254.169.254),
 * carrier-grade NAT, multicast and the reserved blocks. An IPv4 address
 * written as IPv6 (::ffff:127.0.0.1) is checked against the IPv4 rules.
 */
const INWARD = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) INWARD.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) INWARD.addSubnet(net, bits, 'ipv6')

const inward = (address: string) => INWARD.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')

/** How a connection refuses a name that leads inward. */
class InwardAddressError extends Error {}

/**
 * A name is judged by every address it resolves to, since the connection may
 * use any of them: a public name pointed at 127.0.0.1 is as private as
 * 127.0.0.1. The judging is done in the connection's own lookup, so the answer
 * checked is the answer dialled. A lookup of our own ahead of the fetch left
 * the name free to answer differently the second time (DNS rebinding).
 */
export const lookupPublic: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }).then(
    (addresses) => {
      if (addresses.some((a) => inward(a.address))) callback(new InwardAddressError(`${hostname} leads to a private address`), '')
      else if (options.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    },
    (err: NodeJS.ErrnoException) => callback(err, ''),
  )
}

// Made on first use: the library behind it takes a while to load, and most turns read no link.
let publicOnly: Promise<Agent> | undefined
const publicConnections = () => (publicOnly ??= import('undici').then(({ Agent }) => new Agent({ connect: { lookup: lookupPublic } })))

/**
 * The bot fetches URLs out of family chat; it must never reach inward. An
 * address written into the URL is judged here, and a name as the connection
 * resolves it.
 */
function readable(url: URL): boolean {
  if (!/^https?:$/.test(url.protocol)) return false
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)) return false
  return !isIP(host) || !inward(host)
}

/**
 * Redirects are followed by hand so each hop is checked before it is
 * requested: with redirect 'follow', a public link that bounces to a private
 * address has been fetched by the time the final URL can be looked at.
 */
async function fetchPublic(start: URL): Promise<{ res: Response; url: URL } | { error: string }> {
  const signal = AbortSignal.timeout(12_000)
  let url = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const refusal = hop === 0 ? 'Only public http(s) addresses can be read.' : 'That address redirected somewhere private.'
    if (!readable(url)) return { error: refusal }
    // Node's fetch takes a dispatcher, which the DOM's RequestInit has no word for.
    const init: RequestInit & { dispatcher: Agent } = {
      redirect: 'manual',
      signal,
      dispatcher: await publicConnections(),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Hearth family assistant)' },
    }
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (e) {
      if (e instanceof Error && e.cause instanceof InwardAddressError) return { error: refusal }
      throw e
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!location) return { res, url }
    await res.body?.cancel()
    url = new URL(location, url)
  }
  return { error: 'That address redirected too many times.' }
}

/** A link as the page means it, read against `base`; one that will not parse is left as written. */
function resolved(href: string, base?: string): string {
  if (!base) return href
  try {
    return new URL(href, base).href
  } catch {
    return href
  }
}

/**
 * Keep hrefs beside their labels, so the next link can be followed too. The
 * tags are found one at a time and paired here: a single pattern spanning the
 * whole link read on to the end of the page from every link left unclosed.
 */
function inlineLinks(html: string, base?: string): string {
  let out = ''
  let copied = 0
  let open: { at: number; end: number; href: string } | null = null
  for (const m of html.matchAll(/<a\s[^<>]*>|<\/a\s*>/gi)) {
    if (m[0][1] !== '/') {
      const raw: string | undefined = open ? undefined : /\shref="([^"#][^"]*)"/i.exec(m[0])?.[1]
      if (raw) open = { at: m.index, end: m.index + m[0].length, href: resolved(raw, base) }
    } else if (open) {
      const text = stripTags(html.slice(open.end, m.index)).replace(/\s+/g, ' ').trim()
      out += html.slice(copied, open.at) + (text ? ` ${text} [${open.href}] ` : ` [${open.href}] `)
      copied = m.index + m[0].length
      open = null
    }
  }
  return out + html.slice(copied)
}

/**
 * `base` is the page's address after redirects, and relative links come out
 * whole against it: the model opens a link as it reads it, and once a page
 * has been read, read_url opens only a link that appears as written.
 *
 * Each step reads the page in one pass, for the reason lib/html.ts gives: a
 * line break tag is looked for only up to the next `<`, and lines are trimmed
 * one at a time, where a pattern would reread a long run of spaces from each
 * space in it.
 */
export function htmlToText(html: string, base?: string): string {
  const laidOut = inlineLinks(stripBlocks(html), base).replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^<>]*>/gi, '\n')

  return decodeEntities(stripTags(laidOut))
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * A page whose text is thin, or whose markup is full of client-side template
 * machinery, has not really been read yet — the content arrives by JavaScript.
 */
export function looksLikeShell(raw: string, text: string): boolean {
  if (text.replace(/\[[^[\]]*\]/g, '').trim().length < 600) return true
  const markers =
    (raw.match(/\bng-[a-z]/g)?.length ?? 0) +
    (raw.match(/\{\{/g)?.length ?? 0) +
    (raw.match(/\bv-(?:if|for|cloak|show)\b/g)?.length ?? 0)
  if (markers >= 5 || /id="(?:app|root)"/.test(raw)) return true
  // A page that is mostly hidden template blocks with barely any visible text
  // is a form waiting for its data, whatever framework built it.
  const hidden = raw.match(/display:\s*none/g)?.length ?? 0
  return hidden >= 8 && text.length < raw.length * 0.15
}

/**
 * The body, or null when it is larger than can be read. It is read a piece at
 * a time and dropped once past the limit, so a link to a video is not held in
 * memory whole before being refused; a declared length over it is refused
 * before anything is read.
 */
async function readBody(res: Response): Promise<Uint8Array | null> {
  if (Number(res.headers.get('content-length')) > MAX_BYTES) {
    await res.body?.cancel()
    return null
  }
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  // A plain Uint8Array rather than the Buffer concat makes: the PDF reader refuses a Buffer.
  return new Uint8Array(Buffer.concat(chunks, size))
}

async function renderViaTavily(url: string): Promise<string | null> {
  const key = process.env.TAVILY_API_KEY
  if (!key) return null
  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls: [url], extract_depth: 'advanced' }),
    // An advanced extract is given 30 seconds on Tavily's side before it gives up.
    signal: deadline(35_000),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { results?: { raw_content?: string }[] }
  return data.results?.[0]?.raw_content ?? null
}

export function browseTools(_ctx: ToolContext) {
  return {
    read_url: tool({
      description:
        'Open a link and read it: web pages and PDFs both work. Use this whenever a message, email or page points ' +
        'somewhere, instead of guessing what is behind the link. ' +
        'Links found on the page come back beside their text in [brackets], so follow-up links can be read too. ' +
        'If the text comes back as empty form labels or placeholders rather than real content, call again with render: true.',
      inputSchema: z.object({
        url: z.string().describe('The full http(s) address to read'),
        render: z
          .boolean()
          .default(false)
          .describe('Force full rendering: set when a first read returned bare templates or placeholders instead of content'),
      }),
      execute: async ({ url, render }) => {
        let target: URL
        try {
          target = new URL(url)
        } catch {
          return { error: `"${url}" is not a valid address.` }
        }

        try {
          const fetched = await fetchPublic(target)
          if ('error' in fetched) return fetched
          const { res } = fetched
          const at = fetched.url.href
          if (!res.ok) return { error: `The page answered ${res.status}.` }

          const type = res.headers.get('content-type') ?? ''
          const buf = await readBody(res)
          if (!buf) return { error: 'That file is too large to read here.' }

          if (type.includes('pdf') || target.pathname.toLowerCase().endsWith('.pdf')) {
            const { extractText } = await import('unpdf')
            const { text, totalPages } = await extractText(buf, { mergePages: true })
            return { url: at, kind: 'pdf', pages: totalPages, text: text.slice(0, MAX_CHARS) }
          }

          const raw = new TextDecoder().decode(buf)
          if (type.includes('html') || /^\s*</.test(raw)) {
            const text = htmlToText(raw, at)
            if (render || looksLikeShell(raw, text)) {
              const rendered = await renderViaTavily(at)
              if (rendered && rendered.trim().length > text.length) {
                return { url: at, kind: 'page', rendered: true, text: rendered.slice(0, MAX_CHARS) }
              }
              return {
                url: at,
                kind: 'page',
                text: text.slice(0, MAX_CHARS),
                note:
                  'This page builds its content in the browser and could not be fully rendered here, so this may be templates rather than content. Say so rather than guessing at what it holds.',
              }
            }
            return { url: at, kind: 'page', text: text.slice(0, MAX_CHARS) }
          }

          return { url: at, kind: type.split(';')[0] || 'file', text: raw.slice(0, MAX_CHARS) }
        } catch (e) {
          // What went wrong on the connection, a name not found say, is the cause of fetch's own error.
          const reason = describeError(e instanceof Error && e.cause instanceof Error ? e.cause : e)
          if (reason.includes('ENOTFOUND')) return { error: 'That address could not be found.' }
          return { error: reason.includes('timeout') || reason.includes('timed out') ? 'The page took too long to answer.' : reason }
        }
      },
    }),
  }
}
