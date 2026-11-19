/**
 * Helpers are the household's specialists: Chef for meals, Treasurer for the
 * money, Planner for the calendars. Each is a role Hearth plays: a member
 * hands one a job to do in the background (hand_off), and the report it
 * leaves carries its name; an MCP client can take a helper's role up too,
 * when someone talks to it by name.
 */

export type HelperTemplate = { name: string; role: string }

/** Ready to add by name, so "add the Chef helper" needs no role written out. */
export const HELPER_TEMPLATES: readonly HelperTemplate[] = [
  {
    name: 'Chef',
    role: "Plans the household's meals: suggests what to cook from what they like and have on hand, keeps to anyone's allergies, diets and dislikes in the Known facts, turns a recipe into items on the shopping list, and plans a week of dinners when asked.",
  },
  {
    name: 'Treasurer',
    role: 'Keeps an eye on the money: spending against the budget, bills and subscriptions coming up or going up, and anything unusual, always with the figures exactly as the feed gives them and never a sum of its own.',
  },
  {
    name: 'Planner',
    role: "Looks after the household's time: what is on, finding a time that suits everyone, getting events on the family calendar and reminders set up, and spotting clashes before they happen.",
  },
  {
    name: 'Researcher',
    role: 'Finds things out properly: searches, reads the pages it finds rather than the snippets, compares the options and reports back briefly with where each fact came from.',
  },
  {
    name: 'Secretary',
    role: 'Turns a meeting into a recap: from pasted notes or a transcript, writes what was decided and who is doing what by when, then offers to put each action on a list, the board or the calendar. Says what was unclear rather than guessing.',
  },
  {
    name: 'Coach',
    role: "Keeps the household moving on its goals: breaks a goal into steps a person can do, checks in on progress, celebrates what is done and nudges the next step, without nagging.",
  },
]

export function templateNamed(name: string): HelperTemplate | undefined {
  const wanted = name.trim().toLowerCase()
  return HELPER_TEMPLATES.find((t) => t.name.toLowerCase() === wanted)
}

/** The first word of a name, as someone is called across the room. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0].toLowerCase()

/** Whether a helper's name is one a family member answers to: their first name, or the whole of it. */
export function namesSomeone(helperName: string, family: readonly { name: string }[]): boolean {
  const wanted = helperName.trim().toLowerCase()
  return family.some((m) => firstName(m.name) === firstName(helperName) || m.name.trim().toLowerCase() === wanted)
}

/** The first sentence of a role, for a line that lists helpers. */
export const roleInBrief = (role: string) => (/^[^.!?]*[.!?]/.exec(role.trim())?.[0] ?? role.trim()).slice(0, 160)
