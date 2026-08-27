import { getSetting, setSetting } from '../db/queries'

/**
 * The discipline behind every "what's new since we last looked" tool: a marker
 * of when this chat last looked plus the ids seen at that instant, so nothing
 * is ever reported twice however often a scheduled sweep runs. Timestamps are
 * inclusive at the boundary, which is why the ids matter.
 */

export const CURSOR_MEMORY = 30

export type Cursor = { at: string; ids: string[] }

export async function readCursor(key: string): Promise<Cursor | null> {
  const raw = await getSetting(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Cursor
    return typeof parsed?.at === 'string' ? { at: parsed.at, ids: parsed.ids ?? [] } : null
  } catch {
    return null
  }
}

export async function writeCursor(key: string, at: string, freshIds: string[], prev: Cursor | null): Promise<void> {
  await setSetting(
    key,
    JSON.stringify({ at, ids: [...freshIds, ...(prev?.ids ?? [])].slice(0, CURSOR_MEMORY) } satisfies Cursor),
  )
}
