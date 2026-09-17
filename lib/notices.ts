/**
 * A tool that changes something the family can see posts a line about it on
 * its own behalf, such as the line announcing an event just added to the
 * family calendar, because a subscribed calendar can take hours to show the
 * change. The line goes out under the model's reply. The tool result tells
 * the model so and asks it to add only what else is worth saying, but a small
 * model restates the line anyway, in its own words and its own date format,
 * and two confirmations of one event read as a stutter.
 *
 * So a notice is left out when the reply already says what it says: every
 * bold subject in the notice turns up in the reply, markup and case aside.
 * Both draw their facts from the same tool result, so the reader loses
 * nothing but the echo. A notice with no bold subject stays unless the reply
 * quotes it whole.
 */
export function unsaid(text: string, notices: readonly string[]): string[] {
  const said = plain(text)
  return notices.filter((notice) => {
    if (said.includes(plain(notice))) return false
    const subjects = [...notice.matchAll(/\*\*(.+?)\*\*/g)].map((m) => plain(m[1])).filter(Boolean)
    return subjects.length === 0 || !subjects.every((s) => said.includes(s))
  })
}

/** Lower-case words with markdown emphasis and stray spacing taken off, so only the wording is compared. */
const plain = (s: string) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
