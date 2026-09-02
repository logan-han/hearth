/**
 * A ceiling on how often the bot may post to a chat without being asked. The
 * watchers are quiet by design and every draft passes a decision, so in normal
 * running this never trips; it is the guard for an over-eager custom schedule
 * ("every 5 minutes, ...") or a provider that starts approving everything.
 */
export const PROACTIVE_POSTS_PER_HOUR = 6
const WINDOW_MS = 3600_000

export type PostLog = { posts: string[]; cappedAt?: string }

export function parseLog(raw: string | null): PostLog {
  if (!raw) return { posts: [] }
  try {
    const parsed = JSON.parse(raw) as Partial<PostLog>
    return {
      posts: Array.isArray(parsed.posts) ? parsed.posts.filter((p) => typeof p === 'string') : [],
      ...(typeof parsed.cappedAt === 'string' ? { cappedAt: parsed.cappedAt } : {}),
    }
  } catch {
    return { posts: [] }
  }
}

/** Only posts inside the window count. */
export function prune(log: PostLog, now: Date): PostLog {
  const floor = now.getTime() - WINDOW_MS
  return { ...log, posts: log.posts.filter((p) => new Date(p).getTime() > floor) }
}

export function underCap(log: PostLog, limit = PROACTIVE_POSTS_PER_HOUR): boolean {
  return log.posts.length < limit
}

export function recordPost(log: PostLog, now: Date): PostLog {
  return { ...log, posts: [...log.posts, now.toISOString()] }
}

/** Warn an admin once per window, not once per held-back post. */
export function shouldWarn(log: PostLog, now: Date): boolean {
  if (!log.cappedAt) return true
  return now.getTime() - new Date(log.cappedAt).getTime() > WINDOW_MS
}

export function markWarned(log: PostLog, now: Date): PostLog {
  return { ...log, cappedAt: now.toISOString() }
}
