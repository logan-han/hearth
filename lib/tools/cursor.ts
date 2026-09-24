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

/**
 * A cursor move waiting on its result reaching someone. A tool that reports
 * what is new stages the move rather than making it, and whoever delivers
 * the result commits it: the tick once the post has gone (or been
 * deliberately held back), a chat once its reply is sent, MCP once the call
 * returns. A run that dies in between leaves the mail for the next one,
 * instead of consuming it unseen.
 */
export type StagedCursor = { key: string; at: string; ids: string[]; prev: Cursor | null }

type Staging = { pendingCursors?: StagedCursor[] }

export function stageCursor(ctx: Staging, key: string, at: string, freshIds: string[], prev: Cursor | null): void {
  ;(ctx.pendingCursors ??= []).push({ key, at, ids: freshIds, prev })
}

/** The cursor as this turn sees it: its own staged move if it made one, else the stored one. */
export async function currentCursor(ctx: Staging, key: string): Promise<Cursor | null> {
  const staged = ctx.pendingCursors?.findLast((s) => s.key === key)
  if (staged) return { at: staged.at, ids: [...staged.ids, ...(staged.prev?.ids ?? [])].slice(0, CURSOR_MEMORY) }
  return readCursor(key)
}

/** Make the staged moves, the last per key: a later look this turn already includes an earlier one. */
export async function commitCursors(staged: readonly StagedCursor[] | undefined): Promise<void> {
  const last = new Map<string, StagedCursor>()
  for (const s of staged ?? []) last.set(s.key, s)
  for (const s of last.values()) await writeCursor(s.key, s.at, s.ids, s.prev)
}
