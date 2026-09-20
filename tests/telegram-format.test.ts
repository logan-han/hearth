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

  it('lays a pipe table out as aligned monospace lines, figures on the right, with no code box', () => {
    const md = ['| Category | Spend |', '|---|---:|', '| **Kids** | $42.75 |', '| Housing | $826.41 |'].join('\n')
    expect(toTelegramHtml(md)).toBe('<code>Category    Spend</code>\n<code>Kids       $42.75</code>\n<code>Housing   $826.41</code>')
    expect(toTelegramHtml(md)).not.toContain('<pre>')
  })

  it('keeps a table of totals with one row as a table, its figures under their headers', () => {
    const md = ['| Spent this week | Budget used |', '| --- | --- |', '| $5,621.56 | 171% |'].join('\n')
    expect(toTelegramHtml(md)).toBe('<code>Spent this week  Budget used</code>\n<code>      $5,621.56         171%</code>')
  })

  it('escapes a table cell, strips code in one, and keeps the text around a table', () => {
    expect(toTelegramHtml('Before\n| a<b | n |\n|---|---|\n| `x` | 1 |\nAfter')).toBe(
      'Before\n<code>a&lt;b  n</code>\n<code>x    1</code>\nAfter',
    )
  })

  it('leaves the words in a table out of the emphasis and bullet passes', () => {
    expect(toTelegramHtml('| Item | Amount |\n|---|---|\n| - a_b * c | 1 |')).toBe('<code>Item       Amount</code>\n<code>- a_b * c       1</code>')
  })

  it('renders a header-only table as one monospace line, and an empty table as nothing', () => {
    expect(toTelegramHtml('| a | b |\n|---|---|')).toBe('<code>a  b</code>')
    expect(toTelegramHtml('x\n| | |\n|---|---|\ny')).toBe('x\ny')
  })

  it('drops an empty header row and still lines a figures column up on the right', () => {
    const md = ['| | |', '|---|---|', '| This week | $1,842.10 |', '| Budget used | 115% |', '| Month elapsed | 20 of 30 days |'].join('\n')
    expect(toTelegramHtml(md)).toBe(
      '<code>This week          $1,842.10</code>\n<code>Budget used             115%</code>\n<code>Month elapsed  20 of 30 days</code>',
    )
  })

  it('does not right-align a column of names that happen to start with digits in the header', () => {
    expect(toTelegramHtml('| 2Up | Amount |\n|---|---|\n| Costco | $5.00 |')).toBe('<code>2Up     Amount</code>\n<code>Costco   $5.00</code>')
  })
})
