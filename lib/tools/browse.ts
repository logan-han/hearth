import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './context'
import { decodeEntities, stripBlocks, stripTags } from '../html'
import { describeError } from '../errors'

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

/**
 * The bot fetches URLs out of family chat; it must never reach inward. A name
 * is judged by every address it resolves to, since the fetch may use any of
 * them: a public name pointed at 127.0.0.1 is as private as 127.0.0.1. The
 * fetch resolves the name again to connect, so one whose answer changes in
 * between (DNS rebinding) is beyond this check.
 */
async function readable(url: URL): Promise<boolean> {
  if (!/^https?:$/.test(url.protocol)) return false
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)) return false
  if (isIP(host)) return !inward(host)
  return (await lookup(host, { all: true })).every((a) => !inward(a.address))
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
    if (!(await readable(url))) {
      return { error: hop === 0 ? 'Only public http(s) addresses can be read.' : 'That address redirected somewhere private.' }
    }
    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Hearth family assistant)' },
    })
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
 * `base` is the page's address after redirects, and relative links come out
 * whole against it: the model opens a link as it reads it, and once a page
 * has been read, read_url opens only a link that appears as written.
 */
export function htmlToText(html: string, base?: string): string {
  const laidOut = stripBlocks(html)
    // Keep hrefs beside their labels, so the next link can be followed too.
    .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, raw: string, label: string) => {
      const text = stripTags(label).replace(/\s+/g, ' ').trim()
      const href = resolved(raw, base)
      return text ? ` ${text} [${href}] ` : ` [${href}] `
    })
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, '\n')

  return decodeEntities(stripTags(laidOut))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/**
 * A page whose text is thin, or whose markup is full of client-side template
 * machinery, has not really been read yet — the content arrives by JavaScript.
 */
export function looksLikeShell(raw: string, text: string): boolean {
  if (text.replace(/\[[^\]]*\]/g, '').trim().length < 600) return true
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

async function renderViaTavily(url: string): Promise<string | null> {
  const key = process.env.TAVILY_API_KEY
  if (!key) return null
  const res = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls: [url], extract_depth: 'advanced' }),
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
          const buf = await res.arrayBuffer()
          if (buf.byteLength > MAX_BYTES) return { error: 'That file is too large to read here.' }

          if (type.includes('pdf') || target.pathname.toLowerCase().endsWith('.pdf')) {
            const { extractText } = await import('unpdf')
            const { text, totalPages } = await extractText(new Uint8Array(buf), { mergePages: true })
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
          const reason = describeError(e)
          if (reason.includes('ENOTFOUND')) return { error: 'That address could not be found.' }
          return { error: reason.includes('timeout') || reason.includes('timed out') ? 'The page took too long to answer.' : reason }
        }
      },
    }),
  }
}
