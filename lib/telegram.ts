import { Bot } from 'grammy'
import { required } from './env'
import { toTelegramHtml } from './telegram-format'

const MAX_LEN = 4096

let _bot: { token: string; bot: Bot } | null = null

export function bot(): Bot {
  const token = required('TELEGRAM_BOT_TOKEN')
  // Keyed by token: the dashboard can swap the token at runtime, and a memo
  // that ignored that would keep talking as the old bot until the next cold start.
  if (_bot?.token !== token) {
    _bot = { token, bot: new Bot(token) }
    // Webhook mode: we never call bot.start(), but grammY still needs bot info
    // for filters like `mention`. It is fetched lazily on first `init()`.
  }
  return _bot.bot
}

/** Split on paragraph/line boundaries so Telegram's 4096-char cap never truncates. */
export function chunk(text: string, max = MAX_LEN): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut <= 0) cut = max
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Send a possibly-long reply, chunked. Each part is converted from the
 * model's Markdown to Telegram HTML; a part Telegram still rejects goes out
 * as plain text rather than not at all. Chunks stop short of the 4096 cap so
 * the HTML tags have room.
 */
export async function send(chatId: string | number, text: string, replyTo?: number): Promise<void> {
  const b = bot()
  const parts = chunk(text, 3800)
  for (const [i, part] of parts.entries()) {
    const opts = i === 0 && replyTo ? { reply_parameters: { message_id: replyTo } } : {}
    try {
      await b.api.sendMessage(chatId, toTelegramHtml(part), { parse_mode: 'HTML', ...opts })
    } catch {
      await b.api.sendMessage(chatId, part, opts)
    }
  }
}

export async function typing(chatId: string | number): Promise<void> {
  try {
    await bot().api.sendChatAction(chatId, 'typing')
  } catch {
    // Non-fatal; the typing indicator is cosmetic.
  }
}

/** Telegram's Bot API will not hand back files larger than 20 MB. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

export type Attachment = {
  bytes: Uint8Array
  mediaType: string
  filename?: string
  kind: 'photo' | 'voice' | 'document'
}

/**
 * Fetch a file the user sent. Two round trips: getFile resolves the path, then
 * the file itself comes from a different host that wants the token in the URL.
 */
export async function downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
  const b = bot()
  const file = await b.api.getFile(fileId)
  if (!file.file_path) throw new Error('Telegram returned no file path')
  if ((file.file_size ?? 0) > MAX_FILE_BYTES) {
    throw new Error(`File is ${Math.round((file.file_size ?? 0) / 1e6)} MB, over the 20 MB limit`)
  }
  const res = await fetch(`https://api.telegram.org/file/bot${required('TELEGRAM_BOT_TOKEN')}/${file.file_path}`)
  if (!res.ok) throw new Error(`Could not download the file (${res.status})`)
  return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path }
}

const EXT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf',
  oga: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  ics: 'text/calendar', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
}

/** Best-effort media type, preferring what Telegram told us over the extension. */
export function mediaTypeFor(path: string, declared?: string): string {
  if (declared && declared !== 'application/octet-stream') return declared
  return EXT_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}
