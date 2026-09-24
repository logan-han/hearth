import { describe, it, expect } from 'vitest'
import { decodeEntities, stripBlocks, stripTags, htmlToPlainText } from '@/lib/html'

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('&lt;a&gt; &amp; &quot;q&quot; &apos;s&apos;&nbsp;x')).toBe('<a> & "q" \'s\'\u00a0x')
    expect(decodeEntities('&#65;&#x42;&#X43;')).toBe('ABC')
  })

  it('decodes in one pass, so a double-encoded string stops at the first layer', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
  })

  it('turns an unknown name or an impossible code point into a space', () => {
    expect(decodeEntities('a&wormhole;b')).toBe('a b')
    expect(decodeEntities('a&#0;b')).toBe('a b')
    expect(decodeEntities('a&#1114112;b')).toBe('a b')
  })
})

describe('stripping markup', () => {
  it('removes script and style bodies, even with a spaced end tag or none at all', () => {
    expect(stripBlocks('a<script>x()</script >b<style>p{}</style>c')).toBe('a b c')
    expect(stripBlocks('a<script>never closed')).toBe('a ')
    expect(stripBlocks('a<!-- note -->b')).toBe('a b')
  })

  it('lets a tag hidden inside a comment come out once the comment is gone', () => {
    expect(htmlToPlainText('a<<!-- x -->b>c')).toBe('a c')
    expect(stripTags('a <b>b</b> c')).toBe('a  b  c')
  })

  it('reads a document down to one run of text', () => {
    expect(htmlToPlainText('<style>x{}</style><p>Hello&nbsp;&amp;\n  <b>there</b></p>')).toBe('Hello & there')
  })

  it('lets a style or a comment left open run to the end, as a browser reads it', () => {
    expect(stripBlocks('a<style never closed')).toBe('a ')
    expect(stripBlocks('a<!-- never closed')).toBe('a ')
  })

  it('keeps a stray < after the last tag as the text it is', () => {
    expect(htmlToPlainText('<p>Ages</p> 3 < 5')).toBe('Ages 3 < 5')
  })

  it('reads a crafted message in one pass, however much of its markup is left open', () => {
    // Each of these took minutes at a megabyte, when a pattern that failed was
    // tried again from every later '<' and read on to the end each time.
    for (const bait of ['<style ', '<', '<!--']) {
      const started = performance.now()
      htmlToPlainText(bait.repeat(1_000_000 / bait.length))
      expect(performance.now() - started, bait).toBeLessThan(1000)
    }
  })
})
