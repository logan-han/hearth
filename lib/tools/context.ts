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
}

export function requireMember(ctx: ToolContext): Member {
  if (!ctx.member) {
    throw new Error('This action needs a known family member. Send /start in a direct message first.')
  }
  return ctx.member
}
