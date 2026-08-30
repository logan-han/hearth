/**
 * Turning markup into text happens in three places — a browsed page and two
 * mail providers — and each one has to get the same edge cases right: a
 * `</script >` end tag a naive pattern walks straight past, a tag that only
 * becomes visible once the tag wrapped around it is removed, and an `&amp;lt;`
 * that a second decoding pass would take all the way down to `<`.
 */

/** Script and style bodies, tolerating `</script >` and a missing end tag. */
const BLOCK = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi
const COMMENT = /<!--[\s\S]*?-->/g
const TAG = /<[^>]*>/g

/** Removing markup can expose more of it, so keep going until nothing changes. */
function untilStable(s: string, strip: (s: string) => string): string {
  let out = s
  for (let previous = ''; out !== previous; ) {
    previous = out
    out = strip(out)
  }
  return out
}

/** Drop the parts of a document that are machinery rather than text. */
export function stripBlocks(html: string): string {
  return untilStable(html, (s) => s.replace(BLOCK, ' ').replace(COMMENT, ' '))
}

export function stripTags(html: string): string {
  return untilStable(html, (s) => s.replace(TAG, ' '))
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** One pass over the whole string, so `&amp;lt;` decodes to `&lt;` and stops. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (_, body: string) => {
    if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? ' '
    const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1))
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
  })
}

/** Markup in, one run of readable text out. */
export function htmlToPlainText(html: string): string {
  return decodeEntities(stripTags(stripBlocks(html))).replace(/\s+/g, ' ').trim()
}
