import { describe, it, expect } from 'vitest'
import { plainData } from '@/lib/plain-data'

describe('plainData', () => {
  it('writes a mail sweep as indented lines, with a quoted subject and sender verbatim', () => {
    const out = plainData({
      mail: {
        accounts: [
          {
            member: 'Rowan', mailbox: "Rowan's Gmail", provider: 'google', first_check: false,
            messages: [{
              id: 'm1', from: 'Sign Desk <no-reply@signdesk.example>', subject: 'Signature requested on "Lease renewal - 12 Elm Street"',
              snippet: 'Please sign by Friday.', date: '2026-09-18T22:10:00.000Z',
            }],
          },
        ],
      },
    })
    expect(out).toBe([
      'mail:',
      '  accounts:',
      '    - member: Rowan',
      "      mailbox: Rowan's Gmail",
      '      provider: google',
      '      first_check: false',
      '      messages:',
      '        - id: m1',
      '          from: Sign Desk <no-reply@signdesk.example>',
      '          subject: Signature requested on "Lease renewal - 12 Elm Street"',
      '          snippet: Please sign by Friday.',
      '          date: 2026-09-18T22:10:00.000Z',
    ].join('\n'))
    expect(out).not.toContain('\\"')
    expect(out).not.toContain('{')
  })

  it('says (none) for an empty list, an empty object, a null and an empty string', () => {
    expect(plainData({ flags: [], location: null, notes: {}, message: '' })).toBe(
      'flags: (none)\nlocation: (none)\nnotes: (none)\nmessage: (none)',
    )
    expect(plainData([])).toBe('(none)')
    expect(plainData({})).toBe('(none)')
    expect(plainData(null)).toBe('(none)')
  })

  it('continues a value of several lines under its key, indented', () => {
    expect(plainData({ snippet: 'Dear families,\nthe carnival is on Thursday.', next: 1 })).toBe(
      'snippet: Dear families,\n  the carnival is on Thursday.\nnext: 1',
    )
  })

  it('lists scalars behind dashes and nests a list in a list', () => {
    expect(plainData({ days: ['Mon', 'Tue'], grid: [[1, 2], [3]] })).toBe(
      'days:\n  - Mon\n  - Tue\ngrid:\n  - - 1\n    - 2\n  - - 3',
    )
    expect(plainData(['a\nb', 'c'])).toBe('- a\n  b\n- c')
  })

  it('keeps numbers and booleans as written, dates as ISO, and drops what is undefined', () => {
    expect(plainData({ count: 3, ok: true, at: new Date('2026-09-19T00:00:00Z'), gone: undefined })).toBe(
      'count: 3\nok: true\nat: 2026-09-19T00:00:00.000Z',
    )
    expect(plainData('just text')).toBe('just text')
    expect(plainData([{}])).toBe('- (none)')
  })
})
