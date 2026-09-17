import { describe, it, expect } from 'vitest'
import { unsaid } from '@/lib/notices'
import { announce, type ToolContext } from '@/lib/tools/context'

const ADDED = 'Added to the family calendar: **Home cleaner** — Mon, 5 Oct 2026, 1:00 pm'

describe('unsaid', () => {
  it('keeps a notice the reply says nothing about', () => {
    expect(unsaid('Done.', [ADDED])).toEqual([ADDED])
  })

  it('drops a notice the reply quotes whole', () => {
    expect(unsaid(`Sure.\n\n${ADDED}`, [ADDED])).toEqual([])
  })

  it('drops a notice the reply has already given in its own words', () => {
    const reply = 'Added to the family calendar: Home cleaner on Monday, 5 October 2026 from 1:00 pm to 4:00 pm.'
    expect(unsaid(reply, [ADDED])).toEqual([])
  })

  it('reads through markup, case and spacing', () => {
    expect(unsaid('*HOME  CLEANER* is on for Monday.', [ADDED])).toEqual([])
  })

  it('keeps a notice about several things until the reply names them all', () => {
    const list = 'Added to the family calendar from school.ics:\n· **Athletics carnival** — Mon, 12 Oct 2026\n· **Assembly** — Tue, 13 Oct 2026, 9:00 am'
    expect(unsaid('Athletics carnival is on the calendar.', [list])).toEqual([list])
    expect(unsaid('Athletics carnival and Assembly are on the calendar.', [list])).toEqual([])
  })

  it('keeps a notice with no bold subject unless it is quoted', () => {
    expect(unsaid('Done.', ['Added to the family calendar: Soccer'])).toEqual(['Added to the family calendar: Soccer'])
    expect(unsaid('Added Soccer to the calendar', ['Soccer'])).toEqual([])
  })

  it('keeps everything when the reply is empty', () => {
    expect(unsaid('', [ADDED, 'Cancelled on the family calendar: **Gym**'])).toHaveLength(2)
  })

  it('judges each notice on its own', () => {
    const gym = 'Cancelled on the family calendar: **Gym**'
    expect(unsaid('Gym is off.', [ADDED, gym])).toEqual([ADDED])
  })
})

describe('announce', () => {
  const ctx = () => ({ notices: [] as string[] }) as unknown as ToolContext

  it('queues the line for the chat and hands it back to the model as already posted', () => {
    const c = ctx()
    const r = announce(c, ADDED)
    expect(c.notices).toEqual([ADDED])
    expect(r.posted).toBe(ADDED)
    expect(r.note).toMatch(/do not say the same thing again/i)
  })

  it('carries any extra note after the standing one', () => {
    const r = announce(ctx(), ADDED, 'Feeds lag.')
    expect(r.note).toMatch(/nothing at all\. Feeds lag\.$/)
  })
})
