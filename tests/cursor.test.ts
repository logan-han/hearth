import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getSetting, setSetting } = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))
vi.mock('@/lib/db/queries', () => ({ getSetting, setSetting }))

const { readCursor, writeCursor, CURSOR_MEMORY, stageCursor, currentCursor, commitCursors } = await import('@/lib/tools/cursor')
type StagedCursor = import('@/lib/tools/cursor').StagedCursor

beforeEach(() => vi.clearAllMocks())

describe('readCursor', () => {
  it('is null when nothing has been stored yet', async () => {
    getSetting.mockResolvedValue(null)
    expect(await readCursor('mail_cursor:x')).toBeNull()
  })

  it('defaults the ids to an empty list when the stored shape lacks them', async () => {
    getSetting.mockResolvedValue(JSON.stringify({ at: '2026-08-27T00:00:00.000Z' }))
    expect(await readCursor('k')).toEqual({ at: '2026-08-27T00:00:00.000Z', ids: [] })
  })

  it('keeps the stored ids when they are there', async () => {
    getSetting.mockResolvedValue(JSON.stringify({ at: '2026-08-27T00:00:00.000Z', ids: ['a', 'b'] }))
    expect(await readCursor('k')).toEqual({ at: '2026-08-27T00:00:00.000Z', ids: ['a', 'b'] })
  })

  it('is null when the stored value has no usable "at"', async () => {
    getSetting.mockResolvedValue(JSON.stringify({ ids: ['a'] }))
    expect(await readCursor('k')).toBeNull()
  })

  it('is null rather than throwing when the stored value is not JSON', async () => {
    getSetting.mockResolvedValue('not json')
    expect(await readCursor('k')).toBeNull()
  })
})

describe('writeCursor', () => {
  it('puts the fresh ids first and caps the total at CURSOR_MEMORY', async () => {
    const prev = { at: 'old-at', ids: Array.from({ length: CURSOR_MEMORY }, (_, i) => `old${i}`) }
    await writeCursor('k', 'new-at', ['fresh1', 'fresh2'], prev)
    expect(setSetting).toHaveBeenCalledTimes(1)
    const [key, value] = setSetting.mock.calls[0]
    expect(key).toBe('k')
    const stored = JSON.parse(value)
    expect(stored.at).toBe('new-at')
    expect(stored.ids).toHaveLength(CURSOR_MEMORY)
    expect(stored.ids.slice(0, 2)).toEqual(['fresh1', 'fresh2'])
  })

  it('starts a fresh list when there is no previous cursor', async () => {
    await writeCursor('k', 'new-at', ['a'], null)
    const stored = JSON.parse(setSetting.mock.calls[0][1])
    expect(stored).toEqual({ at: 'new-at', ids: ['a'] })
  })
})

describe('staged cursor moves', () => {
  const stored = new Map<string, string>()
  beforeEach(() => {
    stored.clear()
    getSetting.mockImplementation(async (k: string) => stored.get(k) ?? null)
    setSetting.mockImplementation(async (k: string, v: string) => void stored.set(k, v))
  })
  const read = (k: string) => JSON.parse(stored.get(k)!)

  it('reads the turn\'s own staged move before the stored one, so a second look this turn sees nothing twice', async () => {
    stored.set('k', JSON.stringify({ at: '2026-09-24T00:00:00.000Z', ids: ['old'] }))
    const ctx: { pendingCursors?: StagedCursor[] } = {}
    const prev = await currentCursor(ctx, 'k')
    stageCursor(ctx, 'k', '2026-09-24T01:00:00.000Z', ['new'], prev)
    expect(await currentCursor(ctx, 'k')).toEqual({ at: '2026-09-24T01:00:00.000Z', ids: ['new', 'old'] })
    // Nothing is written until the result is delivered.
    expect(read('k').at).toBe('2026-09-24T00:00:00.000Z')
  })

  it('makes the last move per key, once', async () => {
    await commitCursors([
      { key: 'k', at: '2026-09-24T01:00:00.000Z', ids: ['a'], prev: null },
      { key: 'k', at: '2026-09-24T02:00:00.000Z', ids: ['b', 'a'], prev: null },
      { key: 'j', at: '2026-09-24T01:30:00.000Z', ids: ['x'], prev: null },
    ])
    expect(read('k')).toEqual({ at: '2026-09-24T02:00:00.000Z', ids: ['b', 'a'] })
    expect(read('j').at).toBe('2026-09-24T01:30:00.000Z')
    expect(setSetting).toHaveBeenCalledTimes(2)
  })

  it('never moves a cursor back past where another run already took it, and keeps both runs\' ids', async () => {
    // The brief staged 06:40; a chat turn meanwhile committed 07:00:20.
    stored.set('k', JSON.stringify({ at: '2026-09-24T07:00:20.000Z', ids: ['m2', 'm1'] }))
    await commitCursors([{ key: 'k', at: '2026-09-24T06:40:00.000Z', ids: ['m1'], prev: { at: '2026-09-23T21:00:00.000Z', ids: ['m0'] } }])
    // The run that set the time leads, so the id at that time survives the trim.
    expect(read('k')).toEqual({ at: '2026-09-24T07:00:20.000Z', ids: ['m2', 'm1', 'm0'] })
  })

  it('keeps the boundary id when another run moved ahead and this one staged a full memory of its own', async () => {
    const mine = Array.from({ length: 32 }, (_, i) => `m${i + 1}`)
    stored.set('k', JSON.stringify({ at: '2026-09-24T07:00:20.000Z', ids: ['n1', ...mine.slice(0, 29)] }))
    await commitCursors([{ key: 'k', at: '2026-09-24T06:40:00.000Z', ids: mine, prev: null }])
    const ids = read('k').ids as string[]
    expect(ids[0]).toBe('n1')
    expect(ids).toHaveLength(30)
  })

  it('does nothing with nothing staged', async () => {
    await commitCursors(undefined)
    await commitCursors([])
    expect(setSetting).not.toHaveBeenCalled()
  })
})
