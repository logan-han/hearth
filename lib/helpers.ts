import type { Helper } from './db/schema'
import { opensWithName } from './env'
import { GROUP_NAMES, type ToolGroup } from './tools/router'

/**
 * Helpers are the household's specialists: Chef for meals, Treasurer for the
 * money, Planner for the calendars. Each is a role the one bot plays, with
 * the tool groups that role reaches for first, and the family talks to one by
 * opening a message with its name ("Chef, what can I make with leeks?"), the
 * way they would call across the kitchen. Its replies come signed with its
 * name, so a group can tell who is speaking; and any of them, or the bot
 * itself, can hand a job to a helper to do in the background and post when
 * it is done.
 */

export type HelperTemplate = { name: string; role: string; groups: ToolGroup[] }

/** Ready to add by name, so "add the Chef helper" needs no role written out. */
export const HELPER_TEMPLATES: readonly HelperTemplate[] = [
  {
    name: 'Chef',
    role: "Plans the household's meals: suggests what to cook from what they like and have on hand, keeps to anyone's allergies, diets and dislikes in the Known facts, turns a recipe into items on the shopping list, and plans a week of dinners when asked.",
    groups: ['kitchen'],
  },
  {
    name: 'Treasurer',
    role: 'Keeps an eye on the money: spending against the budget, bills and subscriptions coming up or going up, and anything unusual, always with the figures exactly as the feed gives them and never a sum of its own.',
    groups: ['money', 'mail'],
  },
  {
    name: 'Planner',
    role: "Looks after the household's time: what is on, finding a time that suits everyone, getting events on the family calendar and reminders set up, and spotting clashes before they happen.",
    groups: ['personal_calendar', 'automations'],
  },
  {
    name: 'Researcher',
    role: 'Finds things out properly: searches, reads the pages it finds rather than the snippets, compares the options and reports back briefly with where each fact came from.',
    groups: [],
  },
  {
    name: 'Secretary',
    role: 'Turns a meeting into a recap: from a voice note, a photo of the notes or a pasted transcript, writes what was decided and who is doing what by when, then offers to put each action on a list, the board or the calendar. Says what was unclear rather than guessing.',
    groups: ['jira', 'automations'],
  },
  {
    name: 'Coach',
    role: "Keeps the household moving on its goals: breaks a goal into steps a person can do, checks in on progress, celebrates what is done and nudges the next step, without nagging.",
    groups: ['goals', 'automations'],
  },
]

export function templateNamed(name: string): HelperTemplate | undefined {
  const wanted = name.trim().toLowerCase()
  return HELPER_TEMPLATES.find((t) => t.name.toLowerCase() === wanted)
}

const isGroup = (g: unknown): g is ToolGroup => typeof g === 'string' && (GROUP_NAMES as string[]).includes(g)

/** The tool groups a helper starts its turns with, as stored; anything no longer a group is passed over. */
export function helperGroups(helper: Pick<Helper, 'groups'>): ToolGroup[] {
  try {
    const parsed: unknown = JSON.parse(helper.groups)
    return Array.isArray(parsed) ? parsed.filter(isGroup) : []
  } catch {
    return []
  }
}

/** The first word of a name, as someone is called across the room. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0].toLowerCase()

/** Whether a helper's name is one a family member answers to: their first name, or the whole of it. */
export function namesSomeone(helperName: string, family: readonly { name: string }[]): boolean {
  const wanted = helperName.trim().toLowerCase()
  return family.some((m) => firstName(m.name) === firstName(helperName) || m.name.trim().toLowerCase() === wanted)
}

/**
 * The helpers a message may call: none whose name a family member has come
 * to share since it was made, someone joining or being renamed. "Max, are
 * you coming?" across the group chat is for Max.
 */
export function callable(crew: readonly Helper[], family: readonly { name: string }[]): Helper[] {
  return crew.filter((h) => !namesSomeone(h.name, family))
}

/** The helper a message calls by name at its start, if any. */
export function calledHelper(text: string, all: readonly Helper[]): Helper | undefined {
  return all.find((h) => opensWithName(text, h.name))
}

/**
 * The helper whose message is being replied to, by the name it signed it
 * with, so a reply to Chef goes on with Chef without being called again.
 * Telegram hands the replied-to text over without its bold.
 */
export function repliedHelper(replyText: string | undefined, all: readonly Helper[]): Helper | undefined {
  if (!replyText) return undefined
  const head = replyText.trimStart().toLowerCase()
  return all.find((h) => head.startsWith(`${h.name.toLowerCase()}:`))
}

/** A message as the chat shows it, signed by the helper that wrote it. */
export function signed(helper: Pick<Helper, 'name'> | null | undefined, text: string): string {
  return helper && text ? `**${helper.name}:** ${text}` : text
}

/** The first sentence of a role, for a line that lists helpers. */
export const roleInBrief = (role: string) => (/^[^.!?]*[.!?]/.exec(role.trim())?.[0] ?? role.trim()).slice(0, 160)
