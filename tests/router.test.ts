import { describe, it, expect } from 'vitest'
import { TOOL_GROUPS, CORE_TOOLS, routeGroups, groupsAfter, activeToolsFor, buildTools } from '@/lib/tools'

const ctx = { chatId: '-100', member: null, memberName: 'Logan', now: new Date(), notices: [] }

describe('tool groups', () => {
  it('cover every tool exactly once, with the core always in reach', () => {
    const all = Object.keys(buildTools(ctx)).sort()
    const listed = [...CORE_TOOLS, ...Object.values(TOOL_GROUPS).flat()].sort()
    expect(listed).toEqual(all)
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('keeps a plain chat turn to the core set', () => {
    expect(routeGroups('hi, how was everyone\'s day')).toEqual([])
    const tools = activeToolsFor([])
    expect(tools).toContain('web_search')
    expect(tools).toContain('more_tools')
    expect(tools).not.toContain('list_email')
    expect(tools.length).toBeLessThan(25)
  })
})

describe('cues', () => {
  it('hears money in spending, transactions and dollar figures', () => {
    expect(routeGroups('how much did we spend this month?')).toEqual(['money'])
    expect(routeGroups('what was that $412 charge on 2up')).toEqual(['money'])
  })

  it('hears mail in email words and in a pending draft', () => {
    expect(routeGroups('did the school email say when sports day is?')).toContain('mail')
    expect(routeGroups('yes send it', { pendingDrafts: true })).toEqual(['mail'])
    expect(routeGroups('yes')).toEqual([])
  })

  it('hears the board and its issue keys', () => {
    expect(routeGroups("what's overdue on the board?")).toContain('jira')
    expect(routeGroups('mark HTL-344 done')).toContain('jira')
  })

  it('hears a schedule as automations', () => {
    expect(routeGroups('every friday 5pm remind us to book the market run')).toContain('automations')
    expect(routeGroups('what are we watching in here?')).toContain('automations')
  })

  it('opens both calendars for a calendar question', () => {
    const tools = activeToolsFor(routeGroups("what's on my calendar tomorrow?"))
    expect(tools).toContain('list_calendar')
    expect(tools).toContain('list_family_events')
  })
})

describe('groupsAfter', () => {
  it('widens the set with every more_tools call the model made', () => {
    const steps = [
      { toolCalls: [{ toolName: 'more_tools', input: { group: 'mail' } }] },
      { toolCalls: [{ toolName: 'list_email', input: {} }, { toolName: 'more_tools', input: { group: 'notion' } }] },
    ]
    expect(groupsAfter(['money'], steps)).toEqual(['money', 'mail', 'notion'])
    expect(activeToolsFor(groupsAfter([], steps))).toContain('notion_search')
  })

  it('ignores a group it does not know', () => {
    expect(groupsAfter([], [{ toolCalls: [{ toolName: 'more_tools', input: { group: 'kitchen' } }] }])).toEqual([])
  })
})

describe('more_tools', () => {
  it('names what it unlocked so the model knows what to call next', async () => {
    const tools = buildTools(ctx) as unknown as Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }>
    await expect(tools.more_tools.execute({ group: 'money' }, {})).resolves.toEqual({
      unlocked: 'money',
      tools: TOOL_GROUPS.money,
    })
  })
})
