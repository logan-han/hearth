/**
 * Jira Cloud (https://developer.atlassian.com/cloud/jira/platform/rest/v3).
 *
 * Basic auth with an unscoped API token against the site URL. A *scoped* token
 * would need routing through api.atlassian.com/ex/jira/{cloudId} instead, so if
 * auth starts failing after a token rotation, check which kind was issued.
 *
 * v3 takes rich text as Atlassian Document Format rather than strings, which is
 * why descriptions and comments go through `adf()`.
 */
export type JiraIssue = {
  key: string
  summary: string
  status: string
  statusCategory: string
  type: string
  assignee: string | null
  reporter: string | null
  priority: string | null
  dueDate: string | null
  created: string
  updated: string
  url: string
}

export type JiraProject = { key: string; name: string; type: string }

export function jiraConfigured(): boolean {
  return Boolean(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN)
}

function baseUrl(): string {
  return (process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '')
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!jiraConfigured()) {
    throw new Error('Jira is not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).')
  }
  const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${auth}`,
      accept: 'application/json',
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Jira API ${res.status} on ${path}: ${body.slice(0, 250)}`)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

/** The cheapest authenticated call Jira offers; throws unless the token works. */
export async function ping(): Promise<void> {
  await api('/rest/api/3/myself')
}

/** Plain text as an Atlassian Document Format doc, one paragraph per line. */
export function adf(text: string) {
  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line.trim() ? [{ type: 'text', text: line }] : [],
  }))
  return { type: 'doc', version: 1, content: paragraphs }
}

/** ADF back to plain text, for reading a description or comment. */
export function fromAdf(doc: any): string {
  if (!doc) return ''
  if (typeof doc === 'string') return doc
  const walk = (node: any): string => {
    if (node.type === 'text') return node.text ?? ''
    const inner = (node.content ?? []).map(walk).join('')
    return node.type === 'paragraph' || node.type?.startsWith('heading') ? `${inner}\n` : inner
  }
  return (doc.content ?? []).map(walk).join('').trim()
}

const FIELDS = ['summary', 'status', 'assignee', 'reporter', 'priority', 'duedate', 'issuetype', 'created', 'updated']

function toIssue(raw: any): JiraIssue {
  const f = raw.fields ?? {}
  return {
    key: raw.key,
    summary: f.summary ?? '',
    status: f.status?.name ?? 'Unknown',
    statusCategory: f.status?.statusCategory?.name ?? '',
    type: f.issuetype?.name ?? '',
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    priority: f.priority?.name ?? null,
    dueDate: f.duedate ?? null,
    created: f.created ?? '',
    updated: f.updated ?? '',
    url: `${baseUrl()}/browse/${raw.key}`,
  }
}

export async function searchIssues(jql: string, limit = 20): Promise<JiraIssue[]> {
  // The old GET /search is gone; /search/jql is the supported endpoint and
  // paginates by token rather than by offset.
  const res = await api<{ issues?: any[] }>('/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, maxResults: Math.min(limit, 100), fields: FIELDS }),
  })
  return (res.issues ?? []).map(toIssue)
}

export async function getIssue(key: string): Promise<JiraIssue & { description: string }> {
  const raw = await api<any>(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${[...FIELDS, 'description'].join(',')}`)
  return { ...toIssue(raw), description: fromAdf(raw.fields?.description).slice(0, 4000) }
}

export async function listProjects(): Promise<JiraProject[]> {
  const res = await api<{ values?: any[] }>('/rest/api/3/project/search?maxResults=50')
  return (res.values ?? []).map((p) => ({ key: p.key, name: p.name, type: p.projectTypeKey }))
}

/** Every status a project's issues can hold, deduplicated across issue types. */
export async function projectStatuses(projectKey: string): Promise<string[]> {
  const res = await api<any[]>(`/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`)
  return [...new Set(res.flatMap((t) => (t.statuses ?? []).map((s: any) => s.name)))]
}

export async function createIssue(input: {
  projectKey: string
  summary: string
  description?: string
  issueType?: string
  dueDate?: string
}): Promise<{ key: string; url: string }> {
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    summary: input.summary,
    issuetype: { name: input.issueType ?? 'Task' },
  }
  if (input.description) fields.description = adf(input.description)
  if (input.dueDate) fields.duedate = input.dueDate

  const res = await api<{ key: string }>('/rest/api/3/issue', {
    method: 'POST',
    body: JSON.stringify({ fields }),
  })
  return { key: res.key, url: `${baseUrl()}/browse/${res.key}` }
}

/**
 * Move an issue to a named status. Jira moves issues along *transitions*, not
 * by setting a status, so the target has to be looked up per issue.
 */
export async function transitionIssue(key: string, statusName: string): Promise<string[]> {
  const res = await api<{ transitions?: any[] }>(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
  const available = res.transitions ?? []
  const needle = statusName.trim().toLowerCase()
  const match =
    available.find((t) => t.to?.name?.toLowerCase() === needle) ??
    available.find((t) => t.name?.toLowerCase() === needle) ??
    available.find((t) => t.to?.name?.toLowerCase().includes(needle))

  if (!match) return available.map((t) => t.to?.name ?? t.name).filter(Boolean)

  await api(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: match.id } }),
  })
  return []
}

export async function addComment(key: string, text: string): Promise<void> {
  await api(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    body: JSON.stringify({ body: adf(text) }),
  })
}
