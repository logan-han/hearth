import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { sendMessage, sendChatAction, getFile } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_chatId: string | number, _text: string, _opts?: Record<string, unknown>) => ({})),
  sendChatAction: vi.fn(async (_chatId: string | number, _action: string) => true),
  getFile: vi.fn<(fileId: string) => Promise<{ file_path?: string; file_size?: number }>>(),
}))
vi.mock('grammy', () => ({
  Bot: class { api = { sendMessage, sendChatAction, getFile } },
}))

const { chunk, send, typing, downloadFile, MAX_FILE_BYTES } = await import('@/lib/telegram')

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TELEGRAM_BOT_TOKEN = 'tok'
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('chunk', () => {
  it('leaves short text alone', () => {
    expect(chunk('hello')).toEqual(['hello'])
  })

  it('never exceeds the limit', () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i} of the message`).join('\n')
    for (const part of chunk(text, 500)) expect(part.length).toBeLessThanOrEqual(500)
  })

  it('splits on the paragraph boundary when there is one', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`
    const parts = chunk(text, 100)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toBe('a'.repeat(60))
    expect(parts[1]).toBe('b'.repeat(60))
  })

  it('falls back to a line break, then a space', () => {
    expect(chunk(`${'a'.repeat(60)}\n${'b'.repeat(60)}`, 100)).toHaveLength(2)
    expect(chunk(`${'a'.repeat(60)} ${'b'.repeat(60)}`, 100)).toHaveLength(2)
  })

  it('hard-splits unbroken text', () => {
    const parts = chunk('x'.repeat(250), 100)
    expect(parts).toHaveLength(3)
    expect(parts.join('')).toBe('x'.repeat(250))
  })

  it('preserves all content across chunks', () => {
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`).join(' ')
    const parts = chunk(words, 200)
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(words)
  })

  it('defaults to the Telegram 4096-character cap', () => {
    const parts = chunk('y'.repeat(9000))
    expect(parts).toHaveLength(3)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096)
  })
})

describe('send', () => {
  it('converts the model markdown to telegram html', async () => {
    await send('-100', 'Done: **Footy Fever** on `2026-09-21`')
    expect(sendMessage.mock.calls[0][1]).toBe('Done: <b>Footy Fever</b> on <code>2026-09-21</code>')
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ parse_mode: 'HTML' })
  })

  it('retries as the untouched plain text when Telegram rejects the html', async () => {
    sendMessage.mockRejectedValueOnce(new Error("can't parse entities"))
    await send('-100', 'a *broken _markdown')
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ parse_mode: 'HTML' })
    expect(sendMessage.mock.calls[1][1]).toBe('a *broken _markdown')
    expect(sendMessage.mock.calls[1][2]).not.toHaveProperty('parse_mode')
  })

  it('replies to the triggering message only on the first chunk', async () => {
    await send('-100', 'y'.repeat(9000), 42)
    expect(sendMessage).toHaveBeenCalledTimes(3)
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ reply_parameters: { message_id: 42 } })
    expect(sendMessage.mock.calls[1][2]).not.toHaveProperty('reply_parameters')
  })

  it('omits reply parameters when there is nothing to reply to', async () => {
    await send('-100', 'hi')
    expect(sendMessage.mock.calls[0][2]).not.toHaveProperty('reply_parameters')
  })
})

describe('typing', () => {
  it('swallows failures, being cosmetic', async () => {
    sendChatAction.mockRejectedValueOnce(new Error('nope'))
    await expect(typing('-100')).resolves.toBeUndefined()
  })
})

describe('downloadFile', () => {
  it('resolves the path then fetches from the file host', async () => {
    getFile.mockResolvedValue({ file_path: 'photos/f.jpg', file_size: 1000 })
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
    const out = await downloadFile('fid')
    expect(out.path).toBe('photos/f.jpg')
    expect(out.bytes).toHaveLength(3)
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.telegram.org/file/bottok/photos/f.jpg')
  })

  it('refuses a file over the Bot API limit before downloading it', async () => {
    getFile.mockResolvedValue({ file_path: 'big.zip', file_size: MAX_FILE_BYTES + 1 })
    await expect(downloadFile('fid')).rejects.toThrow(/20 MB limit/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails clearly when Telegram gives no path', async () => {
    getFile.mockResolvedValue({})
    await expect(downloadFile('fid')).rejects.toThrow(/no file path/)
  })

  it('reports a failed download with its status', async () => {
    getFile.mockResolvedValue({ file_path: 'photos/f.jpg', file_size: 10 })
    fetchMock.mockResolvedValue({ ok: false, status: 404 })
    await expect(downloadFile('fid')).rejects.toThrow(/404/)
  })
})
