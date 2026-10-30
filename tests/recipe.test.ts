import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ToolContext } from '@/lib/tools/context'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))

const { browseTools, recipeIn, duration } = await import('@/lib/tools/browse')
const { buildTools } = await import('@/lib/tools')
const { routeGroups } = await import('@/lib/tools/router')

const fetchMock = vi.fn()
const ctx: ToolContext = { chatId: '-1', member: null, memberName: 'Rowan', now: new Date(), notices: [] }
const read = (url: string) =>
  (browseTools(ctx).read_recipe.execute as unknown as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)({ url }, {})
const page = (html: string, status = 200) => new Response(html, { status, headers: { 'content-type': 'text/html' } })
const ld = (value: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(value)}</script></head><body>Ad ad ad</body></html>`

const soup = {
  '@type': 'Recipe',
  name: 'Leek &amp; potato soup',
  recipeYield: ['4', '4 bowls'],
  totalTime: 'PT1H10M',
  prepTime: 'PT10M',
  cookTime: 'PT1H',
  recipeIngredient: ['2 leeks, sliced', '3 <b>potatoes</b>', ' '],
  recipeInstructions: [
    { '@type': 'HowToSection', name: 'Soup', itemListElement: [{ '@type': 'HowToStep', text: 'Soften the leeks.' }, { '@type': 'HowToStep', text: 'Add the potatoes and stock.' }] },
    { '@type': 'HowToStep', text: 'Blend.' },
  ],
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  lookup.mockReset()
  lookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }])
})
afterEach(() => vi.unstubAllGlobals())

describe('the recipe a page describes', () => {
  it('is found at the top of a block, in a list, or in a graph, past blocks that are not one', () => {
    expect(recipeIn(ld(soup))?.name).toBe('Leek &amp; potato soup')
    expect(recipeIn(ld([{ '@type': 'WebPage' }, soup]))?.name).toBe('Leek &amp; potato soup')
    expect(recipeIn(`<script type='application/ld+json'>not json</script>${ld({ '@graph': [{ '@type': ['Recipe', 'Thing'], name: 'Graph' }] })}`)?.name).toBe('Graph')
    expect(recipeIn('<p>No recipe here</p>')).toBeNull()
    expect(recipeIn(ld({ '@type': 'WebPage', '@graph': 'nope' }))).toBeNull()
  })

  it('says how long it takes the way a person says it', () => {
    expect(duration('PT1H30M')).toBe('1 hr 30 min')
    expect(duration('PT45M')).toBe('45 min')
    expect(duration('P1DT2H')).toBe('26 hr')
    expect(duration('PT0M')).toBeNull()
    expect(duration('an hour')).toBeNull()
    expect(duration(undefined)).toBeNull()
  })
})

describe('read_recipe', () => {
  it('hands back the name, what it serves, the times, the ingredients as written and the method in order', async () => {
    fetchMock.mockResolvedValue(page(ld(soup)))
    expect(await read('https://recipes.test/soup')).toEqual({
      url: 'https://recipes.test/soup',
      name: 'Leek & potato soup',
      serves: '4',
      total_time: '1 hr 10 min',
      prep_time: '10 min',
      cook_time: '1 hr',
      ingredients: ['2 leeks, sliced', '3 potatoes'],
      method: ['Soften the leeks.', 'Add the potatoes and stock.', 'Blend.'],
    })
  })

  it('reads a method given as one block of text, and keeps it to thirty steps', async () => {
    fetchMock.mockResolvedValue(page(ld({ '@type': 'Recipe', name: 'Toast', recipeInstructions: 'Toast the bread.\n\nButter it.' })))
    expect(await read('https://recipes.test/toast')).toMatchObject({ serves: null, ingredients: [], method: ['Toast the bread.', 'Butter it.'] })
    // A step with neither text nor a name, or one that is not text at all, says nothing; nor does a page with no name.
    fetchMock.mockResolvedValue(page(ld({ '@type': 'Recipe', recipeInstructions: [{ '@type': 'HowToStep' }, 42, 'Stir.'] })))
    expect(await read('https://recipes.test/odd')).toMatchObject({ name: null, method: ['Stir.'] })
    fetchMock.mockResolvedValue(page(ld({ '@type': 'Recipe', name: 'Lines', recipeInstructions: Array.from({ length: 35 }, (_, i) => `Line ${i + 1}`).join('\n') })))
    expect(((await read('https://recipes.test/lines')).method as string[]).length).toBe(30)
    const many = Array.from({ length: 40 }, (_, i) => ({ '@type': 'HowToStep', name: `Step ${i + 1}` }))
    fetchMock.mockResolvedValue(page(ld({ '@type': 'Recipe', name: 'Long', recipeInstructions: many })))
    expect(((await read('https://recipes.test/long')).method as string[]).length).toBe(30)
  })

  it('says so for a page with no recipe on it, one that will not answer, and an address it cannot read', async () => {
    fetchMock.mockResolvedValue(page('<p>Just a blog post</p>'))
    expect(String((await read('https://recipes.test/blog')).error)).toContain('read_url instead')
    fetchMock.mockResolvedValue(page('gone', 404))
    expect(await read('https://recipes.test/gone')).toEqual({ error: 'The page answered 404.' })
    expect(await read('soup')).toEqual({ error: '"soup" is not a valid address.' })
    expect(String((await read('http://127.0.0.1/recipe')).error)).toContain('Only public')
    fetchMock.mockRejectedValue(Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND recipes.test') }))
    expect(await read('https://recipes.test/x')).toEqual({ error: 'That address could not be found.' })
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'))
    expect(await read('https://recipes.test/x')).toEqual({ error: 'The page took too long to answer.' })
    fetchMock.mockRejectedValue(new Error('socket closed'))
    expect(await read('https://recipes.test/x')).toEqual({ error: 'socket closed' })
  })

  it('refuses a page too large to read', async () => {
    fetchMock.mockResolvedValue(new Response('x', { status: 200, headers: { 'content-type': 'text/html', 'content-length': String(10 * 1024 * 1024) } }))
    expect(await read('https://recipes.test/huge')).toEqual({ error: 'That page is too large to read here.' })
  })

  it('opens only a link the turn was given, once it has read outside text, as read_url does', async () => {
    fetchMock.mockResolvedValue(page(ld(soup)))
    const turn: ToolContext = { ...ctx, readUntrusted: true, seen: [{ text: 'try https://recipes.test/soup', typed: 0 }] }
    const tools = buildTools(turn) as unknown as Record<string, { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }>
    expect(String((await tools.read_recipe.execute({ url: 'https://elsewhere.test/x?leak=1' }, {})).error)).toContain('Not opened')
    expect((await tools.read_recipe.execute({ url: 'https://recipes.test/soup' }, {})).name).toBe('Leek & potato soup')
  })

  it('is reached when the talk is of cooking', () => {
    for (const said of ['can you add this recipe to the shopping list', 'what should we have for dinner?', 'plan meals for the week']) {
      expect(routeGroups(said), said).toContain('kitchen')
    }
  })
})
