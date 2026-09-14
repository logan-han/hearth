import { describe, it, expect } from 'vitest'
import { toTelegramHtml } from '@/lib/telegram-format'

describe('toTelegramHtml', () => {
  it('turns standard markdown emphasis into telegram html', () => {
    expect(toTelegramHtml('**hello** and *soft* and __still bold__ and ~~gone~~')).toBe(
      '<b>hello</b> and <i>soft</i> and <b>still bold</b> and <s>gone</s>',
    )
  })

  it('leaves snake_case identifiers and arithmetic alone', () => {
    expect(toTelegramHtml('set preferred_username to 2*3*4')).toBe('set preferred_username to 2*3*4')
  })

  it('escapes html outside code and inside it', () => {
    expect(toTelegramHtml('run `a < b` on <tag>')).toBe('run <code>a &lt; b</code> on &lt;tag&gt;')
  })

  it('keeps markdown inside code literal', () => {
    expect(toTelegramHtml('the string `**not bold**` stays')).toBe(
      'the string <code>**not bold**</code> stays',
    )
  })

  it('renders fenced code as pre, dropping the language tag', () => {
    expect(toTelegramHtml('```js\nconst a = 1 < 2\n```')).toBe('<pre>const a = 1 &lt; 2</pre>')
  })

  it('turns links into anchors, underscores in the url intact', () => {
    expect(toTelegramHtml('[Up](https://up.com.au/a_b)')).toBe('<a href="https://up.com.au/a_b">Up</a>')
  })

  it('bolds headings, bullets bullets, and drops rules', () => {
    expect(toTelegramHtml('# Plan\n- milk\n* bread\n---')).toBe('<b>Plan</b>\n• milk\n• bread\n')
  })

  it('does not let code sentinels eat numbers in prose', () => {
    expect(toTelegramHtml('dinner at 7 pm, `x` at 9')).toBe('dinner at 7 pm, <code>x</code> at 9')
  })

  it('handles the bot notice shape', () => {
    expect(toTelegramHtml('Added to the family calendar: **Footy Fever** — Mon 21 Sept')).toBe(
      'Added to the family calendar: <b>Footy Fever</b> — Mon 21 Sept',
    )
  })

  it('leaves unpaired markers untouched rather than corrupting the text', () => {
    expect(toTelegramHtml('a *broken _markdown')).toBe('a *broken _markdown')
  })

  it('turns a run of quoted lines into one blockquote, with the emphasis inside it converted', () => {
    expect(toTelegramHtml('Spend by category:\n> **Kids** $42.75\n> Housing $826.41\nDone.')).toBe(
      'Spend by category:\n<blockquote><b>Kids</b> $42.75\nHousing $826.41</blockquote>\nDone.',
    )
  })

  it('folds a long quote, so a snapshot reads as a card with its detail tucked away', () => {
    expect(toTelegramHtml('> one\n> two\n> three\n> four')).toBe('<blockquote expandable>one\ntwo\nthree\nfour</blockquote>')
  })

  it('keeps a bullet inside a quote a bullet', () => {
    expect(toTelegramHtml('> - milk\n> - bread')).toBe('<blockquote>• milk\n• bread</blockquote>')
  })

  it('leaves a greater-than sign that is not at the start of a line alone', () => {
    expect(toTelegramHtml('5 > 3 and > so on')).toBe('5 &gt; 3 and &gt; so on')
  })

  it('lays a pipe table out as an aligned monospace block, figures on the right', () => {
    const md = ['| Category | Spend |', '|---|---:|', '| **Kids** | $42.75 |', '| Housing | $826.41 |'].join('\n')
    expect(toTelegramHtml(md)).toBe('<pre>Category    Spend\nKids       $42.75\nHousing   $826.41</pre>')
  })

  it('escapes a table cell and keeps the text around a table', () => {
    expect(toTelegramHtml('Before\n| a<b | n |\n|---|---|\n| `x` | 1 |\nAfter')).toBe(
      'Before\n<pre>a&lt;b  n\nx    1</pre>\nAfter',
    )
  })
})
