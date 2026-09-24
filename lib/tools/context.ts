import type { Member } from '../db/schema'
import type { ParsedIcs } from '../ics-parse'
import type { StagedCursor } from './cursor'
import { UnconfirmedError } from '../deadline'
import { describeError } from '../errors'

/** Ambient facts every tool needs: who is asking, and where. */
export type ToolContext = {
  chatId: string
  member: Member | null
  memberName: string
  now: Date
  /** Side-channel for things the caller should announce after the run. */
  notices: string[]
  /** Calendar files (.ics) attached to the message being answered, already parsed. */
  calendarFiles?: { filename: string; parsed: ParsedIcs }[]
  /**
   * Drafts written during this turn. send_email refuses them: the yes has to
   * come from a person in a later message, and nothing in one model turn,
   * least of all an instruction inside an email it just read, is that.
   */
  draftedThisTurn?: Set<number>
  /**
   * Set once anything from outside the household has been read this turn: mail,
   * a web page, a search, Notion, the board, a calendar invite, an attached
   * file. send_email refuses after that, so a sentence planted in any of them
   * cannot send a draft that was waiting on someone's yes.
   */
  readUntrusted?: boolean
  /**
   * The text this turn has been given or has read: the conversation, then
   * every tool result as it came back, each with how many tool calls the
   * model had written by then. Once readUntrusted is set, read_url opens only
   * a link found in here that the model had not written into a call itself:
   * one it composed could carry the household's details out in its address.
   */
  seen?: { text: string; typed: number }[]
  /** What the model has written into each tool call this turn, in order. See `seen`. */
  typed?: string[]
  /**
   * Every write this turn that would double if done again, in order: a list
   * item, a reminder, an invitation, a ticket. Once there is one, a failing
   * model does not hand the turn to the next in the chain, which would start
   * from the message again and do it a second time. Writes that check for
   * themselves first (a draft, a proposal, an event, a fact) are not listed:
   * doing those again is harmless, and the next model can still finish.
   * A write whose request ran out of time is listed too, since it may have
   * gone through (see UnconfirmedError), and in `unconfirmed` as well.
   */
  wrote?: string[]
  /** The writes in `wrote` that may or may not have happened, which a reply after a failure does not say were done. */
  unconfirmed?: string[]
  /**
   * Every write tool that returned without an error this turn, repeatable or
   * not. It may still have changed nothing (an event already there, a fact
   * already known), so it decides only what a reply can honestly say, never
   * what the turn claims was done.
   */
  changed?: string[]
  /**
   * Every write tool that ran out of time this turn and may or may not have
   * gone through (`maybe_done`), repeatable or not. None of them backs a reply
   * that says it was done, and none lets one say nothing changed.
   */
  maybeChanged?: string[]
  /** Cursor moves waiting on this turn's result reaching someone; see StagedCursor. */
  pendingCursors?: StagedCursor[]
  /**
   * Whose "what's new" markers this turn reads and moves, when not the chat's
   * own. A member's MCP client acts in the family group, but what it has seen
   * is not what the family has: its own scope stops it spending the group's
   * morning brief and 2Up posts.
   */
  cursorScope?: string
  /**
   * Whether what comes back is read in a room the family shares: a group chat,
   * where everyone sees what was asked for and what it turned up. A private
   * chat with the bot, an MCP client and a member's own scheduled instruction
   * are one member's alone, so there another member's mailbox stays out of
   * reach; see mailboxOwner, which in a group also wants its owner there.
   */
  shared?: boolean
}

export function requireMember(ctx: ToolContext): Member {
  if (!ctx.member) {
    throw new Error('This action needs a known family member. Send /start in a direct message first.')
  }
  return ctx.member
}

/**
 * Post a line in the chat on the tool's behalf, and say so in the tool result.
 * The line goes out under the model's reply whatever the model writes, so the
 * result asks the model to add only what the line does not already say. A
 * model that restates it anyway is caught on the way out; see lib/notices.ts.
 */
export function announce(ctx: ToolContext, line: string, also?: string): { posted: string; note: string } {
  ctx.notices.push(line)
  return { posted: line, note: also ? `${POSTED} ${also}` : POSTED }
}

const POSTED =
  'Hearth posts the `posted` line in the chat itself, straight after your reply. ' +
  'Do not say the same thing again in other words: reply with only whatever else is worth saying, or with nothing at all.'

/**
 * A write tool's result for what it caught. One whose request ran out of time
 * is still an error to the model, which must check rather than say it is done
 * or try again, and `maybe_done` has the turn count it as a write all the same
 * (see ToolContext.wrote).
 */
export function writeFailure(e: unknown, describe: (e: unknown) => string = describeError) {
  return e instanceof UnconfirmedError
    ? { error: `${e.message} Check before trying it again.`, maybe_done: true as const }
    : { error: describe(e) }
}
