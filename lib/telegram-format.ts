/**
 * The model writes standard Markdown; Telegram's legacy 'Markdown' parse mode
 * speaks a different dialect, rejects half of it, and the plain-text fallback
 * then prints the asterisks literally. HTML is the one Telegram format whose
 * escaping is tractable (&, <, > and nothing else), so replies are converted
 * to that instead of hoping two dialects happen to agree.
 *
 * Telegram has no headings, rules, lists or tables, and since Bot API 7.0 it
 * has blockquotes, which fold once marked expandable. So headings become bold,
 * rules go, bullets become the bullet character, a pipe table becomes aligned
 * monospace lines, and a run of `>` lines becomes one quote, folded when it
 * is long enough to be worth folding.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** A quote longer than this folds, so a long tail reads as a card with a detail toggle. */
const FOLD_LINES = 3

export function toTelegramHtml(text: string): string {
  // Code first, fenced then inline: nothing inside it is formatting, and its
  // content must dodge the emphasis passes below. Parked behind sentinels the
  // model cannot produce (NUL never survives Telegram input).
  const parked: string[] = []
  const park = (html: string) => `\u0000${parked.push(html) - 1}\u0000`

  let out = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, body: string) =>
    park(`<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`),
  )
  // Tables while their cells are still Markdown, and before inline code is
  // parked, so a backtick in a cell is stripped rather than nested in a span.
  out = replaceTables(out, (lines) => park(lines.map((line) => `<code>${escapeHtml(line)}</code>`).join('\n')))
  out = out.replace(/`([^`\n]+)`/g, (_, body: string) => park(`<code>${escapeHtml(body)}</code>`))

  out = escapeHtml(out)

  // Links before emphasis, so underscores in URLs survive.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
  )

  out = out
    .replace(/\*\*([^*\n](?:[^*\n]*[^*\n\s])?)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n](?:[^_\n]*[^_\n\s])?)__/g, '<b>$1</b>')
    // Word-boundary guards keep snake_case identifiers and 2*3 arithmetic intact.
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '<i>$1</i>')
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '<i>$1</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')

  // Telegram has no headings, rules or list markup: bold the heading text,
  // drop rules, and use a real bullet character.
  out = out
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')

  // A run of quoted lines is one blockquote. The emphasis inside is already
  // HTML; a bullet inside still needs its character.
  out = out.replace(/(?:^&gt;[ \t]?.*(?:\n|$))+/gm, (block) => {
    const trailing = block.endsWith('\n') ? '\n' : ''
    const lines = block
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => line.replace(/^&gt;[ \t]?/, '').replace(/^(\s*)[-*]\s+/, '$1• '))
    const open = lines.length > FOLD_LINES ? '<blockquote expandable>' : '<blockquote>'
    return `${open}${lines.join('\n')}</blockquote>${trailing}`
  })

  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => parked[Number(i)])
}

/* ------------------------------------------------------------------ tables */

const ROW = /^\s*\|.*\|\s*$/
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/
/** A cell that opens with a figure: a sign, a currency sign or a digit. "20 of 30 days" counts, a payee name does not. */
const FIGURE = /^[-+−]?\$?\d/

/** A monospace span cannot hold other entities, so a cell's emphasis is stripped, not converted. */
function plainCell(cell: string): string {
  return cell
    .trim()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(plainCell)
}

/**
 * Pad the columns square. Figures line up on the right, like a ledger; words
 * on the left. A header row's words do not decide a column's alignment, and
 * a table need not have one: an empty header row (| | |) is dropped, so a
 * few totals can be laid out with nothing above them.
 */
export function layoutTable(rows: string[][]): string[] {
  const headed = !rows[0].every((c) => c === '')
  const kept = headed ? rows : rows.slice(1)
  if (kept.length === 0) return []
  const width = Math.max(...kept.map((r) => r.length))
  const grid = kept.map((r) => [...r, ...Array<string>(width - r.length).fill('')])
  const len = (s: string) => [...s].length
  const widths = grid[0].map((_, c) => Math.max(...grid.map((r) => len(r[c]))))
  const body = headed ? grid.slice(1) : grid
  const numeric = grid[0].map((_, c) => body.length > 0 && body.every((r) => r[c] === '' || FIGURE.test(r[c])))
  return grid.map((r) => r.map((cell, c) => (numeric[c] ? cell.padStart(widths[c]) : cell.padEnd(widths[c]))).join('  ').trimEnd())
}

/**
 * Each pipe table (a header row, a separator, then rows) becomes whatever
 * `render` makes of its aligned lines. Telegram has no table element, and a
 * monospace font is the one way to line columns up; it comes in two forms. A
 * <pre> block is what the apps draw as a code box, grey and padded with a
 * copy button in its corner, and a money snapshot in one read as broken. A
 * <code> span is the same font without the box, so each line goes out as its
 * own span and the lines stack into a table.
 */
export function replaceTables(text: string, render: (lines: string[]) => string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    if (ROW.test(lines[i]) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
      const rows = [cells(lines[i])]
      let j = i + 2
      while (j < lines.length && ROW.test(lines[j])) rows.push(cells(lines[j++]))
      const laid = layoutTable(rows)
      if (laid.length) out.push(render(laid))
      i = j
    } else {
      out.push(lines[i++])
    }
  }
  return out.join('\n')
}
