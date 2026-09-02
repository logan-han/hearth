import { describe, it, expect } from 'vitest'
import { similarity, rankSimilar, tokens, DUPLICATE, RELATED } from '@/lib/memory-match'

describe('memory likeness', () => {
  it('drops filler and plural endings', () => {
    expect([...tokens('The bins go out on Mondays, by the way')]).toEqual(['bin', 'go', 'out', 'monday'])
  })

  it('calls a reworded fact a duplicate', () => {
    expect(similarity('bin night is Monday', 'Bin night is Monday by the way')).toBeGreaterThanOrEqual(DUPLICATE)
    expect(similarity('Ada is allergic to peanuts', 'Ada allergic to peanuts.')).toBeGreaterThanOrEqual(DUPLICATE)
  })

  it('calls a correction related but not a duplicate', () => {
    const s = similarity('bin night is Monday', 'bin night is Tuesday')
    expect(s).toBeGreaterThanOrEqual(RELATED)
    expect(s).toBeLessThan(DUPLICATE)
  })

  it('sees nothing in common between unrelated facts', () => {
    expect(similarity('bin night is Monday', 'Winter goes to Northcote Primary')).toBe(0)
    expect(similarity('', 'anything')).toBe(0)
  })

  it('ranks the closest facts first and leaves the unrelated out', () => {
    const rows = [
      { id: 1, content: 'Winter goes to Northcote Primary' },
      { id: 2, content: 'bin night is Tuesday' },
      { id: 3, content: 'Bin night is Monday, recycling fortnightly' },
    ]
    const ranked = rankSimilar('bin night is Monday', rows)
    expect(ranked.map((r) => r.row.id)).toEqual([3, 2])
  })
})
