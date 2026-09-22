import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getSetting, setSetting } = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))
vi.mock('@/lib/db/queries', () => ({ getSetting, setSetting }))

const { readCursor, writeCursor, CURSOR_MEMORY } = await import('@/lib/tools/cursor')

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
