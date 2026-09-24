import { describe, it, expect } from 'vitest'
import { flagTransactions, payeeKey } from '@/lib/money-flags'
import type { UpTransaction } from '@/lib/providers/up'

const txn = (id: string, amount: number, createdAt: string, description = 'Coles'): UpTransaction => ({
  id, description, message: null, amount, currency: 'AUD', status: 'SETTLED', createdAt, settledAt: createdAt,
  category: null, parentCategory: null, performedBy: null, accountId: 'joint', transferAccountId: null,
})

/** A fortnight of ordinary groceries and coffees, so the account has a normal. */
const history = Array.from({ length: 14 }, (_, i) =>
  txn(`h${i}`, i % 2 ? -12.5 : -84.2, `2026-08-${String(10 + i).padStart(2, '0')}T08:00:00Z`, i % 2 ? 'Corner Cafe' : 'Grocer 0812 Hillside'),
)

describe('payeeKey', () => {
  it('reads the merchant off a store-and-suburb string', () => {
    expect(payeeKey('FRESHMART 3061 HILLSIDE')).toBe('freshmart')
    expect(payeeKey('Grocer 0812 Hillside')).toBe('grocer')
  })
  it('keeps a second word after a short processor prefix', () => {
    expect(payeeKey('SQ *Little Cafe')).toBe('sq little')
    expect(payeeKey('PP*Uber')).toBe('pp uber')
  })
  it('falls back to the trimmed description when nothing in it looks like a word', () => {
    expect(payeeKey('12345')).toBe('12345')
  })
  it('keys a transfer on who is on the other side, not on the word every transfer opens with', () => {
    expect(payeeKey('Transfer from Sam')).toBe('sam')
    expect(payeeKey('Transfer to Unknown Person')).toBe('unknown person')
    expect(payeeKey('Quick save transfer to Rainy Day')).toBe('rainy day')
    expect(payeeKey('Cover from Savings')).toBe('savings')
  })
  it('keys a transfer that names no other side like any other string', () => {
    expect(payeeKey('Round Up')).toBe('round')
    expect(payeeKey('Transfer to')).toBe('transfer')
  })
  it('reads a merchant that opens with a transfer word as a merchant', () => {
    expect(payeeKey('DIRECT CHEMIST OUTLET 3122 HAWTHORN')).toBe('direct')
    expect(payeeKey('DIRECT CHEMIST OUTLET 3061 RICHMOND')).toBe('direct')
    expect(payeeKey('Quick Coffee To Go')).toBe('quick')
    expect(payeeKey('Direct Pizza To Go')).toBe('direct')
  })
})

describe('flagTransactions', () => {
  it('calls an unseen merchant a new payee, and a seen one nothing', () => {
    const fresh = [txn('a', -389.6, '2026-08-26T04:02:00Z', 'FARESAVER LISBON'), txn('b', -60, '2026-08-26T05:00:00Z', 'Grocer 0812 Hillside')]
    const r = flagTransactions(fresh, history)
    expect(r.flags.get('a')).toContain('new_payee')
    expect(r.flags.get('b')).toEqual([])
  })

  it('says nothing about new payees when there is too little history to know', () => {
    const r = flagTransactions([txn('a', -20, '2026-08-26T04:02:00Z', 'Anywhere')], history.slice(0, 3))
    expect(r.flags.get('a')).toEqual([])
    expect(r.typicalDebit).toBeNull()
  })

  it('flags an amount several times the typical debit', () => {
    const r = flagTransactions([txn('a', -389.6, '2026-08-26T04:02:00Z', 'FARESAVER LISBON')], history)
    expect(r.typicalDebit).toBeCloseTo(48.35, 2)
    expect(r.flags.get('a')).toContain('unusually_large')
    const small = flagTransactions([txn('b', -90, '2026-08-26T04:02:00Z', 'Bunnings')], history)
    expect(small.flags.get('b')).not.toContain('unusually_large')
  })

  it('spots the same charge twice within two days, in history or in the same batch', () => {
    const fresh = [txn('a', -33, '2026-08-26T04:02:00Z', 'Kmart 1234'), txn('b', -33, '2026-08-26T04:05:00Z', 'Kmart 1234')]
    const r = flagTransactions(fresh, history)
    expect(r.flags.get('a')).toContain('possible_duplicate')
    expect(r.flags.get('b')).toContain('possible_duplicate')
    const later = flagTransactions([txn('c', -33, '2026-08-30T04:05:00Z', 'Kmart 1234')], [...history, txn('a', -33, '2026-08-26T04:02:00Z', 'Kmart 1234')])
    expect(later.flags.get('c')).not.toContain('possible_duplicate')
  })

  it('marks money in without deciding what it is', () => {
    const r = flagTransactions([txn('a', 150, '2026-08-26T04:02:00Z', 'Transfer from Sam')], history)
    expect(r.flags.get('a')).toContain('money_in')
    expect(r.flags.get('a')).not.toContain('unusually_large')
  })

  it('tells two partners\' payday top-ups apart, and calls a transfer to a stranger new', () => {
    const withTransfers = [...history, txn('h-sam', 500, '2026-08-19T08:00:00Z', 'Transfer from Sam'), txn('h-alex', 500, '2026-08-19T08:05:00Z', 'Transfer from Alex')]
    const payday = [txn('a', 500, '2026-08-26T08:00:00Z', 'Transfer from Sam'), txn('b', 500, '2026-08-26T08:05:00Z', 'Transfer from Alex')]
    const r = flagTransactions(payday, withTransfers)
    expect(r.flags.get('a')).toEqual(['money_in'])
    expect(r.flags.get('b')).toEqual(['money_in'])
    const stranger = flagTransactions([txn('c', -900, '2026-08-26T09:00:00Z', 'Transfer to Unknown Person')], withTransfers)
    expect(stranger.flags.get('c')).toContain('new_payee')
  })

  it('knows a chain that opens with a transfer word at another branch, and keeps two "To Go" shops apart', () => {
    const chemist = Array.from({ length: 12 }, (_, i) =>
      txn(`c${i}`, i % 2 ? -35 : -84.2, `2026-08-${String(10 + i).padStart(2, '0')}T08:00:00Z`, i % 2 ? 'DIRECT CHEMIST OUTLET 3061 RICHMOND' : 'FRESHMART 3061 HILLSIDE'),
    )
    const r = flagTransactions([txn('a', -35, '2026-08-26T04:02:00Z', 'DIRECT CHEMIST OUTLET 3122 HAWTHORN')], chemist)
    expect(r.flags.get('a')).toEqual([])
    const lunch = [txn('b', -14, '2026-08-26T04:02:00Z', 'Quick Coffee To Go'), txn('c', -14, '2026-08-26T05:02:00Z', 'Direct Pizza To Go')]
    const both = flagTransactions(lunch, history)
    expect(both.flags.get('b')).not.toContain('possible_duplicate')
    expect(both.flags.get('c')).not.toContain('possible_duplicate')
  })

  it('counts only prior transactions as history', () => {
    const fresh = [txn('a', -10, '2026-08-26T04:02:00Z', 'Coles')]
    expect(flagTransactions(fresh, [...history, ...fresh]).historyCount).toBe(history.length)
  })
})
