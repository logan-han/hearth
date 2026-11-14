import { describe, it, expect } from 'vitest'
import { assembleBrief } from '@/lib/brief'

type BriefInput = Parameters<typeof assembleBrief>[0]

/** What the tick fetched on a quiet Tuesday, with `over` laid on top. */
function fetched(over: Partial<BriefInput> = {}): BriefInput {
  return {
    day: '2026-09-15',
    next: '2026-09-16',
    horizon: '2026-09-28',
    events: { events: [] },
    tomorrowEvents: { events: [] },
    comingEvents: { events: [] },
    calendars: { accounts: [] },
    mail: { accounts: [] },
    board: { overdue: [], due_today: [], due_next: [] },
    weather: { summary: 'Fine' },
    proposals: { proposals: [] },
    questions: [],
    reminders: [],
    ...over,
  }
}

describe('assembleBrief', () => {
  it('has nothing to tell on a day with nothing new', () => {
    const brief = assembleBrief(fetched())
    expect(brief.empty).toBe(true)
    expect(brief.problems).toEqual([])
  })

  it('reports a family calendar that failed once, not once per lookup, and leaves its events out', () => {
    const down = { error: 'family calendar down' }
    const brief = assembleBrief(fetched({ events: down, tomorrowEvents: down, comingEvents: down }))
    expect(brief.problems).toEqual(['list_family_events: family calendar down'])
    expect(brief.data).not.toHaveProperty('events')
  })

  it('takes nobody having linked a calendar as a setting, not a fault', () => {
    const brief = assembleBrief(fetched({ calendars: { error: 'Nobody in this chat has linked a calendar yet. Send /connect to link one.' } }))
    expect(brief.problems).toEqual([])
    expect(brief.data).not.toHaveProperty('calendars')
  })

  it('lists an event on today and tomorrow once, under today', () => {
    const camp = { id: 7, title: 'Camp' }
    const brief = assembleBrief(fetched({ events: { events: [camp] }, tomorrowEvents: { events: [camp] } }))
    expect(brief.data.events).toEqual({ events: [camp] })
    expect(brief.data).not.toHaveProperty('tomorrow')
    expect(brief.empty).toBe(false)
  })

  it('names a mailbox that failed in problems and hands the writer only those that answered', () => {
    const mail = {
      accounts: [
        { member: 'Sam', mailbox: "Sam's Outlook", provider: 'microsoft', error: 'timed out' },
        { member: 'Rowan', mailbox: "Rowan's Gmail", provider: 'google', messages: [{ subject: 'Excursion form' }] },
      ],
    }
    const brief = assembleBrief(fetched({ mail }))
    expect(brief.problems).toEqual(["new_mail (Sam's Outlook): timed out"])
    expect(brief.data.mail).toEqual({ accounts: [{ member: 'Rowan', provider: 'google', messages: [{ subject: 'Excursion form' }] }] })
    expect(brief.empty).toBe(false)
  })
})
