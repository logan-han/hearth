/**
 * Notion (https://developers.notion.com) via an internal integration token.
 *
 * Two things shape this client. First, the token grants nothing on its own:
 * every page or database must be shared with the integration by hand, and
 * anything unshared comes back as an empty result rather than an error.
 * Second, the 2025-09-03 API split a database into a container plus one or
 * more data sources, so queries address a `data_source_id`. The version header
 * is pinned deliberately; bumping it is a breaking change, not an upgrade.
 */
const BASE = 'https://api.notion.com/v1'
const VERSION = '2025-09-03'

export type NotionObject = {
  id: string
  type: 'page' | 'data_source' | 'database'
  title: string
  url: string | null
  lastEdited: string | null
}

export type NotionRow = { id: string; url: string | null; properties: Record<string, string> }

export function notionConfigured(): boolean {
  return Boolean(process.env.NOTION_TOKEN)
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.NOTION_TOKEN
  if (!token) throw new Error('Notion is not configured (NOTION_TOKEN missing).')

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'Notion-Version': VERSION,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Notion API ${res.status} on ${path}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

const plain = (rich: any[] | undefined): string =>
  (rich ?? []).map((r) => r.plain_text ?? '').join('')

/** Flatten one typed property into something a language model can read. */
export function readProperty(prop: any): string {
  if (!prop) return ''
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return plain(prop[prop.type])
    case 'number':
      return prop.number === null ? '' : String(prop.number)
    case 'select':
      return prop.select?.name ?? ''
    case 'status':
      return prop.status?.name ?? ''
    case 'multi_select':
      return (prop.multi_select ?? []).map((s: any) => s.name).join(', ')
    case 'date':
      return [prop.date?.start, prop.date?.end].filter(Boolean).join(' to ')
    case 'checkbox':
      return prop.checkbox ? 'yes' : 'no'
    case 'url':
    case 'email':
    case 'phone_number':
      return prop[prop.type] ?? ''
    case 'people':
      return (prop.people ?? []).map((p: any) => p.name ?? p.id).join(', ')
    case 'files':
      return (prop.files ?? []).map((f: any) => f.name).join(', ')
    case 'relation':
      return `${(prop.relation ?? []).length} linked`
    case 'formula':
      return readProperty({ type: prop.formula?.type, [prop.formula?.type]: prop.formula?.[prop.formula?.type] })
    case 'rollup':
      return prop.rollup?.type === 'number' ? String(prop.rollup.number ?? '') : ''
    case 'unique_id':
      return [prop.unique_id?.prefix, prop.unique_id?.number].filter(Boolean).join('-')
    case 'created_time':
    case 'last_edited_time':
      return prop[prop.type] ?? ''
    default:
      return ''
  }
}

function titleOf(obj: any): string {
  if (Array.isArray(obj.title)) return plain(obj.title) || '(untitled)'
  const props: Record<string, any> = obj.properties ?? {}
  for (const value of Object.values(props)) {
    if (value?.type === 'title') return plain(value.title) || '(untitled)'
  }
  return '(untitled)'
}

function toObject(raw: any): NotionObject {
  return {
    id: raw.id,
    type: raw.object,
    title: titleOf(raw),
    url: raw.url ?? null,
    lastEdited: raw.last_edited_time ?? null,
  }
}

export async function search(opts: {
  query?: string
  type?: 'page' | 'data_source'
  limit?: number
}): Promise<NotionObject[]> {
  const body: Record<string, unknown> = { page_size: Math.min(opts.limit ?? 25, 100) }
  if (opts.query) body.query = opts.query
  if (opts.type) body.filter = { property: 'object', value: opts.type }

  const res = await api<{ results: any[] }>('/search', { method: 'POST', body: JSON.stringify(body) })
  return res.results.map(toObject)
}

/** Resolve a data source by id, or by name against what has been shared. */
export async function findDataSource(nameOrId: string): Promise<NotionObject | undefined> {
  if (/^[0-9a-f-]{32,36}$/i.test(nameOrId)) {
    try {
      return toObject(await api<any>(`/data_sources/${nameOrId}`))
    } catch {
      // Fall through to a name search.
    }
  }
  const sources = await search({ type: 'data_source', limit: 100 })
  const needle = nameOrId.trim().toLowerCase()
  return (
    sources.find((s) => s.title.toLowerCase() === needle) ??
    sources.find((s) => s.title.toLowerCase().includes(needle))
  )
}

export async function queryDataSource(id: string, limit = 25): Promise<NotionRow[]> {
  const res = await api<{ results: any[] }>(`/data_sources/${id}/query`, {
    method: 'POST',
    body: JSON.stringify({ page_size: Math.min(limit, 100) }),
  })
  return res.results.map((row) => ({
    id: row.id,
    url: row.url ?? null,
    properties: Object.fromEntries(
      Object.entries(row.properties ?? {})
        .map(([k, v]) => [k, readProperty(v)])
        .filter(([, v]) => v !== ''),
    ) as Record<string, string>,
  }))
}

export async function getPage(id: string): Promise<NotionObject & { properties: Record<string, string> }> {
  const raw = await api<any>(`/pages/${id}`)
  return {
    ...toObject(raw),
    properties: Object.fromEntries(
      Object.entries(raw.properties ?? {})
        .map(([k, v]) => [k, readProperty(v)])
        .filter(([, v]) => v !== ''),
    ) as Record<string, string>,
  }
}

const TEXTY = new Set([
  'paragraph', 'heading_1', 'heading_2', 'heading_3',
  'bulleted_list_item', 'numbered_list_item', 'to_do', 'quote', 'callout', 'toggle', 'code',
])

/** Page body flattened to plain text. Nested blocks are not followed. */
export async function getPageText(id: string, limit = 100): Promise<string> {
  const res = await api<{ results: any[] }>(`/blocks/${id}/children?page_size=${Math.min(limit, 100)}`)
  const lines: string[] = []
  for (const block of res.results) {
    if (!TEXTY.has(block.type)) continue
    const text = plain(block[block.type]?.rich_text)
    if (!text) continue
    if (block.type === 'to_do') lines.push(`${block.to_do?.checked ? '[x]' : '[ ]'} ${text}`)
    else if (block.type.startsWith('heading')) lines.push(`## ${text}`)
    else if (block.type.endsWith('list_item')) lines.push(`- ${text}`)
    else lines.push(text)
  }
  return lines.join('\n').slice(0, 6000)
}

/**
 * Append paragraphs to the end of a page. Additive only: this client has no
 * way to edit or delete anything that is already there.
 */
export async function appendToPage(id: string, text: string): Promise<{ added: number }> {
  const children = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map((line) => ({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: line.slice(0, 2000) } }] },
    }))
  if (children.length === 0) return { added: 0 }

  await api(`/blocks/${id}/children`, { method: 'PATCH', body: JSON.stringify({ children }) })
  return { added: children.length }
}
