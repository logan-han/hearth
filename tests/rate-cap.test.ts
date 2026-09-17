import { describe, it, expect } from 'vitest'
import { parseLog, prune, underCap, recordPost, shouldWarn, markWarned, PROACTIVE_POSTS_PER_HOUR } from '@/lib/rate-cap'

const now = new Date('2026-09-03T09:00:00Z')
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()

describe('proactive post cap', () => {
  it('reads a stored log and shrugs off anything else', () => {
    expect(parseLog(null)).toEqual({ posts: [] })
    expect(parseLog('2026-08-31')).toEqual({ posts: [] })
    expect(parseLog(JSON.stringify({ posts: [ago(5)], cappedAt: ago(50) }))).toEqual({ posts: [ago(5)], cappedAt: ago(50) })
  })

  it('forgets posts older than an hour', () => {
    const log = prune({ posts: [ago(90), ago(59), ago(1)] }, now)
    expect(log.posts).toEqual([ago(59), ago(1)])
  })

  it('allows the limit and no more', () => {
    const under = { posts: Array.from({ length: PROACTIVE_POSTS_PER_HOUR - 1 }, (_, i) => ago(i + 1)) }
    expect(underCap(under)).toBe(true)
    expect(underCap(recordPost(under, now))).toBe(false)
  })

  it('warns once per window', () => {
    expect(shouldWarn({ posts: [] }, now)).toBe(true)
    const warned = markWarned({ posts: [] }, now)
    expect(shouldWarn(warned, now)).toBe(false)
    expect(shouldWarn(warned, new Date(now.getTime() + 61 * 60_000))).toBe(true)
  })
})
