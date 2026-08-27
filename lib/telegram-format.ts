/**
 * The model writes standard Markdown; Telegram's legacy 'Markdown' parse mode
 * speaks a different dialect, rejects half of it, and the plain-text fallback
 * then prints the asterisks literally. HTML is the one Telegram format whose
 * escaping is tractable (&, <, > and nothing else), so replies are converted
 * to that instead of hoping two dialects happen to agree.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function toTelegramHtml(text: string): string {
  // Code first, fenced then inline: nothing inside it is formatting, and its
  // content must dodge the emphasis passes below. Parked behind sentinels the
  // model cannot produce (NUL never survives Telegram input).
  const parked: string[] = []
  const park = (html: string) => `\u0000${parked.push(html) - 1}\u0000`

  let out = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, body: string) =>
    park(`<pre>${escapeHtml(body.replace(/\n$/, ''))}</pre>`),
  )
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

  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => parked[Number(i)])
}
