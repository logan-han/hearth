import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.mock factories are hoisted above ordinary consts, so the doubles they
// close over have to be hoisted too.
const { downloadFile, runAgent, recordMessage, send } = vi.hoisted(() => ({
  downloadFile: vi.fn<(id: string) => Promise<{ bytes: Uint8Array; path: string }>>(),
  runAgent: vi.fn(
    async (_input: { text: string; attachments?: { mediaType: string; kind: string }[] }) => ({
      text: 'Looks like school photo day.',
      notices: [] as string[],
      model: 'gemini',
    }),
  ),
  recordMessage: vi.fn(async () => 1),
  send: vi.fn(async () => {}),
}))

vi.mock('@/lib/telegram', async (orig) => ({
  ...(await orig<typeof import('@/lib/telegram')>()),
  downloadFile,
  send,
  typing: vi.fn(async () => {}),
  bot: () => ({ api: { getMe: async () => ({ id: 1, username: 'heart_family_bot' }) } }),
}))
vi.mock('@/lib/agent', () => ({ runAgent, shouldChimeIn: vi.fn(async () => false) }))
vi.mock('@/lib/db/queries', () => ({
  upsertMember: vi.fn(async () => ({ id: 3, telegramUserId: '111', name: 'Logan', allowed: true, isAdmin: true })),
  memberByTelegramId: vi.fn(async () => undefined),
  setMemberAllowed: vi.fn(async () => undefined),
  allowedMembers: vi.fn(async () => []),
  rememberChat: vi.fn(async () => {}),
  strangersIn: vi.fn(async () => []),
  noteStranger: vi.fn(async () => true),
  clearStranger: vi.fn(async () => {}),
  recordMessage,
  pruneMessages: vi.fn(async () => {}),
  connectionsFor: vi.fn(async () => []),
  deleteConnection: vi.fn(async () => {}),
  calendarToken: vi.fn(async () => 'tok'),
}))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => p }))

const { processUpdate } = await import('@/lib/handler')
const { mediaTypeFor } = await import('@/lib/telegram')

const photoUpdate = (caption?: string) => ({
  update_id: 1,
  message: {
    message_id: 5, date: 1787000000,
    from: { id: 111, is_bot: false, first_name: 'Logan' },
    chat: { id: 111, type: 'private' },
    photo: [
      { file_id: 'small', file_unique_id: 'a', width: 90, height: 90 },
      { file_id: 'large', file_unique_id: 'b', width: 1280, height: 1280 },
    ],
    ...(caption ? { caption } : {}),
  },
}) as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.ALLOWED_TELEGRAM_IDS = '111'
  downloadFile.mockResolvedValue({ bytes: new Uint8Array([137, 80, 78, 71]), path: 'photos/file_1.jpg' })
})

describe('mediaTypeFor', () => {
  it('prefers what Telegram declared', () => {
    expect(mediaTypeFor('x.bin', 'image/png')).toBe('image/png')
  })

  it('falls back to the extension', () => {
    expect(mediaTypeFor('photos/file_1.jpg')).toBe('image/jpeg')
    expect(mediaTypeFor('docs/notice.pdf')).toBe('application/pdf')
    expect(mediaTypeFor('voice/note.oga')).toBe('audio/ogg')
  })

  it('ignores a useless declared type', () => {
    expect(mediaTypeFor('a.png', 'application/octet-stream')).toBe('image/png')
  })

  it('gives up honestly on something unknown', () => {
    expect(mediaTypeFor('mystery.xyz')).toBe('application/octet-stream')
  })
})

describe('photos', () => {
  it('takes the largest resolution Telegram offers', async () => {
    await processUpdate(photoUpdate())
    expect(downloadFile).toHaveBeenCalledWith('large')
    expect(downloadFile).not.toHaveBeenCalledWith('small')
  })

  it('answers a photo sent with no caption at all', async () => {
    await processUpdate(photoUpdate())
    expect(runAgent).toHaveBeenCalled()
    const arg = runAgent.mock.calls[0][0]
    expect(arg.attachments).toHaveLength(1)
    expect(arg.text).toBe('')
  })

  it('passes the caption through alongside the image', async () => {
    await processUpdate(photoUpdate('is this the sports day notice?'))
    const arg = runAgent.mock.calls[0][0]
    expect(arg.text).toBe('is this the sports day notice?')
    expect(arg.attachments?.[0].mediaType).toBe('image/jpeg')
  })

  it('notes the attachment in the text-only history', async () => {
    await processUpdate(photoUpdate('look'))
    expect(recordMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'look [sent photo]' }))
  })

  it('degrades to a text reply when the download fails', async () => {
    downloadFile.mockRejectedValue(new Error('file is 25 MB, over the 20 MB limit'))
    await processUpdate(photoUpdate('what is this'))
    const arg = runAgent.mock.calls[0][0]
    expect(arg.attachments).toHaveLength(0)
    expect(runAgent).toHaveBeenCalled()
  })

  it('ignores a file type no model can read', async () => {
    downloadFile.mockResolvedValue({ bytes: new Uint8Array([1]), path: 'files/archive.zip' })
    await processUpdate({
      update_id: 2,
      message: {
        message_id: 6, date: 1787000000,
        from: { id: 111, is_bot: false, first_name: 'Logan' },
        chat: { id: 111, type: 'private' },
        document: { file_id: 'z', file_unique_id: 'z', file_name: 'archive.zip' },
        caption: 'here',
      },
    } as never)
    const arg = runAgent.mock.calls[0][0]
    expect(arg.attachments).toHaveLength(0)
  })

  it('still drops a message with neither text nor a readable attachment', async () => {
    await processUpdate({
      update_id: 3,
      message: {
        message_id: 7, date: 1787000000,
        from: { id: 111, is_bot: false, first_name: 'Logan' },
        chat: { id: 111, type: 'private' },
      },
    } as never)
    expect(runAgent).not.toHaveBeenCalled()
  })
})
