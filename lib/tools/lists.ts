import { tool } from 'ai'
import { z } from 'zod'
import {
  findOrCreateList, findList, allLists, addListItems, listContents,
  markListItems, removeListItems, clearList,
} from '../db/queries'
import type { ToolContext } from './context'

const DEFAULT_LIST = 'shopping'

const listName = z
  .string()
  .default(DEFAULT_LIST)
  .describe('Which list, e.g. "shopping", "hardware", "packing". Defaults to the shopping list.')

function render(items: { id: number; content: string; done: boolean }[]) {
  return items.map((i) => ({ id: i.id, item: i.content, done: i.done }))
}

export function listTools(ctx: ToolContext) {
  return {
    add_to_list: tool({
      description:
        'Add one or more things to a shared family list. Use this for "add milk to the shopping list", "we need batteries", "put sunscreen on the packing list".',
      inputSchema: z.object({
        items: z.array(z.string()).min(1).describe('The things to add, one per entry'),
        list: listName,
      }),
      execute: async ({ items, list }) => {
        const target = await findOrCreateList(list)
        const added = await addListItems(target.id, items, ctx.member?.id ?? null)
        const open = (await listContents(target.id)).filter((i) => !i.done)
        return { list: target.name, added: added.map((a) => a.content), open_count: open.length }
      },
    }),

    show_list: tool({
      description: 'Show what is on a shared family list.',
      inputSchema: z.object({
        list: listName,
        include_done: z.boolean().default(false).describe('Include items already ticked off'),
      }),
      execute: async ({ list, include_done }) => {
        const target = await findList(list)
        if (!target) return { list, items: [], note: `There is no "${list}" list yet.` }
        const items = await listContents(target.id)
        return { list: target.name, items: render(include_done ? items : items.filter((i) => !i.done)) }
      },
    }),

    check_off_list: tool({
      description:
        'Tick items off a list once they are bought or done. Matches on substring, so "milk" ticks off "2L milk".',
      inputSchema: z.object({
        items: z.array(z.string()).min(1),
        list: listName,
        undo: z.boolean().default(false).describe('Set true to un-tick instead'),
      }),
      execute: async ({ items, list, undo }) => {
        const target = await findList(list)
        if (!target) return { error: `There is no "${list}" list.` }
        const changed = await markListItems(target.id, items, !undo)
        if (changed.length === 0) return { error: `Nothing on the ${target.name} list matched.` }
        const remaining = (await listContents(target.id)).filter((i) => !i.done)
        return {
          list: target.name,
          [undo ? 'unticked' : 'ticked_off']: changed.map((c) => c.content),
          open_count: remaining.length,
        }
      },
    }),

    remove_from_list: tool({
      description: 'Delete items from a list entirely, by their ids from show_list.',
      inputSchema: z.object({ ids: z.array(z.number().int()).min(1), list: listName }),
      execute: async ({ ids, list }) => {
        const target = await findList(list)
        if (!target) return { error: `There is no "${list}" list.` }
        const gone = await removeListItems(target.id, ids)
        return { list: target.name, removed: gone.map((g) => g.content) }
      },
    }),

    clear_list: tool({
      description:
        'Empty a list. By default only removes the items already ticked off, which is the usual tidy-up after a shop.',
      inputSchema: z.object({
        list: listName,
        everything: z.boolean().default(false).describe('True wipes the whole list, not just ticked items'),
      }),
      execute: async ({ list, everything }) => {
        const target = await findList(list)
        if (!target) return { error: `There is no "${list}" list.` }
        const gone = await clearList(target.id, !everything)
        return { list: target.name, cleared: gone.length }
      },
    }),

    show_lists: tool({
      description: 'Show which shared lists exist and how many open items each has.',
      inputSchema: z.object({}),
      execute: async () => ({ lists: await allLists() }),
    }),
  }
}
