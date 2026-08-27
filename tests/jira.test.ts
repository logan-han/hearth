import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as jira from '@/lib/providers/jira'
import { jiraTools } from '@/lib/tools/jira'
import type { ToolContext } from '@/lib/tools/context'

const fetchMock = vi.fn()
let ctx: ToolContext

const call = (name: string, args: unknown) => {
  const tools = jiraTools(ctx) as Record<string, { execute: unknown; inputSchema: { parse: (a: unknown) => unknown } }>
  const parsed = tools[name].inputSchema.parse(args)
  return (tools[name].execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(parsed, {})
}

const json = (body: unknown, status = 200) => ({
  ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
})

const issue = (key: string, status: string, summary: string, duedate: string | null = null) => ({
  key,
  fields: {
    summary, duedate,
    status: { name: status, statusCategory: { name: status === 'Done' ? 'Done' : 'In Progress' } },
    issuetype: { name: 'Task' },
    assignee: { displayName: 'Logan Han' },
    reporter: { displayName: 'Logan Han' },
    priority: { name: 'Medium' },
    created: '2026-08-01T00:00:00.000+1000',
    updated: '2026-08-02T00:00:00.000+1000',
  },
})

const lastBody = () => JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body))
const bodyOf = (i: number) => JSON.parse(String((fetchMock.mock.calls[i][1] as RequestInit).body))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.JIRA_BASE_URL = 'https://loganh.atlassian.net'
  process.env.JIRA_EMAIL = 'logan@han.life'
  process.env.JIRA_API_TOKEN = 'token'
  process.env.JIRA_PROJECT_KEY = 'HTL'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  ctx = { chatId: '-100', member: null, memberName: 'Logan', now: new Date('2026-08-27T02:00:00Z'), notices: [] }
})
afterEach(() => vi.unstubAllGlobals())

describe('auth and configuration', () => {
  it('needs all three settings before it will run', () => {
    expect(jira.jiraConfigured()).toBe(true)
    delete process.env.JIRA_EMAIL
    expect(jira.jiraConfigured()).toBe(false)
  })

  it('reports the missing settings instead of throwing', async () => {
    delete process.env.JIRA_API_TOKEN
    for (const t of ['jira_search', 'jira_board_summary']) {
      expect(String((await call(t, { limit: 5, open_only: true })).error)).toContain('JIRA_BASE_URL')
    }
  })

  it('sends basic auth built from the email and token', async () => {
    fetchMock.mockResolvedValue(json({ issues: [] }))
    await jira.searchIssues('project = HTL')
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${Buffer.from('logan@han.life:token').toString('base64')}`)
  })

  it('tolerates a trailing slash on the base url', async () => {
    process.env.JIRA_BASE_URL = 'https://loganh.atlassian.net/'
    fetchMock.mockResolvedValue(json({ issues: [] }))
    await jira.searchIssues('project = HTL')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://loganh.atlassian.net/rest/api/3/search/jql')
  })

  it('surfaces an API error with its status', async () => {
    fetchMock.mockResolvedValue(json({ errorMessages: ['nope'] }, 400))
    expect(String((await call('jira_search', { limit: 5, open_only: true })).error)).toContain('Jira API 400')
  })
})

describe('Atlassian Document Format', () => {
  it('wraps each line as its own paragraph', () => {
    const doc = jira.adf('first\nsecond') as { content: unknown[] }
    expect(doc).toMatchObject({ type: 'doc', version: 1 })
    expect(doc.content).toHaveLength(2)
  })

  it('keeps a blank line as an empty paragraph', () => {
    const doc = jira.adf('a\n\nb') as { content: { content: unknown[] }[] }
    expect(doc.content[1].content).toEqual([])
  })

  it('round-trips back to plain text', () => {
    expect(jira.fromAdf(jira.adf('hello\nworld'))).toBe('hello\nworld')
  })

  it('reads nested marks and headings', () => {
    const doc = {
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'bold bit' }] },
      ],
    }
    expect(jira.fromAdf(doc)).toBe('Title\nbold bit')
  })

  it('copes with an absent or string description', () => {
    expect(jira.fromAdf(null)).toBe('')
    expect(jira.fromAdf('already text')).toBe('already text')
  })
})

describe('jira_search', () => {
  beforeEach(() => fetchMock.mockResolvedValue(json({ issues: [issue('HTL-1', 'In Progress', 'Council rate', '2026-11-30')] })))

  it('excludes done work by default', async () => {
    const r = await call('jira_search', { open_only: true, limit: 20 })
    expect(String(r.jql)).toContain('statusCategory != Done')
    expect(String(r.jql)).toContain('project = HTL')
  })

  it('filters by an explicit status instead of the open shortcut', async () => {
    const r = await call('jira_search', { status: 'Wishlist', open_only: true, limit: 20 })
    expect(String(r.jql)).toContain('status = "Wishlist"')
    expect(String(r.jql)).not.toContain('statusCategory')
  })

  it('escapes quotes so text cannot rewrite the query', async () => {
    const r = await call('jira_search', { text: 'a" OR project = SECRET', open_only: true, limit: 20 })
    expect(String(r.jql)).toContain('summary ~ "a\\" OR project = SECRET"')
    expect(String(r.jql)).toContain('project = HTL AND')
  })

  it('escapes backslashes too', async () => {
    const r = await call('jira_search', { text: 'back\\slash', open_only: true, limit: 20 })
    expect(String(r.jql)).toContain('"back\\\\slash"')
  })

  it('passes raw JQL straight through when given', async () => {
    const r = await call('jira_search', { jql: 'assignee = currentUser()', open_only: true, limit: 20 })
    expect(r.jql).toBe('assignee = currentUser()')
  })

  it('adds a due-date bound', async () => {
    const r = await call('jira_search', { due_before: '2026-12-01', open_only: true, limit: 20 })
    expect(String(r.jql)).toContain('duedate <= "2026-12-01"')
  })

  it('returns issues with a browse url', async () => {
    const r = await call('jira_search', { open_only: true, limit: 20 })
    expect((r.issues as { url: string }[])[0].url).toBe('https://loganh.atlassian.net/browse/HTL-1')
  })

  it('uses the supported search endpoint, not the removed one', async () => {
    await call('jira_search', { open_only: true, limit: 20 })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rest/api/3/search/jql')
  })
})

describe('jira_board_summary', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      json({
        issues: [
          issue('HTL-1', 'In Progress', 'Overdue thing', '2026-08-01'),
          issue('HTL-2', 'In Progress', 'Due later', '2026-11-30'),
          issue('HTL-3', 'Wishlist', 'Someday', null),
        ],
      }),
    )
  })

  it('counts by status', async () => {
    const r = await call('jira_board_summary', {})
    expect(r.open).toBe(3)
    expect(r.by_status).toEqual([{ status: 'In Progress', count: 2 }, { status: 'Wishlist', count: 1 }])
  })

  it('separates overdue from upcoming using Melbourne today', async () => {
    const r = await call('jira_board_summary', {})
    expect((r.overdue as { key: string }[]).map((o) => o.key)).toEqual(['HTL-1'])
    expect((r.due_next as { key: string }[]).map((o) => o.key)).toEqual(['HTL-2'])
  })

  it('leaves undated issues out of both lists', async () => {
    const r = await call('jira_board_summary', {})
    const listed = [...(r.overdue as { key: string }[]), ...(r.due_next as { key: string }[])].map((i) => i.key)
    expect(listed).not.toContain('HTL-3')
  })
})

describe('jira_create_issue', () => {
  it('creates in the configured project and announces it', async () => {
    fetchMock.mockResolvedValue(json({ key: 'HTL-400' }))
    const r = await call('jira_create_issue', { summary: 'Fix the gutter', due_date: '2026-09-30', issue_type: 'Task' })
    expect(r).toMatchObject({ key: 'HTL-400', url: 'https://loganh.atlassian.net/browse/HTL-400' })
    expect(ctx.notices.join(' ')).toContain('HTL-400')

    const body = lastBody()
    expect(body.fields.project).toEqual({ key: 'HTL' })
    expect(body.fields.duedate).toBe('2026-09-30')
    expect(body.fields.issuetype).toEqual({ name: 'Task' })
  })

  it('sends the description as ADF, not a bare string', async () => {
    fetchMock.mockResolvedValue(json({ key: 'HTL-401' }))
    await call('jira_create_issue', { summary: 's', description: 'line one', issue_type: 'Task' })
    expect(lastBody().fields.description).toMatchObject({ type: 'doc', version: 1 })
  })

  it('omits description and due date when not given', async () => {
    fetchMock.mockResolvedValue(json({ key: 'HTL-402' }))
    await call('jira_create_issue', { summary: 's', issue_type: 'Task' })
    expect(lastBody().fields).not.toHaveProperty('description')
    expect(lastBody().fields).not.toHaveProperty('duedate')
  })
})

describe('jira_move_issue', () => {
  const transitions = { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }, { id: '21', name: 'Start', to: { name: 'In Progress' } }] }

  it('looks up the transition then posts its id', async () => {
    fetchMock.mockResolvedValueOnce(json(transitions)).mockResolvedValueOnce(json({}, 204))
    const r = await call('jira_move_issue', { key: 'HTL-1', status: 'Done' })
    expect(r).toEqual({ key: 'HTL-1', status: 'Done' })
    expect(bodyOf(1)).toEqual({ transition: { id: '31' } })
  })

  it('matches a target status case-insensitively', async () => {
    fetchMock.mockResolvedValueOnce(json(transitions)).mockResolvedValueOnce(json({}, 204))
    await call('jira_move_issue', { key: 'HTL-1', status: 'in progress' })
    expect(bodyOf(1)).toEqual({ transition: { id: '21' } })
  })

  it('lists what is possible when the target is not reachable', async () => {
    fetchMock.mockResolvedValueOnce(json(transitions))
    const r = await call('jira_move_issue', { key: 'HTL-1', status: 'Cancelled' })
    expect(String(r.error)).toContain('Done, In Progress')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('jira_comment and jira_read_issue', () => {
  it('posts a comment as ADF', async () => {
    fetchMock.mockResolvedValue(json({ id: '1' }))
    expect(await call('jira_comment', { key: 'HTL-1', text: 'paid today' })).toEqual({ commented: true, key: 'HTL-1' })
    expect(lastBody().body).toMatchObject({ type: 'doc' })
  })

  it('reads an issue with its description flattened', async () => {
    fetchMock.mockResolvedValue(
      json({ ...issue('HTL-1', 'In Progress', 'Council rate'), fields: { ...issue('HTL-1', 'In Progress', 'Council rate').fields, description: jira.adf('Pay by November.') } }),
    )
    const r = await call('jira_read_issue', { key: 'HTL-1' })
    expect(r.summary).toBe('Council rate')
    expect(r.description).toBe('Pay by November.')
  })

  it('url-encodes a key rather than pasting it in raw', async () => {
    fetchMock.mockResolvedValue(json(issue('HTL-1', 'To Do', 's')))
    await call('jira_read_issue', { key: 'HTL 1/../x' })
    expect(String(fetchMock.mock.calls[0][0])).toContain('HTL%201%2F..%2Fx')
  })
})

describe('the bot cannot delete', () => {
  it('exposes no tool that issues a DELETE', async () => {
    const names = Object.keys(jiraTools(ctx))
    expect(names.some((n) => /delete|remove/i.test(n))).toBe(false)
    expect(jira).not.toHaveProperty('deleteIssue')
  })
})

describe('provider odds and ends', () => {
  it('lists projects', async () => {
    fetchMock.mockResolvedValue(json({ values: [{ key: 'HTL', name: 'Home TODO List', projectTypeKey: 'business' }] }))
    expect(await jira.listProjects()).toEqual([{ key: 'HTL', name: 'Home TODO List', type: 'business' }])
  })

  it('deduplicates statuses across issue types', async () => {
    fetchMock.mockResolvedValue(
      json([
        { name: 'Task', statuses: [{ name: 'To Do' }, { name: 'Done' }] },
        { name: 'Sub-task', statuses: [{ name: 'To Do' }, { name: 'In Progress' }] },
      ]),
    )
    expect(await jira.projectStatuses('HTL')).toEqual(['To Do', 'Done', 'In Progress'])
  })

  it('copes with a project that reports nothing', async () => {
    fetchMock.mockResolvedValue(json({}))
    expect(await jira.listProjects()).toEqual([])
    fetchMock.mockResolvedValue(json({}))
    expect(await jira.searchIssues('project = HTL')).toEqual([])
  })

  it('fills in placeholders for an issue missing fields', async () => {
    fetchMock.mockResolvedValue(json({ issues: [{ key: 'HTL-9', fields: {} }] }))
    const [i] = await jira.searchIssues('project = HTL')
    expect(i).toMatchObject({ key: 'HTL-9', summary: '', status: 'Unknown', assignee: null, dueDate: null })
  })

  it('treats a 204 as a body-less success', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ transitions: [{ id: '1', name: 'Done', to: { name: 'Done' } }] }))
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '', json: async () => { throw new Error('no body') } })
    await expect(jira.transitionIssue('HTL-1', 'Done')).resolves.toEqual([])
  })

  it('caps the page size it asks for', async () => {
    fetchMock.mockResolvedValue(json({ issues: [] }))
    await jira.searchIssues('project = HTL', 5000)
    expect(lastBody().maxResults).toBe(100)
  })

  it('reports an empty transition list rather than crashing', async () => {
    fetchMock.mockResolvedValue(json({}))
    expect(await jira.transitionIssue('HTL-1', 'Done')).toEqual([])
  })
})
