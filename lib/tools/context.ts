import type { Member } from '../db/schema'
import type { ParsedIcs } from '../ics-parse'

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
