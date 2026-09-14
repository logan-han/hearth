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
})
