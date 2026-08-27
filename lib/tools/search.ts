import { tool } from 'ai'
import { z } from 'zod'

type TavilyResult = { title: string; url: string; content: string; score?: number }

/** Tavily web search: 1k credits/month on the free tier. */
export const searchTools = {
  web_search: tool({
    description:
      'Search the web for current information: news, opening hours, prices, how-tos. Use this whenever the answer could have changed recently or is not general knowledge. Weather has its own tool.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
      depth: z.enum(['basic', 'advanced']).default('basic').describe('Use advanced only for hard research questions'),
    }),
    execute: async ({ query, depth }) => {
      const apiKey = process.env.TAVILY_API_KEY
      if (!apiKey) return { error: 'Web search is not configured (TAVILY_API_KEY missing).' }

      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          search_depth: depth,
          max_results: 5,
          include_answer: true,
        }),
      })
      if (!res.ok) return { error: `Search failed (${res.status}): ${(await res.text()).slice(0, 200)}` }

      const data = (await res.json()) as { answer?: string; results?: TavilyResult[] }
      return {
        answer: data.answer ?? null,
        results: (data.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          extract: r.content.slice(0, 600),
        })),
      }
    },
  }),
}
