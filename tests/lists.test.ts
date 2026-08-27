import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ListItem } from '@/lib/db/schema'

let store: ListItem[] = []
let nextId = 1

const findOrCreateList = vi.fn(async (name: string) => ({ id: 1, name: name.trim().toLowerCase(), createdAt: new Date() }))
const findList = vi.fn(async (name: string) =>
  name.trim().toLowerCase() === 'shopping' ? { id: 1, name: 'shopping', createdAt: new Date() } : undefined,
)
const listContents = vi.fn(async () => [...store].sort((a, b) => Number(a.done) - Number(b.done) || a.id - b.id))
const addListItems = vi.fn(async (_id: number, contents: string[]) => {
  const added = contents.map((content) => ({ id: nextId++, listId: 1, content: content.trim(), done: false, addedBy: null, createdAt: new Date() }) as ListItem)
  store.push(...added)
  return added
})
const markListItems = vi.fn(async (_id: number, needles: string[], done: boolean) => {
  const hit: ListItem[] = []
  for (const n of needles.map((s) => s.trim().toLowerCase())) {
    const m = store.find((i) => i.content.toLowerCase() === n) ?? store.find((i) => i.content.toLowerCase().includes(n))
    if (m && !hit.includes(m)) { m.done = done; hit.push(m) }
  }
  return hit
})
const clearList = vi.fn(async (_id: number, onlyDone: boolean) => {
  const gone = store.filter((i) => (onlyDone ? i.done : true))
  store = store.filter((i) => !gone.includes(i))
  return gone
})
const removeListItems = vi.fn(async (_id: number, ids: number[]) => {
  const gone = store.filter((i) => ids.includes(i.id))
  store = store.filter((i) => !gone.includes(i))
  return gone
})

vi.mock('@/lib/db/queries', () => ({
  findOrCreateList, findList, listContents, addListItems, markListItems, clearList, removeListItems,
  allLists: vi.fn(async () => [{ name: 'shopping', open: store.filter((i) => !i.done).length }]),
}))

const { listTools } = await import('@/lib/tools/lists')

const ctx = { chatId: '-1', member: null, memberName: 'Logan', now: new Date(), notices: [] }
const tools = listTools(ctx as never)
const run = (name: keyof ReturnType<typeof listTools>, args: unknown) =>
  (tools[name].execute as unknown as (a: unknown, o: unknown) => Promise<Record<string, unknown>>)(args, {})

beforeEach(() => { store = []; nextId = 1; vi.clearAllMocks() })

describe('add_to_list', () => {
  it('defaults to the shopping list', async () => {
    await run('add_to_list', { items: ['milk'], list: 'shopping' })
    expect(findOrCreateList).toHaveBeenCalledWith('shopping')
  })

  it('adds several things at once and counts what is open', async () => {
    const r = await run('add_to_list', { items: ['milk', 'eggs', 'bread'], list: 'shopping' })
    expect(r.added).toEqual(['milk', 'eggs', 'bread'])
    expect(r.open_count).toBe(3)
  })

  it('trims whitespace', async () => {
    const r = await run('add_to_list', { items: ['  butter  '], list: 'shopping' })
    expect(r.added).toEqual(['butter'])
  })
})

describe('show_list', () => {
  it('hides ticked items by default and shows them on request', async () => {
    await run('add_to_list', { items: ['milk', 'eggs'], list: 'shopping' })
    await run('check_off_list', { items: ['milk'], list: 'shopping', undo: false })

    const open = await run('show_list', { list: 'shopping', include_done: false })
    expect((open.items as { item: string }[]).map((i) => i.item)).toEqual(['eggs'])

    const all = await run('show_list', { list: 'shopping', include_done: true })
    expect(all.items).toHaveLength(2)
  })

  it('says so when the list does not exist', async () => {
    const r = await run('show_list', { list: 'packing', include_done: false })
    expect(r.items).toEqual([])
    expect(String(r.note)).toContain('no "packing" list')
  })
})

describe('check_off_list', () => {
  beforeEach(async () => {
    await run('add_to_list', { items: ['2L milk', 'free range eggs'], list: 'shopping' })
  })

  it('matches on substring, so "milk" ticks off "2L milk"', async () => {
    const r = await run('check_off_list', { items: ['milk'], list: 'shopping', undo: false })
    expect(r.ticked_off).toEqual(['2L milk'])
    expect(r.open_count).toBe(1)
  })

  it('can un-tick', async () => {
    await run('check_off_list', { items: ['milk'], list: 'shopping', undo: false })
    const r = await run('check_off_list', { items: ['milk'], list: 'shopping', undo: true })
    expect(r.unticked).toEqual(['2L milk'])
    expect(r.open_count).toBe(2)
  })

  it('reports when nothing matched rather than silently succeeding', async () => {
    const r = await run('check_off_list', { items: ['caviar'], list: 'shopping', undo: false })
    expect(String(r.error)).toContain('matched')
  })

  it('does not tick the same item twice for two similar terms', async () => {
    const r = await run('check_off_list', { items: ['milk', '2L'], list: 'shopping', undo: false })
    expect(r.ticked_off).toEqual(['2L milk'])
  })
})

describe('clear_list', () => {
  it('clears only ticked items by default', async () => {
    await run('add_to_list', { items: ['milk', 'eggs'], list: 'shopping' })
    await run('check_off_list', { items: ['milk'], list: 'shopping', undo: false })
    const r = await run('clear_list', { list: 'shopping', everything: false })
    expect(r.cleared).toBe(1)
    expect(store.map((i) => i.content)).toEqual(['eggs'])
  })

  it('wipes everything when asked explicitly', async () => {
    await run('add_to_list', { items: ['milk', 'eggs'], list: 'shopping' })
    const r = await run('clear_list', { list: 'shopping', everything: true })
    expect(r.cleared).toBe(2)
    expect(store).toHaveLength(0)
  })
})

describe('remove_from_list', () => {
  it('deletes items by id, gone for good', async () => {
    await run('add_to_list', { items: ['milk', 'bread'], list: 'shopping' })
    const r = await run('remove_from_list', { ids: [1], list: 'shopping' })
    expect(r).toMatchObject({ list: 'shopping', removed: ['milk'] })
    expect(store.map((i) => i.content)).toEqual(['bread'])
  })

  it('says so for a list that does not exist', async () => {
    const r = await run('remove_from_list', { ids: [1], list: 'chores' })
    expect(String(r.error)).toContain('chores')
  })
})

describe('show_lists', () => {
  it('shows every list with its open count', async () => {
    await run('add_to_list', { items: ['milk'], list: 'shopping' })
    const r = await run('show_lists', {})
    expect(r.lists).toEqual([{ name: 'shopping', open: 1 }])
  })
})
