import { describe, it, expect } from 'vitest'
import { describeError } from '@/lib/errors'

describe('describeError', () => {
  it('takes the message off an Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError(new TypeError('typed'))).toBe('typed')
  })

  it('stringifies anything else that was thrown', () => {
    expect(describeError('plain string')).toBe('plain string')
    expect(describeError(42)).toBe('42')
    expect(describeError({ code: 'E' })).toBe('[object Object]')
    expect(describeError(undefined)).toBe('undefined')
  })
})
