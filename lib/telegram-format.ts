/**
 * The model writes standard Markdown; Telegram's legacy 'Markdown' parse mode
 * speaks a different dialect, rejects half of it, and the plain-text fallback
 * then prints the asterisks literally. HTML is the one Telegram format whose
 * escaping is tractable (&, <, > and nothing else), so replies are converted
 * to that instead of hoping two dialects happen to agree.
 *
 * Telegram has no headings, rules, lists or tables, and since Bot API 7.0 it
 * has blockquotes, which fold once marked expandable. So headings become bold,
 * rules go, bullets become the bullet character, a pipe table becomes lines
 * of **label**: value, and a run of `>` lines becomes one quote, folded when
 * it is long enough to be worth folding.
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
  // parked, so a backtick in a cell is stripped rather than parked. The lines
  // they become carry **bold** labels, which the emphasis pass below converts.
  out = tablesToLines(out)
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
/** A figure as a snapshot writes one: an optional sign, currency, thousands and a percent. */
const FIGURE = /^[-+−]?\$?\d[\d,]*(?:\.\d+)?%?$/
/** Between the figures of one row, once they share a line. */
const BETWEEN = ' · '

/** A cell's own emphasis is stripped: the label gets the bold, and a figure needs none. */
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

const bold = (s: string) => (s ? `**${s}**` : '')
const labelled = (label: string, value: string) => (label && value ? `${bold(label)}: ${value}` : bold(label) || value)

/**
 * A table as lines. Telegram has no table element, and the monospace block
 * that can hold columns arrives as a code box, grey with a copy button and
 * wider than a phone once the headers are words; so each row becomes one
 * line, its first cell the **bold** label and the rest its figures. A table
 * of one row of figures under several headers, the shape a model reaches for
 * to line up a few totals, is turned on its side: each header labels its own
 * figure. With three or more columns the headers ride along, or the figures
 * would lose their meaning once the columns are gone.
 */
export function tableToLines(rows: string[][]): string[] {
  const [header = [], ...body] = rows
  if (body.length === 0) return [header.filter(Boolean).join(BETWEEN)].filter(Boolean)
  if (body.length === 1 && FIGURE.test(body[0][0] ?? '')) {
    return header.map((h, c) => labelled(h, body[0][c] ?? '')).filter(Boolean)
  }
  const wide = header.length > 2
  return body.map(([first = '', ...rest]) => {
    const figures = rest
      .map((v, i) => (wide && header[i + 1] && v ? `${header[i + 1]} ${v}` : v))
      .filter(Boolean)
      .join(BETWEEN)
    return labelled(first, figures)
  })
}

/** Each pipe table (a header row, a separator, then rows) becomes its lines, in place. */
export function tablesToLines(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    if (ROW.test(lines[i]) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
      const rows = [cells(lines[i])]
      let j = i + 2
      while (j < lines.length && ROW.test(lines[j])) rows.push(cells(lines[j++]))
      out.push(...tableToLines(rows))
      i = j
    } else {
      out.push(lines[i++])
    }
  }
  return out.join('\n')
}
