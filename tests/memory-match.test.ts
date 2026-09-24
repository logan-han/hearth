import { describe, it, expect } from 'vitest'
import { similarity, rankSimilar, tokens, DUPLICATE, RELATED } from '@/lib/memory-match'

describe('memory likeness', () => {
  it('drops filler and plural endings', () => {
    expect([...tokens('The bins go out on Mondays, by the way')]).toEqual(['bin', 'go', 'out', 'monday'])
  })

  it('stems a plural ending in ies back to y', () => {
    expect([...tokens('families')]).toEqual(['family'])
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

  it('never calls a fact that differs by a "not" or a number the same fact', () => {
    const corrections: [string, string][] = [
      ['Ada is allergic to peanuts', 'Ada is not allergic to peanuts'],
      ['Ada is allergic to peanuts', 'Ada is no longer allergic to peanuts'],
      ['Juno can have dairy', "Juno can't have dairy"],
      ['Juno can have dairy', 'Juno can’t have dairy'],
      ['Ada wears size 7 shoes', 'Ada now wears size 8 shoes'],
      ['Juno is in year 3', 'Juno is in year 4'],
      ['Ada is allergic to peanuts', 'Ada isnt allergic to peanuts'],
      ['Ada eats pork', 'Ada doesnt eat pork'],
      ['Juno can have dairy at school on Mondays and Fridays', 'Juno cant have dairy at school on Mondays and Fridays'],
      ["Juno's teacher sends notes home on Fridays", "Juno's teacher doesn't send notes home on Fridays"],
      ["Juno's teacher sends notes home on Fridays", "Juno's teacher no longer sends notes home on Fridays"],
    ]
    for (const [was, now] of corrections) {
      const s = similarity(was, now)
      expect(s, now).toBeGreaterThanOrEqual(RELATED)
      expect(s, now).toBeLessThan(DUPLICATE)
    }
  })

  it('still calls a rewording a duplicate when the "not" and the numbers agree, however it is contracted', () => {
    expect(similarity("Ada isn't allergic to peanuts", 'Ada is not allergic to peanuts')).toBeGreaterThanOrEqual(DUPLICATE)
    expect(similarity("Juno can't have dairy", 'Juno cannot have dairy')).toBeGreaterThanOrEqual(DUPLICATE)
    expect(similarity("Juno won't eat fish", 'Juno will not eat fish')).toBeGreaterThanOrEqual(DUPLICATE)
    expect(similarity('Ada isnt allergic to peanuts', "Ada isn't allergic to peanuts")).toBeGreaterThanOrEqual(DUPLICATE)
    expect(similarity('Juno cant have dairy', 'Juno cannot have dairy')).toBeGreaterThanOrEqual(DUPLICATE)
    expect(similarity('Juno wont eat fish', 'Juno will not eat fish')).toBeGreaterThanOrEqual(DUPLICATE)
    expect(similarity('Ada wears size 7 shoes', 'Ada wears size 7 shoes now')).toBeGreaterThanOrEqual(DUPLICATE)
    expect([...tokens("Ada doesn't eat pork, size 7")]).toEqual(['ada', 'do', 'not', 'eat', 'pork', 'size', '7'])
  })

  it('does not stem a word into a "not"', () => {
    expect([...tokens('Juno brings notes home')]).toEqual(['juno', 'bring', 'note', 'home'])
  })

  it('does not call facts about two children one fact for a shared "not" or digit', () => {
    const siblings: [string, string][] = [
      ['Ada is not allergic to eggs, milk or nuts', 'Juno is not allergic to eggs, milk or nuts'],
      ["Ada doesn't eat mushrooms or olives", "Juno doesn't eat mushrooms or olives"],
      ['Ada is in year 3 at Riverbend Primary School', 'Juno is in year 3 at Riverbend Primary School'],
    ]
    for (const [ada, juno] of siblings) expect(similarity(ada, juno), juno).toBeLessThan(DUPLICATE)
  })

  it('sees nothing in common between unrelated facts', () => {
    expect(similarity('bin night is Monday', 'Juno goes to Riverbend College')).toBe(0)
    expect(similarity('', 'anything')).toBe(0)
  })

  it('ranks the closest facts first and leaves the unrelated out', () => {
    const rows = [
      { id: 1, content: 'Juno goes to Riverbend College' },
      { id: 2, content: 'bin night is Tuesday' },
      { id: 3, content: 'Bin night is Monday, recycling fortnightly' },
    ]
    const ranked = rankSimilar('bin night is Monday', rows)
    expect(ranked.map((r) => r.row.id)).toEqual([3, 2])
  })
})
