import type { Member, Helper } from '../db/schema'
import type { ActivityVia } from '../activity'
import type { StagedCursor } from './cursor'
import { UnconfirmedError } from '../deadline'
import { describeError } from '../errors'
import { appUrl } from '../env'

/** Ambient facts every tool needs: who is asking, and how. */
export type ToolContext = {
  member: Member | null
  memberName: string
  now: Date
  /**
   * Set once anything from outside the household has been read in this run:
   * mail, a web page, a search, Notion, the board, a calendar invite. Once it
   * is, read_url opens only a link that was there to be read (see `seen`).
   */
  readUntrusted?: boolean
  /**
   * The text this run has been given or has read: the instruction, then every
   * tool result as it came back, each with how many tool calls the model had
   * written by then. Once readUntrusted is set, read_url opens only a link
   * found in here that the model had not written into a call itself: one it
   * composed could carry the household's details out in its address.
   */
  seen?: { text: string; typed: number }[]
  /** What the model has written into each tool call this run, in order. See `seen`. */
  typed?: string[]
  /**
   * Every write this run that would double if done again, in order: a list
   * item, a reminder, a ticket. Once there is one, a failing model does not
   * hand the run to the next in the chain, which would start from the
   * instruction again and do it a second time. Writes that check for
   * themselves first (a draft, a proposal, an event, a fact) are not listed:
   * doing those again is harmless, and the next model can still finish. A
   * write whose request ran out of time is listed too, since it may have gone
   * through (see UnconfirmedError), and in `unconfirmed` as well.
   */
  wrote?: string[]
  /** The writes in `wrote` that may or may not have happened, which a report after a failure does not say were done. */
  unconfirmed?: string[]
  /** Cursor moves waiting on this run's result reaching someone; see StagedCursor. */
  pendingCursors?: StagedCursor[]
  /**
   * Whose "what's new" markers this run reads and moves: one MCP key's, one
   * scheduled job's, or the member's morning brief. Two readers never share
   * markers, so one never spends what the other has not been shown.
   */
  cursorScope?: string
  /** How this run came to be, for the member's record of what was changed. */
  via?: ActivityVia
  /** The helper this run works as, when the job was handed to one; what it schedules is its own. */
  helper?: Helper | null
}

export function requireMember(ctx: Pick<ToolContext, 'member'>): Member {
  if (!ctx.member) {
    throw new Error('This needs a family member: call it with a member\'s key, or sign in on the dashboard.')
  }
  return ctx.member
}

/** Where a member links, relinks or unlinks their accounts, and makes one read-only. */
export const connectPage = () => `${appUrl()}/connect`

/**
 * A write tool's result for what it caught. One whose request ran out of time
 * is still an error to the caller, which must check rather than say it is
 * done or try again, and `maybe_done` has the run count it as a write all the
 * same (see ToolContext.wrote).
 */
export function writeFailure(e: unknown, describe: (e: unknown) => string = describeError) {
  return e instanceof UnconfirmedError
    ? { error: `${e.message} Check before trying it again.`, maybe_done: true as const }
    : { error: describe(e) }
}
