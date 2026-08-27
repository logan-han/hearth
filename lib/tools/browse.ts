import { tool } from 'ai'
import { z } from 'zod'
import type { ToolContext } from './context'

/**
 * Following links is what separates "the email mentions a form" from actually
 * knowing what the form says. Direct fetch first (free, fast, and it reads
 * PDFs); when a page turns out to be a JavaScript shell with no content,
 * Tavily's extractor renders it as a fallback.
 */

const MAX_BYTES = 3 * 1024 * 1024
const MAX_CHARS = 9000

/** The bot fetches URLs out of family chat; it must never reach inward. */
function blockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true
  return /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(h)
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Keep hrefs beside their labels, so the next link can be followed too.
    .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return text ? ` ${text} [${href}] ` : ` [${href}] `
    })
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, ' ')
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
        if (!/^https?:$/.test(target.protocol) || blockedHost(target.hostname)) {
          return { error: 'Only public http(s) addresses can be read.' }
        }

        try {
          const res = await fetch(target, {
            redirect: 'follow',
            signal: AbortSignal.timeout(12_000),
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; Hearth family assistant)' },
          })
          if (blockedHost(new URL(res.url).hostname)) {
            return { error: 'That address redirected somewhere private.' }
          }
          if (!res.ok) return { error: `The page answered ${res.status}.` }

          const type = res.headers.get('content-type') ?? ''
          const buf = await res.arrayBuffer()
          if (buf.byteLength > MAX_BYTES) return { error: 'That file is too large to read here.' }

          if (type.includes('pdf') || target.pathname.toLowerCase().endsWith('.pdf')) {
            const { extractText } = await import('unpdf')
            const { text, totalPages } = await extractText(new Uint8Array(buf), { mergePages: true })
            return { url: res.url, kind: 'pdf', pages: totalPages, text: text.slice(0, MAX_CHARS) }
          }

          const raw = new TextDecoder().decode(buf)
          if (type.includes('html') || /^\s*</.test(raw)) {
            const text = htmlToText(raw)
            if (render || looksLikeShell(raw, text)) {
              const rendered = await renderViaTavily(res.url)
              if (rendered && rendered.trim().length > text.length) {
                return { url: res.url, kind: 'page', rendered: true, text: rendered.slice(0, MAX_CHARS) }
              }
              return {
                url: res.url,
                kind: 'page',
                text: text.slice(0, MAX_CHARS),
                note:
                  'This page builds its content in the browser and could not be fully rendered here, so this may be templates rather than content. Say so rather than guessing at what it holds.',
              }
            }
            return { url: res.url, kind: 'page', text: text.slice(0, MAX_CHARS) }
          }

          return { url: res.url, kind: type.split(';')[0] || 'file', text: raw.slice(0, MAX_CHARS) }
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e)
          return { error: reason.includes('timeout') || reason.includes('timed out') ? 'The page took too long to answer.' : reason }
        }
      },
    }),
  }
}
