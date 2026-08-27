import { tool } from 'ai'
import { z } from 'zod'
import * as jira from '../providers/jira'
import { localDateKey } from '../cron'
import type { ToolContext } from './context'

const NOT_CONFIGURED = 'Jira is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).'

function defaultProject(): string {
  return process.env.JIRA_PROJECT_KEY || 'HTL'
}

/** Escape a JQL string literal so a quote in user text cannot change the query. */
function jqlString(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`
}

export function jiraTools(ctx: ToolContext) {
  return {
    jira_search: tool({
      description:
        'Find issues on the household Jira board. Use the plain filters for everyday questions ("what is in progress", "what is due this month"); use `jql` only for something the filters cannot express.',
      inputSchema: z.object({
        status: z.string().optional().describe('e.g. "To Do", "In Progress", "Wishlist", "Done"'),
        open_only: z.boolean().default(true).describe('Exclude anything already Done'),
        text: z.string().optional().describe('Words appearing in the summary'),
        due_before: z.string().optional().describe('YYYY-MM-DD'),
        jql: z.string().optional().describe('Raw JQL, which overrides every other filter'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ status, open_only, text, due_before, jql, limit }) => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        try {
          let query = jql
          if (!query) {
            const clauses = [`project = ${defaultProject()}`]
            if (status) clauses.push(`status = ${jqlString(status)}`)
            else if (open_only) clauses.push('statusCategory != Done')
            if (text) clauses.push(`summary ~ ${jqlString(text)}`)
            if (due_before) clauses.push(`duedate <= ${jqlString(due_before)}`)
            query = `${clauses.join(' AND ')} ORDER BY duedate ASC, created DESC`
          }
          const issues = await jira.searchIssues(query, limit)
          return {
            jql: query,
            count: issues.length,
            issues: issues.map((i) => ({
              key: i.key, summary: i.summary, status: i.status,
              due: i.dueDate, assignee: i.assignee, url: i.url,
            })),
          }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    jira_board_summary: tool({
      description:
        'How the household board stands: how many issues sit in each status, and what is overdue.',
      inputSchema: z.object({}),
      execute: async () => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        try {
          const issues = await jira.searchIssues(
            `project = ${defaultProject()} AND statusCategory != Done ORDER BY duedate ASC`,
            100,
          )
          const today = localDateKey(ctx.now)
          const byStatus = new Map<string, number>()
          for (const i of issues) byStatus.set(i.status, (byStatus.get(i.status) ?? 0) + 1)
          const overdue = issues.filter((i) => i.dueDate && i.dueDate < today)

          return {
            project: defaultProject(),
            open: issues.length,
            by_status: [...byStatus].map(([status, count]) => ({ status, count })),
            overdue: overdue.map((i) => ({ key: i.key, summary: i.summary, due: i.dueDate })),
            due_next: issues
              .filter((i) => i.dueDate && i.dueDate >= today)
              .slice(0, 5)
              .map((i) => ({ key: i.key, summary: i.summary, due: i.dueDate })),
          }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    jira_read_issue: tool({
      description: 'Read one issue in full, including its description.',
      inputSchema: z.object({ key: z.string().describe('Issue key, e.g. HTL-346') }),
      execute: async ({ key }) => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        try {
          return await jira.getIssue(key)
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    jira_create_issue: tool({
      description:
        'Add a task to the household board. Use this when someone says "add X to the todo list" and means the Jira board rather than a shopping list.',
      inputSchema: z.object({
        summary: z.string().describe('Short title'),
        description: z.string().optional(),
        due_date: z.string().optional().describe('YYYY-MM-DD'),
        issue_type: z.string().default('Task'),
      }),
      execute: async ({ summary, description, due_date, issue_type }) => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        try {
          const made = await jira.createIssue({
            projectKey: defaultProject(), summary, description, dueDate: due_date, issueType: issue_type,
          })
          ctx.notices.push(`Added to the board: **${made.key}** ${summary}`)
          return { ...made, summary, due: due_date ?? null }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    jira_move_issue: tool({
      description:
        'Move an issue to another status, e.g. mark it Done or push it to Wishlist.',
      inputSchema: z.object({
        key: z.string().describe('Issue key, e.g. HTL-346'),
        status: z.string().describe('Target status, e.g. "Done", "In Progress", "To Do", "Wishlist"'),
      }),
      execute: async ({ key, status }) => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        try {
          const alternatives = await jira.transitionIssue(key, status)
          return alternatives.length
            ? { error: `Cannot move ${key} to "${status}". Available from here: ${alternatives.join(', ')}.` }
            : { key, status }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    jira_comment: tool({
      description: 'Add a comment to an issue.',
      inputSchema: z.object({ key: z.string(), text: z.string() }),
      execute: async ({ key, text }) => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        try {
          await jira.addComment(key, text)
          return { commented: true, key }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
