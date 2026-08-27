import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ToolContext } from '@/lib/tools/context'

/**
 * Every integration tool promises the model an { error } object rather than a
 * thrown exception, because a throw aborts the whole agent step while an error
 * result lets it apologise or route around. These tests break each provider to
 * hold the tools to that promise.
 */

const notionProvider = vi.hoisted(() => ({
  notionConfigured: vi.fn(() => true),
  search: vi.fn<() => Promise<never>>(),
  getPage: vi.fn<() => Promise<never>>(),
  getPageText: vi.fn<() => Promise<never>>(),
  findDataSource: vi.fn<() => Promise<never>>(),
  queryDataSource: vi.fn<() => Promise<never>>(),
  appendToPage: vi.fn<() => Promise<never>>(),
}))
vi.mock('@/lib/providers/notion', () => notionProvider)

const jiraProvider = vi.hoisted(() => ({
  jiraConfigured: vi.fn(() => true),
  searchIssues: vi.fn<() => Promise<never>>(),
  getIssue: vi.fn<() => Promise<never>>(),
  createIssue: vi.fn<() => Promise<never>>(),
  transitionIssue: vi.fn<() => Promise<never>>(),
  addComment: vi.fn<() => Promise<never>>(),
}))
vi.mock('@/lib/providers/jira', () => jiraProvider)

const { notionTools } = await import('@/lib/tools/notion')
const { jiraTools } = await import('@/lib/tools/jira')

const ctx: ToolContext = { chatId: '-100', member: null, memberName: 'Logan', now: new Date(), notices: [] }

const call = (tools: Record<string, unknown>, name: string, args: unknown) =>
  ((tools[name] as { execute: unknown }).execute as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})

beforeEach(() => {
  vi.clearAllMocks()
  notionProvider.notionConfigured.mockReturnValue(true)
  jiraProvider.jiraConfigured.mockReturnValue(true)
  for (const fn of [notionProvider.search, notionProvider.queryDataSource, notionProvider.appendToPage]) {
    fn.mockRejectedValue(new Error('Notion said 500'))
  }
  for (const fn of [jiraProvider.searchIssues, jiraProvider.getIssue, jiraProvider.createIssue, jiraProvider.addComment]) {
    fn.mockRejectedValue(new Error('Jira said 502'))
  }
})

describe('notion tools degrade to an error result', () => {
  it('search', async () => {
    const r = await call(notionTools(ctx), 'notion_search', { limit: 20 })
    expect(String(r.error)).toContain('Notion said 500')
  })

  it('database query', async () => {
    notionProvider.findDataSource.mockRejectedValue(new Error('Notion said 500'))
    const r = await call(notionTools(ctx), 'notion_query_database', { database: 'Meals', limit: 10 })
    expect(String(r.error)).toContain('Notion said 500')
  })

  it('append', async () => {
    const r = await call(notionTools(ctx), 'notion_append_to_page', { id: 'p1', text: 'hi' })
    expect(String(r.error)).toContain('Notion said 500')
  })

  it('every tool refuses politely when Notion is not configured', async () => {
    notionProvider.notionConfigured.mockReturnValue(false)
    for (const name of ['notion_search', 'notion_read_page', 'notion_query_database', 'notion_append_to_page']) {
      const r = await call(notionTools(ctx), name, { id: 'x', database: 'x', text: 'x', limit: 5 })
      expect(String(r.error)).toContain('not configured')
    }
  })
})

describe('jira tools degrade to an error result', () => {
  it('search', async () => {
    const r = await call(jiraTools(ctx), 'jira_search', { open_only: true, limit: 10 })
    expect(String(r.error)).toContain('Jira said 502')
  })

  it('board summary', async () => {
    const r = await call(jiraTools(ctx), 'jira_board_summary', {})
    expect(String(r.error)).toContain('Jira said 502')
  })

  it('read issue', async () => {
    const r = await call(jiraTools(ctx), 'jira_read_issue', { key: 'HTL-1' })
    expect(String(r.error)).toContain('Jira said 502')
  })

  it('create issue', async () => {
    const r = await call(jiraTools(ctx), 'jira_create_issue', { summary: 'Fix gate' })
    expect(String(r.error)).toContain('Jira said 502')
    expect(ctx.notices).toHaveLength(0)
  })

  it('move issue', async () => {
    jiraProvider.transitionIssue.mockRejectedValue(new Error('Jira said 502'))
    const r = await call(jiraTools(ctx), 'jira_move_issue', { key: 'HTL-1', status: 'Done' })
    expect(String(r.error)).toContain('Jira said 502')
  })

  it('comment', async () => {
    const r = await call(jiraTools(ctx), 'jira_comment', { key: 'HTL-1', text: 'hi' })
    expect(String(r.error)).toContain('Jira said 502')
  })

  it('every tool refuses politely when Jira is not configured', async () => {
    jiraProvider.jiraConfigured.mockReturnValue(false)
    for (const name of ['jira_search', 'jira_board_summary', 'jira_read_issue', 'jira_create_issue', 'jira_move_issue', 'jira_comment']) {
      const r = await call(jiraTools(ctx), name, { key: 'x', summary: 'x', status: 'x', text: 'x', open_only: true, limit: 5 })
      expect(String(r.error)).toContain('not configured')
    }
  })
})
