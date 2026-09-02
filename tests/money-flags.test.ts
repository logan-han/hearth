import { describe, it, expect } from 'vitest'
import { flagTransactions, payeeKey } from '@/lib/money-flags'
import type { UpTransaction } from '@/lib/providers/up'

const txn = (id: string, amount: number, createdAt: string, description = 'Coles'): UpTransaction => ({
  id, description, message: null, amount, currency: 'AUD', status: 'SETTLED', createdAt, settledAt: createdAt,
  category: null, parentCategory: null, performedBy: null, accountId: 'joint',
})

/** A fortnight of ordinary groceries and coffees, so the account has a normal. */
const history = Array.from({ length: 14 }, (_, i) =>
  txn(`h${i}`, i % 2 ? -12.5 : -84.2, `2026-08-${String(10 + i).padStart(2, '0')}T08:00:00Z`, i % 2 ? 'Seven Seeds Coffee' : 'Coles 0812 Northcote'),
)

describe('payeeKey', () => {
  it('reads the merchant off a store-and-suburb string', () => {
    expect(payeeKey('WOOLWORTHS 3061 NORTHCOTE')).toBe('woolworths')
    expect(payeeKey('Coles 0812 Northcote')).toBe('coles')
  })
  it('keeps a second word after a short processor prefix', () => {
    expect(payeeKey('SQ *Little Cafe')).toBe('sq little')
    expect(payeeKey('PP*Uber')).toBe('pp uber')
  })
})

describe('flagTransactions', () => {
  it('calls an unseen merchant a new payee, and a seen one nothing', () => {
    const fresh = [txn('a', -412.3, '2026-08-26T04:02:00Z', 'CHEAPTICKETS SEATTLE'), txn('b', -60, '2026-08-26T05:00:00Z', 'Coles 0812 Northcote')]
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
    const r = flagTransactions([txn('a', -412.3, '2026-08-26T04:02:00Z', 'CHEAPTICKETS SEATTLE')], history)
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
    const r = flagTransactions([txn('a', 150, '2026-08-26T04:02:00Z', 'Transfer from Yuna')], history)
    expect(r.flags.get('a')).toContain('money_in')
    expect(r.flags.get('a')).not.toContain('unusually_large')
  })

  it('counts only prior transactions as history', () => {
    const fresh = [txn('a', -10, '2026-08-26T04:02:00Z', 'Coles')]
    expect(flagTransactions(fresh, [...history, ...fresh]).historyCount).toBe(history.length)
  })
})
