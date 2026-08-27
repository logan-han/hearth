import { tool } from 'ai'
import { z } from 'zod'
import * as notion from '../providers/notion'
import type { ToolContext } from './context'

const NOT_CONFIGURED = 'Notion is not configured (NOTION_TOKEN missing).'

/** Nothing is visible until it is shared with the integration in Notion. */
const SHARING_HINT =
  'If something is missing, open it in Notion and add the Hearth integration under the ⋯ menu → Connections.'

export function notionTools(_ctx: ToolContext) {
  return {
    notion_search: tool({
      description:
        'Find pages and databases in Notion by name. Use this first when someone refers to something in Notion, to get its id.',
      inputSchema: z.object({
        query: z.string().optional().describe('Words in the title. Omit to list everything shared.'),
        type: z.enum(['page', 'data_source']).optional().describe('Restrict to pages or to databases'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ query, type, limit }) => {
        if (!notion.notionConfigured()) return { error: NOT_CONFIGURED }
        try {
          const found = await notion.search({ query, type, limit })
          return {
            count: found.length,
            results: found.map((f) => ({ id: f.id, title: f.title, type: f.type, url: f.url })),
            note: found.length === 0 ? SHARING_HINT : undefined,
          }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    notion_read_page: tool({
      description: 'Read a Notion page: its properties and its text content.',
      inputSchema: z.object({ id: z.string().describe('Page id, from notion_search') }),
      execute: async ({ id }) => {
        if (!notion.notionConfigured()) return { error: NOT_CONFIGURED }
        try {
          const [page, text] = await Promise.all([notion.getPage(id), notion.getPageText(id)])
          return { title: page.title, url: page.url, properties: page.properties, content: text }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    notion_query_database: tool({
      description:
        'List the rows of a Notion database, by name or id. Use this for "what is on my travel plans", "show my reading list".',
      inputSchema: z.object({
        database: z.string().describe('Database name or id'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ database, limit }) => {
        if (!notion.notionConfigured()) return { error: NOT_CONFIGURED }
        try {
          const source = await notion.findDataSource(database)
          if (!source) return { error: `No Notion database matching "${database}". ${SHARING_HINT}` }
          const rows = await notion.queryDataSource(source.id, limit)
          return { database: source.title, count: rows.length, rows: rows.map((r) => r.properties) }
        } catch (e) {
          return { error: describe(e) }
        }
      },
    }),

    notion_append_to_page: tool({
      description:
        'Add lines to the end of a Notion page. This only ever adds; it cannot edit or delete anything already there. Use for "add this to my reading list".',
      inputSchema: z.object({
        id: z.string().describe('Page id, from notion_search'),
        text: z.string().describe('What to add. Each line becomes its own paragraph.'),
      }),
      execute: async ({ id, text }) => {
        if (!notion.notionConfigured()) return { error: NOT_CONFIGURED }
        try {
          const { added } = await notion.appendToPage(id, text)
          return added === 0 ? { error: 'Nothing to add.' } : { added, id }
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
