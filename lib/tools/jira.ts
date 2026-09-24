import { tool } from 'ai'
import { z } from 'zod'
import * as jira from '../providers/jira'
import { clientFor } from '../providers'
import { localDateKey } from '../cron'
import { announce, requireMember, writeFailure, type ToolContext } from './context'
import { mailboxOwner, describeMailError } from './mail'
import { describeError } from '../errors'

const NOT_CONFIGURED = 'Jira is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).'

/** The most open issues the board summary counts, five pages of Jira's; far more than a household board holds. */
const BOARD_MAX = 500

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
        status: z.string().optional().describe('A status name as the board uses it, e.g. "To Do", "In Progress", "Done"'),
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
          return { error: describeError(e) }
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
          // One past the most that is counted, so a bigger board says "at least".
          const found = await jira.searchIssues(
            `project = ${defaultProject()} AND statusCategory != Done ORDER BY duedate ASC`,
            BOARD_MAX + 1,
          )
          const issues = found.slice(0, BOARD_MAX)
          const today = localDateKey(ctx.now)
          const byStatus = new Map<string, number>()
          for (const i of issues) byStatus.set(i.status, (byStatus.get(i.status) ?? 0) + 1)
          const overdue = issues.filter((i) => i.dueDate && i.dueDate < today)

          return {
            project: defaultProject(),
            open: issues.length,
            ...(found.length > BOARD_MAX ? { open_is_at_least: true } : {}),
            by_status: [...byStatus].map(([status, count]) => ({ status, count })),
            overdue: overdue.map((i) => ({ key: i.key, summary: i.summary, due: i.dueDate })),
            due_next: issues
              .filter((i) => i.dueDate && i.dueDate >= today)
              .slice(0, 5)
              .map((i) => ({ key: i.key, summary: i.summary, due: i.dueDate })),
          }
        } catch (e) {
          return { error: describeError(e) }
        }
      },
    }),

    jira_read_issue: tool({
      description: 'Read one issue in full, including its description.',
      inputSchema: z.object({ key: z.string().describe(`Issue key, e.g. ${defaultProject()}-346`) }),
      execute: async ({ key }) => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        try {
          return await jira.getIssue(key)
        } catch (e) {
          return { error: describeError(e) }
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
          return { ...made, summary, due: due_date ?? null, ...announce(ctx, `Added to the board: **${made.key}** ${summary}`) }
        } catch (e) {
          return writeFailure(e)
        }
      },
    }),

    jira_update_issue: tool({
      description:
        "Change an issue's title, description or due date: for instance once an email or its attachment has said what the job is and when it is due. Give only what should change.",
      inputSchema: z.object({
        key: z.string().describe(`Issue key, e.g. ${defaultProject()}-346`),
        summary: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description, replacing the old one in full'),
        due_date: z.string().optional().describe('YYYY-MM-DD, or "none" to clear the due date'),
      }),
      execute: async ({ key, summary, description, due_date }) => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        if (summary === undefined && description === undefined && due_date === undefined) {
          return { error: 'Nothing to change: give a summary, a description or a due_date.' }
        }
        try {
          const dueDate = due_date === undefined ? undefined : due_date.trim().toLowerCase() === 'none' ? null : due_date
          await jira.updateIssue(key, { summary, description, dueDate })
          const updated = (['summary', 'description', 'due_date'] as const).filter((f) => ({ summary, description, due_date })[f] !== undefined)
          return { key, updated }
        } catch (e) {
          return { error: describeError(e) }
        }
      },
    }),

    jira_attach_email_file: tool({
      description:
        'Copy a file attached to an email onto an issue, so a renewal notice or an invoice sits with its job on the board. ' +
        'Give the email id and provider from list_email and the filename as read_email lists it.',
      inputSchema: z.object({
        key: z.string().describe(`Issue key, e.g. ${defaultProject()}-346`),
        email_id: z.string(),
        provider: z.enum(['google', 'microsoft']),
        filename: z.string().describe("The attachment's filename, exactly as read_email listed it"),
        of: z.string().optional().describe("Family member the mailbox belongs to; omit for the asker's own"),
      }),
      execute: async ({ key, email_id, provider, filename, of }) => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        requireMember(ctx)
        try {
          const who = await mailboxOwner(ctx, of)
          if ('error' in who) return who
          const file = await clientFor(who.owner.id, provider).readAttachment(email_id, filename)
          const made = await jira.attachFile(key, file)
          return { key, attached: made.filename, size: made.size }
        } catch (e) {
          return writeFailure(e, describeMailError)
        }
      },
    }),

    jira_move_issue: tool({
      description:
        'Move an issue to another status, e.g. mark it Done or send it back to To Do.',
      inputSchema: z.object({
        key: z.string().describe(`Issue key, e.g. ${defaultProject()}-346`),
        status: z.string().describe('Target status as the board names it, e.g. "Done", "In Progress", "To Do"'),
      }),
      execute: async ({ key, status }) => {
        if (!jira.jiraConfigured()) return { error: NOT_CONFIGURED }
        try {
          const alternatives = await jira.transitionIssue(key, status)
          return alternatives.length
            ? { error: `Cannot move ${key} to "${status}". Available from here: ${alternatives.join(', ')}.` }
            : { key, status }
        } catch (e) {
          return { error: describeError(e) }
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
          return writeFailure(e)
        }
      },
    }),
  }
}
