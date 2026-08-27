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

})
