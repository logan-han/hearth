import { describe, it, expect, beforeEach, vi } from 'vitest'

// vi.mock factories are hoisted above ordinary consts, so the doubles they
// close over have to be hoisted too.
const { downloadFile, runAgent, recordMessage, send, memberByTelegramId, albums } = vi.hoisted(() => ({
  downloadFile: vi.fn<(id: string, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; path: string }>>(),
  runAgent: vi.fn(
    async (_input: { text: string; attachments?: { mediaType: string; kind: string }[]; deadline?: number }) => ({
      text: 'Looks like school photo day.',
      notices: [] as string[],
      model: 'gemini',
    }),
  ),
  recordMessage: vi.fn(async () => 1),
  send: vi.fn(async (_chatId: string, _text: string, _replyTo?: number) => {}),
  memberByTelegramId: vi.fn(async (_id: string) => undefined as unknown),
  albums: new Map<string, { messageId: number }[]>(),
}))

vi.mock('@/lib/telegram', async (orig) => ({
  ...(await orig<typeof import('@/lib/telegram')>()),
  downloadFile,
  send,
  typing: vi.fn(async () => {}),
  bot: () => ({ api: { getMe: async () => ({ id: 1, username: 'heart_family_bot' }) } }),
}))
vi.mock('@/lib/agent', () => ({ runAgent, shouldChimeIn: vi.fn(async () => false) }))
vi.mock('@/lib/summary', () => ({ maybeSummarise: vi.fn(async () => false) }))
vi.mock('@/lib/db/queries', () => ({
  upsertMember: vi.fn(async () => ({ id: 3, telegramUserId: '111', name: 'Rowan', allowed: true, isAdmin: true })),
  memberByTelegramId,
  setMemberAllowed: vi.fn(async () => undefined),
  allowedMembers: vi.fn(async () => []),
  rememberChat: vi.fn(async () => {}),
  strangersIn: vi.fn(async () => []),
  noteStranger: vi.fn(async () => true),
  clearStranger: vi.fn(async () => {}),
  clearStrangerEverywhere: vi.fn(async () => {}),
  recordMessage,
  pruneMessages: vi.fn(async () => {}),
  connectionsFor: vi.fn(async () => []),
  deleteConnection: vi.fn(async () => {}),
  calendarToken: vi.fn(async () => 'tok'),
}))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => p }))

// The chat's turn and an album's items are held in the database; here a map
// stands in for the album rows, emptied by the first take.
vi.mock('@/lib/turns', () => ({
  awaitTurn: vi.fn(async () => 'hold'),
  endTurn: vi.fn(async () => {}),
  noteAlbumItem: vi.fn(async (chatId: string, albumId: string, item: { messageId: number }) => {
    albums.set(`${chatId}:${albumId}`, [...(albums.get(`${chatId}:${albumId}`) ?? []), item])
  }),
  takeAlbum: vi.fn(async (chatId: string, albumId: string) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const items = albums.get(`${chatId}:${albumId}`)
    albums.delete(`${chatId}:${albumId}`)
    return items?.sort((a, b) => a.messageId - b.messageId) ?? null
  }),
}))

const { processUpdate } = await import('@/lib/handler')
const { mediaTypeFor } = await import('@/lib/telegram')
const { awaitTurn } = await import('@/lib/turns')

const photoUpdate = (caption?: string) => ({
  update_id: 1,
  message: {
    message_id: 5, date: 1787000000,
    from: { id: 111, is_bot: false, first_name: 'Rowan' },
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
  albums.clear()
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
    expect(downloadFile).toHaveBeenCalledWith('large', expect.any(AbortSignal))
    expect(downloadFile).not.toHaveBeenCalledWith('small', expect.anything())
  })

  it('answers a photo sent with no caption at all', async () => {
    await processUpdate(photoUpdate())
    expect(runAgent).toHaveBeenCalled()
    const arg = runAgent.mock.calls[0][0]
    expect(arg.attachments).toHaveLength(1)
    expect(arg.text).toBe('')
  })

  it('passes the caption through alongside the image', async () => {
    await processUpdate(photoUpdate('is this the athletics carnival notice?'))
    const arg = runAgent.mock.calls[0][0]
    expect(arg.text).toBe('is this the athletics carnival notice?')
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

  it('keeps a calendar file, naming it in the history so a later mention makes sense', async () => {
    downloadFile.mockResolvedValue({ bytes: new TextEncoder().encode('BEGIN:VCALENDAR\r\nEND:VCALENDAR'), path: 'documents/file_2.ics' })
    await processUpdate({
      update_id: 4,
      message: {
        message_id: 8, date: 1787000000,
        from: { id: 111, is_bot: false, first_name: 'Rowan' },
        chat: { id: 111, type: 'private' },
        document: { file_id: 'i', file_unique_id: 'i', file_name: 'cuboree.ics', mime_type: 'text/calendar' },
        caption: 'Add uploaded .ics file into family calendar',
      },
    } as never)
    const arg = runAgent.mock.calls[0][0]
    expect(arg.attachments).toHaveLength(1)
    expect(arg.attachments?.[0]).toMatchObject({ mediaType: 'text/calendar', kind: 'document' })
    expect(recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Add uploaded .ics file into family calendar [sent document cuboree.ics]' }),
    )
  })

  it('works out the type of a calendar file from its name when Telegram gives none', () => {
    expect(mediaTypeFor('documents/file_2.ics')).toBe('text/calendar')
    expect(mediaTypeFor('notes.txt', 'application/octet-stream')).toBe('text/plain')
  })

  it('ignores a file type no model can read', async () => {
    downloadFile.mockResolvedValue({ bytes: new Uint8Array([1]), path: 'files/archive.zip' })
    await processUpdate({
      update_id: 2,
      message: {
        message_id: 6, date: 1787000000,
        from: { id: 111, is_bot: false, first_name: 'Rowan' },
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
        from: { id: 111, is_bot: false, first_name: 'Rowan' },
        chat: { id: 111, type: 'private' },
      },
    } as never)
    expect(runAgent).not.toHaveBeenCalled()
  })
})

describe('voice, audio and unlabelled files', () => {
  const withMedia = (media: Record<string, unknown>) => ({
    update_id: 2,
    message: {
      message_id: 6, date: 1787000000,
      from: { id: 111, is_bot: false, first_name: 'Rowan' },
      chat: { id: 111, type: 'private' },
      ...media,
    },
  }) as never
  const attachmentsSent = () =>
    (runAgent.mock.calls[0][0] as { attachments: { mediaType: string; kind: string; filename?: string }[] }).attachments

  it('reads a voice note and an audio file as voice attachments, named for the model', async () => {
    downloadFile.mockResolvedValue({ bytes: new Uint8Array([79, 103, 103, 83]), path: 'voice/file_2.oga' })
    await processUpdate(withMedia({ voice: { file_id: 'v1', duration: 3, mime_type: 'audio/ogg' } }))
    expect(attachmentsSent()).toEqual([expect.objectContaining({ kind: 'voice', mediaType: 'audio/ogg', filename: 'voice.oga' })])

    runAgent.mockClear()
    await processUpdate(withMedia({ audio: { file_id: 'a1', duration: 3, mime_type: 'audio/mpeg', file_name: 'song.mp3' } }))
    expect(attachmentsSent()).toEqual([expect.objectContaining({ kind: 'voice', mediaType: 'audio/mpeg', filename: 'song.mp3' })])
  })

  it('recognises a calendar export by its contents when the type and name say nothing', async () => {
    downloadFile.mockResolvedValue({ bytes: new TextEncoder().encode('BEGIN:VCALENDAR\nEND:VCALENDAR'), path: 'documents/file_3' })
    await processUpdate(withMedia({ document: { file_id: 'd1', mime_type: 'application/octet-stream', file_name: 'invite.bin' } }))
    expect(attachmentsSent()).toEqual([expect.objectContaining({ kind: 'document', mediaType: 'text/calendar', filename: 'invite.bin' })])
  })
})

describe('nothing is fetched before it is wanted', () => {
  const sent = (from: number, chat: { id: number; type: string }, media: Record<string, unknown>) => ({
    update_id: 3,
    message: {
      message_id: 9, date: 1787000000,
      from: { id: from, is_bot: false, first_name: `User${from}` },
      chat: { ...chat, title: 'Family' },
      ...media,
    },
  }) as never
  const dm = { id: 111, type: 'private' }

  it('downloads nothing a stranger sends', async () => {
    const pdf = { file_id: 'big', file_unique_id: 'big', file_name: 'notice.pdf', mime_type: 'application/pdf' }
    await processUpdate(sent(999, { id: 999, type: 'private' }, { document: pdf }))
    expect(downloadFile).not.toHaveBeenCalled()
  })

  it('downloads nothing from a group message nobody addressed, though the history still says a photo was sent', async () => {
    const photo = [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }]
    await processUpdate(sent(111, { id: -100, type: 'group' }, { photo, caption: 'look at this' }))
    expect(downloadFile).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
    expect(recordMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'look at this [sent photo]' }))
  })

  it('never fetches a document whose declared type no model reads, but still fetches a calendar export however it is labelled', async () => {
    const zip = { file_id: 'zip', file_unique_id: 'zip', file_name: 'photos.zip', mime_type: 'application/zip' }
    await processUpdate(sent(111, dm, { document: zip, caption: 'here' }))
    expect(downloadFile).not.toHaveBeenCalled()
    expect(runAgent.mock.calls[0][0].attachments).toHaveLength(0)

    downloadFile.mockResolvedValue({ bytes: new TextEncoder().encode('BEGIN:VCALENDAR\nEND:VCALENDAR'), path: 'documents/file_4.ics' })
    const ics = { file_id: 'ics', file_unique_id: 'ics', file_name: 'camp.ics', mime_type: 'application/ics' }
    await processUpdate(sent(111, dm, { document: ics }))
    expect(downloadFile).toHaveBeenCalledWith('ics', expect.any(AbortSignal))
    expect(runAgent.mock.calls[1][0].attachments).toEqual([expect.objectContaining({ mediaType: 'text/calendar' })])
  })

  it('says nothing when a file with no caption turns out to be nothing a model reads', async () => {
    downloadFile.mockResolvedValue({ bytes: new Uint8Array([80, 75, 3, 4]), path: 'documents/file_5' })
    const blob = { file_id: 'blob', file_unique_id: 'blob', file_name: 'scan.bin', mime_type: 'application/octet-stream' }
    await processUpdate(sent(111, dm, { document: blob }))
    expect(downloadFile).toHaveBeenCalledWith('blob', expect.any(AbortSignal))
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('an album', () => {
  const page = (n: number, chat: { id: number; type: string }, caption?: string) => ({
    update_id: 20 + n,
    message: {
      message_id: 30 + n, date: 1787000000, media_group_id: 'notice',
      from: { id: 111, is_bot: false, first_name: 'Rowan' },
      chat: { ...chat, title: 'Family' },
      photo: [{ file_id: `page${n}`, file_unique_id: `page${n}`, width: 1280, height: 1280 }],
      ...(caption ? { caption } : {}),
    },
  }) as never

  it('is answered once in a DM, with every page and the caption, however many updates it came as', async () => {
    const dm = { id: 111, type: 'private' }
    await Promise.all([processUpdate(page(1, dm, 'add these dates')), processUpdate(page(2, dm)), processUpdate(page(3, dm))])
    expect(runAgent).toHaveBeenCalledTimes(1)
    const arg = runAgent.mock.calls[0][0]
    expect(arg.text).toBe('add these dates')
    expect(arg.attachments).toHaveLength(3)
    expect(downloadFile.mock.calls.map(([id]) => id)).toEqual(['page1', 'page2', 'page3'])
    expect(send).toHaveBeenCalledTimes(1)
    // Each page is still a line of history of its own, besides the reply.
    expect(recordMessage).toHaveBeenCalledTimes(4)
  })

  it('is read whole in a group, where only the captioned page is addressed to the bot', async () => {
    const group = { id: -100, type: 'group' }
    await Promise.all([
      processUpdate(page(1, group)),
      processUpdate(page(2, group, '@heart_family_bot add these dates')),
      processUpdate(page(3, group)),
    ])
    expect(runAgent).toHaveBeenCalledTimes(1)
    expect(runAgent.mock.calls[0][0].attachments).toHaveLength(3)
    expect(runAgent.mock.calls[0][0].text).toBe('add these dates')
    // The reply threads onto the page that asked.
    expect(send).toHaveBeenCalledWith('-100', 'Looks like school photo day.', 32)
  })

  it('leaves out the pages still to fetch once the downloads\' time is gone, and answers with what came', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const dm = { id: 111, type: 'private' }
      downloadFile.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 180_000)
        return { bytes: new Uint8Array([137, 80, 78, 71]), path: 'photos/file_1.jpg' }
      })
      await Promise.all([processUpdate(page(1, dm, 'add these dates')), processUpdate(page(2, dm)), processUpdate(page(3, dm))])
      expect(downloadFile.mock.calls.map(([id]) => id)).toEqual(['page1'])
      expect(runAgent.mock.calls[0][0].attachments).toHaveLength(1)
      expect(console.warn).toHaveBeenCalledWith('[telegram] out of time: 2 attachment(s) not fetched')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the time a turn has', () => {
  it('runs from when the message arrived, so the downloads and the wait for the turn ahead come out of it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const arrived = Date.now()
      downloadFile.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 20_000)
        return { bytes: new Uint8Array([137, 80, 78, 71]), path: 'photos/file_1.jpg' }
      })
      vi.mocked(awaitTurn).mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 90_000)
        return 'hold'
      })
      await processUpdate(photoUpdate('add these dates'))
      // A minute short of the ceiling, whenever the turn itself began.
      expect(runAgent.mock.calls[0][0].deadline).toBe(arrived + 240_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up on a file the host stalls on while the turn still has time, and answers without it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const arrived = Date.now()
      // What came before the downloads left them only a moment.
      recordMessage.mockImplementationOnce(async () => {
        vi.setSystemTime(arrived + 180_000 - 50)
        return 1
      })
      // A file host that takes the request and never sends the body.
      downloadFile.mockImplementationOnce((_id, signal) =>
        new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason))),
      )
      await processUpdate(photoUpdate('what is this'))
      expect(runAgent.mock.calls[0][0]).toMatchObject({ text: 'what is this', attachments: [] })
      expect(send).toHaveBeenCalledWith('111', 'Looks like school photo day.', undefined)
    } finally {
      vi.useRealTimers()
    }
  }, 2_000)
})
