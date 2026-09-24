import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { awaitTurn, endTurn, noteAlbumItem, takeAlbum } from '@/lib/turns'

let client: PGlite

beforeEach(async () => {
  client = (await freshDb()).client
})
afterEach(async () => {
  vi.restoreAllMocks()
  await closeDb(client)
})

describe("a chat's turn", () => {
  it('is taken over from a turn that was cut off, and freed only by the turn that holds it', async () => {
    await q.setSetting('turn:111', `${Date.now() - 1} cut-off`)
    const hold = await awaitTurn('111', 1)
    expect(hold).not.toBeNull()
    expect(await q.getSetting('turn:111')).toBe(hold)
    // Another chat is never held up by this one.
    expect(await awaitTurn('222', 2)).not.toBeNull()

    await endTurn('111', `${Date.now() - 1} cut-off`)
    expect(await q.getSetting('turn:111')).toBe(hold)
    await endTurn('111', null)
    await endTurn('111', hold)
    expect(await q.getSetting('turn:111')).toBeNull()
  })

  it('goes ahead without one once it has waited long enough', async () => {
    const busy = `${Date.now() + 600_000} busy`
    await q.setSetting('turn:111', busy)
    const start = Date.now()
    let calls = 0
    // The first reading sets the deadline; every one after is past it.
    vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? start : start + 91_000))
    expect(await awaitTurn('111', 1)).toBeNull()
    expect(await q.getSetting('turn:111')).toBe(busy)
    // And it no longer counts as waiting.
    expect(await q.getSetting('turnq:111:1')).toBeNull()
  })

  it('goes to the earliest message still waiting, past one that stopped waiting', async () => {
    // Message 2 is waiting; message 1 gave up long ago, cut off before it could say so.
    await q.setSetting('turnq:111:1', String(Date.now() - 1))
    await q.setSetting('turnq:111:2', String(Date.now() + 60_000))
    let third: string | null | undefined
    const waiting = awaitTurn('111', 3).then((hold) => (third = hold))
    await new Promise((resolve) => setTimeout(resolve, 300))
    // The chat is free, but message 2 came first.
    expect(await q.getSetting('turn:111')).toBeNull()
    expect(third).toBeUndefined()

    const second = await awaitTurn('111', 2)
    expect(second).not.toBeNull()
    expect(await q.getSetting('turnq:111:1')).toBeNull()
    await endTurn('111', second)
    await waiting
    expect(third).not.toBeNull()
    expect(await q.getSetting('turn:111')).toBe(third)
    expect(await q.getSetting('turnq:111:3')).toBeNull()
  })
})

describe('an album', () => {
  it('is handed whole, in the order it was sent, to the first item that takes it, and to no other', async () => {
    await noteAlbumItem('111', 'notice', { messageId: 3, text: '' })
    await noteAlbumItem('111', 'notice', { messageId: 1, text: 'add these dates' })
    await noteAlbumItem('111', 'notice', { messageId: 2, text: '' })
    const [a, b] = await Promise.all([takeAlbum('111', 'notice'), takeAlbum('111', 'notice')])
    const taken = a ?? b
    expect([a, b].filter((x) => x === null)).toHaveLength(1)
    expect(taken!.map((i) => i.messageId)).toEqual([1, 2, 3])
    expect(taken![0]).toMatchObject({ text: 'add these dates' })
  })

  it('nobody answered is cleared as the next is noted, and nothing else goes with it', async () => {
    await q.setSetting('calendar_token', 'not-json')
    await q.setSetting('album:-100:old', JSON.stringify([{ messageId: 1, at: Date.now() - 120_000 }]))
    await q.setSetting('album:-100:arriving', JSON.stringify([{ messageId: 2, at: Date.now() - 1_000 }]))
    await noteAlbumItem('-100', 'new', { messageId: 3 })
    expect(await q.getSetting('album:-100:old')).toBeNull()
    expect(await q.getSetting('album:-100:arriving')).not.toBeNull()
    expect(await q.getSetting('album:-100:new')).not.toBeNull()
    expect(await q.getSetting('calendar_token')).toBe('not-json')
  })
})
