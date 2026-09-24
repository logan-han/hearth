import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'
import { HttpError } from 'grammy'

const { send, typing, runAgent, sendMessage, sendChatAction, getFile, getChatMember, me } = vi.hoisted(() => ({
  send: vi.fn(async (_chatId: string | number, _text: string, _replyTo?: number) => {}),
  typing: vi.fn(async (_chatId: string | number) => {}),
  runAgent: vi.fn(async () => ({ text: 'sure', notices: [] as string[], model: 'gemini' })),
  sendMessage: vi.fn(async () => ({})),
  sendChatAction: vi.fn(async () => true),
  getFile: vi.fn(),
  /** Who Telegram says is in a room; nobody, unless a test says otherwise. */
  getChatMember: vi.fn<(chatId: string, userId: number) => Promise<{ status: string; user: { id: number } }>>(),
  /** What getMe answers; a test may take the username away. */
  me: { value: { id: 1, username: 'heart_family_bot' } as { id: number; username?: string } },
}))

vi.mock('@/lib/telegram', async (orig) => ({
  ...(await orig<typeof import('@/lib/telegram')>()),
  send, typing,
  bot: () => ({ api: { getMe: async () => me.value, sendMessage, sendChatAction, getFile, getChatMember } }),
}))
vi.mock('@/lib/agent', async (orig) => ({
  runAgent, shouldChimeIn: vi.fn(async () => false),
  unconfirmedLine: (await orig<typeof import('@/lib/agent')>()).unconfirmedLine,
}))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => p }))

const { processUpdate } = await import('@/lib/handler')

let client: PGlite

const dm = (text: string, from = '111') => ({
  update_id: 1,
  message: {
    message_id: 3, date: 1787000000,
    from: { id: Number(from), is_bot: false, first_name: `User${from}` },
    chat: { id: Number(from), type: 'private' },
    text,
  },
}) as never

const groupReply = (text: string, replyFrom: number) => ({
  update_id: 2,
  message: {
    message_id: 4, date: 1787000000,
    from: { id: 111, is_bot: false, first_name: 'Rowan' },
    chat: { id: -100, type: 'group', title: 'Family' },
    text,
    reply_to_message: {
      message_id: 1, date: 1787000000,
      chat: { id: -100, type: 'group' },
      from: { id: replyFrom, is_bot: false, first_name: `User${replyFrom}` },
      text: 'hi',
    },
  },
}) as never

const group = (text: string, from = '111') => ({
  update_id: 5,
  message: {
    message_id: 6, date: 1787000000,
    from: { id: Number(from), is_bot: false, first_name: `User${from}` },
    chat: { id: -100, type: 'group', title: 'Family' },
    text,
  },
}) as never

const lastSent = () => String(send.mock.calls.at(-1)?.[1] ?? '')

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  me.value = { id: 1, username: 'heart_family_bot' }
  getChatMember.mockRejectedValue(new Error('Bad Request: user not found'))
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.example'
  process.env.ALLOWED_TELEGRAM_IDS = '111'
  client = (await freshDb()).client
})
afterEach(async () => closeDb(client))

describe('/help and /start', () => {
  it('lists what the bot can do', async () => {
    await processUpdate(dm('/help'))
    expect(lastSent()).toContain('/connect')
    expect(lastSent()).toContain('photos')
  })

  it('answers /start the same way', async () => {
    await processUpdate(dm('/start'))
    expect(lastSent()).toContain('Hearth')
  })

  it('tolerates the @botname suffix Telegram adds in groups', async () => {
    await processUpdate(dm('/help@heart_family_bot'))
    expect(lastSent()).toContain('/connect')
  })
})

describe('/whoami and /members', () => {
  it('gives a member their id and flags admin', async () => {
    await processUpdate(dm('/whoami'))
    expect(lastSent()).toContain('111')
    expect(lastSent()).toContain('admin')
  })

  it('lists who the bot answers to', async () => {
    await processUpdate(dm('/whoami'))
    send.mockClear()
    await processUpdate(dm('/members'))
    expect(lastSent()).toContain('Rowan' === 'Rowan' ? 'User111' : '')
    expect(lastSent()).toContain('1 person')
  })
})

describe('/allow and /deny', () => {
  it('grants access by id, without making them an admin', async () => {
    await processUpdate(dm('/allow 999'))
    expect(lastSent()).toContain('999')
    const m = await q.memberByTelegramId('999')
    expect(m!.allowed).toBe(true)
    expect(m!.isAdmin).toBe(false)
  })

  it('grants by replying to someone, taking their name', async () => {
    await processUpdate(dm('/whoami'))
    await processUpdate(groupReply('/allow', 777))
    const m = await q.memberByTelegramId('777')
    expect(m!.allowed).toBe(true)
    expect(m!.name).toBe('User777')
  })

  it('clears the stranger flag on the room when vouching there', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await q.noteStranger('-100', { id: '777', name: 'User777' })
    await processUpdate(groupReply('/allow', 777))
    expect(await q.strangersIn('-100')).toEqual([])
  })

  it('unmutes every room they were flagged in when vouched for from a DM', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await q.rememberChat('-200', 'group', 'Cousins')
    await q.noteStranger('-100', { id: '777', name: 'Nan' })
    await q.noteStranger('-200', { id: '777', name: 'Nan' })
    await processUpdate(dm('/allow 777'))
    expect(await q.strangersIn('-100')).toEqual([])
    expect(await q.strangersIn('-200')).toEqual([])
    send.mockClear()
    await processUpdate(group('@heart_family_bot hi'))
    expect(runAgent).toHaveBeenCalled()
  })

  it('unmutes every room a founder is flagged in once they speak in any one of them', async () => {
    // Flagged before they joined ALLOWED_TELEGRAM_IDS; the seed lets them in without an /allow.
    process.env.ALLOWED_TELEGRAM_IDS = '111,222'
    await q.rememberChat('-100', 'group', 'Family')
    await q.rememberChat('-200', 'group', 'Cousins')
    await q.noteStranger('-100', { id: '222', name: 'Dad' })
    await q.noteStranger('-200', { id: '222', name: 'Dad' })
    await processUpdate(group('morning all', '222'))
    expect(await q.strangersIn('-100')).toEqual([])
    expect(await q.strangersIn('-200')).toEqual([])
    send.mockClear()
    await processUpdate({
      update_id: 7,
      message: {
        message_id: 8, date: 1787000000,
        from: { id: 111, is_bot: false, first_name: 'Rowan' },
        chat: { id: -200, type: 'group', title: 'Cousins' },
        text: '@heart_family_bot what is on today',
      },
    } as never)
    expect(lastSent()).not.toContain('Not while')
    expect(runAgent).toHaveBeenCalled()
  })

  it('asks for an id when given neither an id nor a reply', async () => {
    await processUpdate(dm('/allow'))
    expect(lastSent()).toContain('Usage')
  })

  it('revokes an ordinary member', async () => {
    await processUpdate(dm('/allow 999'))
    send.mockClear()
    await processUpdate(dm('/deny 999'))
    expect(lastSent()).toContain('Revoked')
    expect(lastSent()).toContain('/calendar new')
    expect(lastSent()).not.toContain('stay quiet')
    expect((await q.memberByTelegramId('999'))!.allowed).toBe(false)
  })

  it('quiets every room a revoked member sits in, silent or not, and says which', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await q.rememberChat('-200', 'group', 'Cousins')
    await q.rememberChat('-300', 'group', 'Book club')
    await processUpdate(dm('/allow 333'))
    // Telegram sees them in the family group; the cousins' room will not say, but they have talked there.
    const nan = await q.memberByTelegramId('333')
    await q.recordMessage({ chatId: '-200', memberId: nan!.id, role: 'user', content: 'see you all sunday' })
    getChatMember.mockImplementation(async (chatId, id) => {
      if (chatId === '-100') return { status: 'member', user: { id } }
      if (chatId === '-200') throw new Error('Bad Request: CHAT_ADMIN_REQUIRED')
      throw new Error('Bad Request: user not found')
    })
    send.mockClear()
    await processUpdate(dm('/deny 333'))
    expect(lastSent()).toContain("I'll stay quiet in Family, Cousins while they are there.")
    expect(await q.strangersIn('-100')).toEqual([{ id: '333', name: 'user333' }])
    expect(await q.strangersIn('-200')).toEqual([{ id: '333', name: 'user333' }])
    expect(await q.strangersIn('-300')).toEqual([])
    // Nothing was said to the rooms themselves.
    expect(send).toHaveBeenCalledTimes(1)
    send.mockClear()
    await processUpdate(group('@heart_family_bot read my inbox'))
    expect(lastSent()).toContain('Not while user333 is here')
  })

  it('says so when revoking someone it has never seen', async () => {
    await processUpdate(dm('/deny 555'))
    expect(lastSent()).toContain('no record')
  })

  it('will not let an admin revoke themselves', async () => {
    await processUpdate(dm('/deny 111'))
    expect(lastSent()).toContain('cannot revoke yourself')
  })

  it('refuses a non-admin', async () => {
    await processUpdate(dm('/allow 999'))
    send.mockClear()
    await processUpdate(dm('/allow 888', '999'))
    expect(lastSent()).toContain('Only an admin')
    expect(await q.memberByTelegramId('888')).toBeUndefined()
  })
})

describe('/connect and /accounts', () => {
  it('DMs a personal link and confirms in the group', async () => {
    await processUpdate({
      ...(groupReply('/connect', 222) as unknown as Record<string, unknown>),
      message: {
        message_id: 9, date: 1787000000,
        from: { id: 111, is_bot: false, first_name: 'Rowan' },
        chat: { id: -100, type: 'group', title: 'Family' },
        text: '/connect',
      },
    } as never)
    expect(send).toHaveBeenCalledWith('111', expect.stringContaining('/connect?t='))
    expect(lastSent()).toContain('DM')
  })

  it('tells the member to open a DM first when it cannot reach them', async () => {
    send.mockRejectedValueOnce(new Error('bot was blocked by the user'))
    await processUpdate(dm('/connect'))
    expect(lastSent()).toContain('direct message')
  })

  it('reports no linked accounts, then the linked one', async () => {
    await processUpdate(dm('/accounts'))
    expect(lastSent()).toContain('no linked accounts')

    const m = await q.memberByTelegramId('111')
    await q.saveConnection({ memberId: m!.id, provider: 'google', email: 'a@b.com', refreshToken: 'r', scopes: null })
    send.mockClear()
    await processUpdate(dm('/accounts'))
    expect(lastSent()).toContain('a@b.com')
  })

  it('unlinks a named provider and rejects a bad one', async () => {
    const m = await q.upsertMember('111', 'Rowan', { allowed: true, isAdmin: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'r', scopes: null })
    await processUpdate(dm('/unlink google'))
    expect(await q.connectionsFor(m.id)).toHaveLength(0)

    send.mockClear()
    await processUpdate(dm('/unlink hotmail'))
    expect(lastSent()).toContain('Usage')
  })
})

describe('/mcp', () => {
  const keyFrom = (text: string) => text.match(/Bearer ([^"]+)"/)?.[1] ?? ''

  it('DMs a working key and the one line that connects Claude to it', async () => {
    await processUpdate(dm('/mcp'))
    const sent = lastSent()
    expect(sent).toContain('claude mcp add')
    expect(sent).toContain('https://hearth.example/api/mcp')

    const m = await q.memberByTelegramId('111')
    expect((await q.memberByMcpKey(keyFrom(sent)))?.id).toBe(m!.id)
  })

  it('says what is there rather than quietly breaking what is connected', async () => {
    await processUpdate(dm('/mcp'))
    const first = keyFrom(lastSent())
    send.mockClear()

    await processUpdate(dm('/mcp'))
    expect(lastSent()).toContain('You have a key')
    expect(await q.memberByMcpKey(first)).not.toBeNull()
  })

  it('replaces the old key on /mcp new, and says so', async () => {
    await processUpdate(dm('/mcp'))
    const first = keyFrom(lastSent())
    send.mockClear()

    await processUpdate(dm('/mcp new'))
    expect(lastSent()).toContain('stopped working')
    expect(await q.memberByMcpKey(first)).toBeNull()
    expect(await q.memberByMcpKey(keyFrom(lastSent()))).not.toBeNull()
  })

  it('revokes on /mcp off', async () => {
    await processUpdate(dm('/mcp'))
    const key = keyFrom(lastSent())
    await processUpdate(dm('/mcp off'))
    expect(lastSent()).toContain('Revoked')
    expect(await q.memberByMcpKey(key)).toBeNull()
  })

  it('never puts a key in the group, whoever asked there', async () => {
    await processUpdate(group('/mcp'))
    expect(send).toHaveBeenCalledWith('111', expect.stringContaining('claude mcp add'))
    expect(send).toHaveBeenCalledWith('-100', expect.stringContaining('DM'))
    expect(lastSent()).not.toContain('Bearer')
  })

  it('leaves no key issued when it could not be handed over', async () => {
    send.mockRejectedValueOnce(new Error('bot was blocked by the user'))
    await processUpdate(dm('/mcp'))
    expect(lastSent()).toContain('direct message')
    const m = await q.memberByTelegramId('111')
    expect(m!.mcpTokenHash).toBeNull()
  })
})

describe('/calendar', () => {
  it('hands over a subscribable feed url', async () => {
    await processUpdate(dm('/calendar'))
    expect(lastSent()).toMatch(/https:\/\/hearth\.example\/api\/calendar\/.+\/family\.ics/)
    expect(lastSent()).toContain('Google Calendar')
  })

  it('replaces the feed token on /calendar new, so the old url stops working', async () => {
    const before = await q.calendarToken()
    await processUpdate(dm('/calendar new'))
    const after = await q.calendarToken()
    expect(after).not.toBe(before)
    expect(lastSent()).toContain(`/api/calendar/${after}/family.ics`)
    expect(lastSent()).toContain('stopped working')
  })

  it('says the old url can still be answered for as long as the edge keeps the feed, an hour', async () => {
    await processUpdate(group('/calendar new'))
    const said = send.mock.calls.map(([, text]) => String(text))
    expect(said).toHaveLength(2)
    for (const text of said) expect(text).toContain('a cached copy can answer for up to 60 minutes')
  })

  it('sends the replacement to the admin alone when asked in a group, since the old one may have got out there', async () => {
    await processUpdate(group('/calendar new'))
    const token = await q.calendarToken()
    const toGroup = send.mock.calls.filter(([chat]) => String(chat) === '-100').map(([, text]) => String(text))
    const toAdmin = send.mock.calls.filter(([chat]) => String(chat) === '111').map(([, text]) => String(text))
    expect(toAdmin.join('\n')).toContain(`/api/calendar/${token}/family.ics`)
    expect(toGroup.join('\n')).toContain('sent you the new one in a DM')
    expect(toGroup.join('\n')).not.toContain('/api/calendar/')
  })

  it('still replaces it, and says how to get the new one, when the admin has no DM open', async () => {
    const before = await q.calendarToken()
    // The first thing said is the DM to the admin, which Telegram refuses.
    send.mockRejectedValueOnce(new Error('Forbidden: bot can\'t initiate conversation with a user'))
    await processUpdate(group('/calendar new'))
    expect(send.mock.calls[0][0]).toBe('111')
    expect(await q.calendarToken()).not.toBe(before)
    expect(lastSent()).toContain('start a direct message with me')
    expect(lastSent()).not.toContain('/api/calendar/')
  })

  it('lets only an admin replace it', async () => {
    await processUpdate(dm('/allow 999'))
    const before = await q.calendarToken()
    send.mockClear()
    await processUpdate(dm('/calendar new', '999'))
    expect(lastSent()).toContain('Only an admin')
    expect(await q.calendarToken()).toBe(before)
  })
})

describe('commands in a room with someone unrecognised in it', () => {
  beforeEach(async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await q.noteStranger('-100', { id: '777', name: 'User777' })
  })

  it('will not hand the feed url, linked addresses or the family list to the room', async () => {
    for (const cmd of ['/calendar', '/accounts', '/members', '/watch list']) {
      send.mockClear()
      await processUpdate(group(cmd))
      expect(send).toHaveBeenCalledTimes(1)
      expect(lastSent()).toContain('Not while User777 is here')
      expect(lastSent()).not.toContain('/api/calendar/')
    }
  })

  it('still takes /allow, which is how the room is unmuted, and /help', async () => {
    await processUpdate(groupReply('/allow', 777))
    expect(await q.strangersIn('-100')).toEqual([])
    await q.noteStranger('-100', { id: '778', name: 'User778' })
    send.mockClear()
    await processUpdate(group('/help'))
    expect(lastSent()).toContain('Hearth')
  })
})

describe('someone unrecognised joining', () => {
  const joined = (...people: { id: number; is_bot?: boolean }[]) => ({
    update_id: 9,
    message: {
      message_id: 9, date: 1787000000,
      from: { id: 111, is_bot: false, first_name: 'Rowan' },
      chat: { id: -300, type: 'group', title: 'New room' },
      new_chat_members: people.map((p) => ({ id: p.id, is_bot: p.is_bot ?? false, first_name: `User${p.id}` })),
    },
  }) as never

  it('is recorded even in a room nobody has spoken in yet, so the bot does stay quiet', async () => {
    await processUpdate(joined({ id: 1, is_bot: true }, { id: 999 }))
    expect(await q.strangersIn('-300')).toEqual([{ id: '999', name: 'User999' }])
    expect(lastSent()).toContain("I don't recognise User999")

    send.mockClear()
    runAgent.mockClear()
    await processUpdate({
      update_id: 10,
      message: {
        message_id: 10, date: 1787000000,
        from: { id: 111, is_bot: false, first_name: 'Rowan' },
        chat: { id: -300, type: 'group', title: 'New room' },
        text: '@heart_family_bot read my inbox',
        entities: [{ type: 'mention', offset: 0, length: 17 }],
      },
    } as never)
    expect(runAgent).not.toHaveBeenCalled()
    expect(lastSent()).toContain('Not while User999 is here')
  })

  it('creates no row for the bot arriving on its own', async () => {
    await processUpdate(joined({ id: 1, is_bot: true }))
    expect(await q.groupChats()).toEqual([])
  })
})

describe("the bot's own membership", () => {
  const became = (status: string, extra: Record<string, unknown> = {}) => ({
    update_id: 11,
    my_chat_member: {
      chat: { id: -100, type: 'group', title: 'Family' },
      from: { id: 111, is_bot: false, first_name: 'Rowan' },
      date: 1787000000,
      old_chat_member: { status: 'member', user: { id: 1, is_bot: true, first_name: 'Hearth' } },
      new_chat_member: { status, user: { id: 1, is_bot: true, first_name: 'Hearth' }, ...extra },
    },
  }) as never

  it('drops a room it was removed from out of the household, and takes it back when re-added', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    for (const [status, extra] of [['left', {}], ['kicked', { until_date: 0 }], ['restricted', { is_member: false }]] as const) {
      await processUpdate(became(status, extra))
      expect(await q.groupChats()).toEqual([])
      await processUpdate(became('member'))
      expect((await q.groupChats()).map((r) => r.chatId)).toEqual(['-100'])
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('takes a room back as soon as anyone speaks in it, whatever it was told before', async () => {
    await q.rememberChat('-100', 'group', 'Family')
    await processUpdate(became('kicked'))
    await processUpdate(group('hello again'))
    expect((await q.groupChats()).map((r) => r.chatId)).toEqual(['-100'])
  })
})

describe('a group made a supergroup', () => {
  const service = (chatId: number, field: Record<string, number>) => ({
    update_id: 12,
    message: {
      message_id: 12, date: 1787000000,
      from: { id: 111, is_bot: false, first_name: 'Rowan' },
      chat: { id: chatId, type: chatId === -100 ? 'group' : 'supergroup', title: 'Family' },
      ...field,
    },
  }) as never

  it('keeps its stranger, its history and its watchers under the new id, from either end of the change', async () => {
    for (const [update, to] of [
      [service(-100, { migrate_to_chat_id: -1001234 }), '-1001234'],
      [service(-1005678, { migrate_from_chat_id: -100 }), '-1005678'],
    ] as const) {
      await q.rememberChat('-100', 'group', 'Family')
      await q.noteStranger('-100', { id: '999', name: 'Eve' })
      await processUpdate(group('bins tonight'))
      await q.addAutomation({ chatId: '-100', label: 'Morning brief', cronExpr: '0 7 * * *', instruction: 'x', kind: 'morning', nextRunAt: new Date() })

      await processUpdate(update)
      expect(await q.strangersIn(to)).toEqual([{ id: '999', name: 'Eve' }])
      expect((await q.recentMessages(to)).map((m) => m.content)).toContain('bins tonight')
      expect((await q.listAutomations(to)).map((a) => a.kind)).toEqual(['morning'])
      expect(await q.listAutomations('-100')).toEqual([])
    }
    expect(runAgent).not.toHaveBeenCalled()
  })
})

describe('/watch', () => {
  it('offers the ready-made watchers when called bare', async () => {
    await processUpdate(dm('/watch'))
    expect(lastSent()).toContain('/watch money')
    expect(lastSent()).toContain('/watch snapshot')
    expect(lastSent()).toContain('/watch morning')
    expect(lastSent()).not.toContain('/watch inbox')
  })

  it('switches a watcher on as an ordinary automation', async () => {
    await processUpdate(dm('/watch money'))
    expect(lastSent()).toContain('Watching')
    const [a] = await q.listAutomations('111')
    expect(a.label).toBe('2Up transactions')
    expect(a.cronExpr).toBe('0 9-22 * * *')
    expect(a.kind).toBe('money')
    expect(a.instruction).toContain('purpose not recorded')
    expect(a.instruction).not.toContain('likely is')
  })

  it('refuses to watch the same thing twice', async () => {
    await processUpdate(dm('/watch money'))
    await processUpdate(dm('/watch money'))
    expect(lastSent()).toContain('Already watching')
    expect(await q.listAutomations('111')).toHaveLength(1)
  })

  it('folds an inbox request into the morning brief, which needs no mailbox to start', async () => {
    await processUpdate(dm('/watch inbox'))
    expect(lastSent()).toContain('Mail is part of the morning brief now')
    expect(lastSent()).toContain('Watching')
    const [a] = await q.listAutomations('111')
    expect(a.kind).toBe('morning')
    expect(a.label).toBe('Morning brief')
    expect(a.cronExpr).toBe('0 7 * * *')
    expect(a.instruction).not.toContain('whose mailbox')
  })

  it('binds a personal brief to whoever switched it on', async () => {
    await processUpdate(dm('/whoami')) // creates the member row
    const m = (await q.memberByTelegramId('111'))!
    await processUpdate(dm('/watch morning'))
    const [a] = await q.listAutomations('111')
    expect(a.memberId).toBe(m.id)
  })

  it('switches a paused watcher back on rather than doubling it', async () => {
    await processUpdate(dm('/watch morning'))
    const [a] = await q.listAutomations('111')
    await q.setAutomationEnabled(a.id, false)
    await processUpdate(dm('/watch morning'))
    expect(lastSent()).toContain('Resumed')
    const rows = await q.listAutomations('111')
    expect(rows).toHaveLength(1)
    expect(rows[0].enabled).toBe(true)
    expect(rows[0].nextRunAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('lists what this chat is watching', async () => {
    await processUpdate(dm('/watch morning'))
    await processUpdate(dm('/watch list'))
    expect(lastSent()).toContain('Morning brief')
    expect(lastSent()).toContain('next ')
  })

  it('keeps each chat separate', async () => {
    await processUpdate(dm('/watch money'))
    expect(await q.listAutomations('-100')).toHaveLength(0)
  })

  const group = (text: string) => ({
    update_id: 5,
    message: {
      message_id: 6, date: 1787000000,
      from: { id: 111, is_bot: false, first_name: 'User111' },
      chat: { id: -100, type: 'group', title: 'Family' },
      text,
    },
  }) as never

  it('has the group brief say whose mailbox each item came from', async () => {
    await processUpdate(group('/watch inbox'))
    const [a] = await q.listAutomations('-100')
    expect(a.label).toBe('Morning brief')
    expect(a.kind).toBe('morning')
    expect(a.instruction).toContain('whose mailbox')
  })

  it('tells a group the built-in watchers are already on', async () => {
    await processUpdate(group('/watch'))
    expect(lastSent()).toContain('already on in a family group')
    await processUpdate(dm('/watch'))
    expect(lastSent()).not.toContain('already on')
  })
})

describe('unknown commands', () => {
  it('fall through to the agent rather than erroring', async () => {
    await processUpdate(dm('/sing'))
    expect(runAgent).toHaveBeenCalled()
  })
})

describe('a command naming another bot', () => {
  it('is that bot\'s to answer, even as a reply to one of ours, and is kept only as history', async () => {
    await processUpdate(group('/help@dice_bot'))
    await processUpdate(group('/roll@Dice_Bot 2d6'))
    await processUpdate(group('/deny@modbot 333'))
    const toUs = (text: string) => ({
      update_id: 7,
      message: {
        message_id: 8, date: 1787000000,
        from: { id: 111, is_bot: false, first_name: 'User111' },
        chat: { id: -100, type: 'group', title: 'Family' },
        text,
        reply_to_message: { message_id: 1, date: 1787000000, chat: { id: -100, type: 'group' }, from: { id: 1, is_bot: true, first_name: 'Hearth' }, text: 'hi' },
      },
    }) as never
    await processUpdate(toUs('/roll@dice_bot'))
    expect(send).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
    expect((await q.recentMessages('-100')).map((m) => m.content)).toEqual(['/help@dice_bot', '/roll@Dice_Bot 2d6', '/deny@modbot 333', '/roll@dice_bot'])
  })

  it('is still ours when it names this bot, in any case', async () => {
    await processUpdate(group('/help@Heart_Family_Bot'))
    expect(lastSent()).toContain('/connect')
  })
})

describe('two messages in one chat', () => {
  it('answers the second once the reply to the first exists, with that reply in view', async () => {
    let finish!: () => void
    let seen: string[] = []
    runAgent
      .mockImplementationOnce(
        () => new Promise((resolve) => (finish = () => resolve({ text: 'Added milk.', notices: [], model: 'g' }))),
      )
      .mockImplementationOnce((async (input: { excludeMessageId: number }) => {
        // What this turn reads as history.
        seen = (await q.recentMessages('111', 15, input.excludeMessageId)).map((m) => m.content)
        return { text: 'Swapped it for oat milk.', notices: [], model: 'g' }
      }) as never)
    const first = processUpdate(dm('add milk'))
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1))
    const second = processUpdate(dm('actually, oat milk'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(runAgent).toHaveBeenCalledTimes(1)

    finish()
    await Promise.all([first, second])
    expect(runAgent).toHaveBeenCalledTimes(2)
    expect(runAgent.mock.calls[1]).toEqual([expect.objectContaining({ text: 'actually, oat milk' })])
    expect(seen).toEqual(['add milk', 'Added milk.'])
  })
})

describe('three messages in one chat', () => {
  it('answers them in the order they came, even when the third looks first once the chat is free', async () => {
    // Each waiter's one-second pause is held here, so the test says who looks when.
    const pauses: (() => void)[] = []
    const realSetTimeout = globalThis.setTimeout
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 1_000) {
        pauses.push(fn)
        return 0
      }
      return realSetTimeout(fn, ms)
    }) as typeof setTimeout)
    try {
      let finish!: () => void
      let seenByBread: string[] = []
      runAgent
        .mockImplementationOnce(
          () => new Promise((resolve) => (finish = () => resolve({ text: 'Added milk.', notices: [], model: 'g' }))),
        )
        .mockImplementationOnce(async () => ({ text: 'Added eggs.', notices: [], model: 'g' }))
        .mockImplementationOnce((async (input: { excludeMessageId: number }) => {
          seenByBread = (await q.recentMessages('111', 15, input.excludeMessageId)).map((m) => m.content)
          return { text: 'Added bread.', notices: [], model: 'g' }
        }) as never)
      const milk = processUpdate(dm('add milk'))
      await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1))
      const eggs = processUpdate(dm('and eggs'))
      await vi.waitFor(() => expect(pauses).toHaveLength(1))
      const bread = processUpdate(dm('and bread'))
      await vi.waitFor(() => expect(pauses).toHaveLength(2))

      finish()
      await milk
      // The chat is free and the bread looks first, but the eggs came before it.
      pauses[1]()
      await vi.waitFor(() => expect(pauses.length + runAgent.mock.calls.length).toBeGreaterThan(3))
      expect(runAgent).toHaveBeenCalledTimes(1)

      pauses[0]()
      await eggs
      pauses[2]()
      await bread
      expect(runAgent.mock.calls).toEqual(
        ['add milk', 'and eggs', 'and bread'].map((text) => [expect.objectContaining({ text })]),
      )
      // The bread is answered with the eggs, and the reply to them, in view.
      expect(seenByBread).toEqual(['add milk', 'and eggs', 'Added milk.', 'Added eggs.'])
    } finally {
      timers.mockRestore()
    }
  })
})

describe('what a reply reports as new', () => {
  const staged = [{ key: 'mail_cursor:111:1:google', at: '2026-09-24T01:00:00.000Z', ids: ['a'], prev: null }]

  it('is spent once the reply is sent', async () => {
    runAgent.mockResolvedValueOnce({ text: 'One email from the school.', notices: [], model: 'g', cursors: staged } as never)
    await processUpdate(dm('any new mail?'))
    expect(JSON.parse((await q.getSetting('mail_cursor:111:1:google'))!).ids).toEqual(['a'])
  })

  it('stays new when the reply never reached the chat', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runAgent.mockResolvedValueOnce({ text: 'One email from the school.', notices: [], model: 'g', cursors: staged } as never)
    send.mockRejectedValueOnce(new Error('Telegram is down'))
    await processUpdate(dm('any new mail?'))
    expect(await q.getSetting('mail_cursor:111:1:google')).toBeNull()
    expect(lastSent()).toBe('Telegram did not confirm my reply, so some or all of it may be missing. Ask again if you did not see it.')
  })
})

describe('a reply Telegram did not confirm', () => {
  it('says what the turn did stands, rather than that it went wrong', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runAgent.mockResolvedValueOnce({ text: 'Added milk to Shopping.', notices: [], model: 'g', wrote: ['add_to_list'] } as never)
    // A stale keep-alive socket: the request may or may not have reached Telegram.
    send.mockRejectedValueOnce(new HttpError("Network request for 'sendMessage' failed!", new Error('socket hang up')))
    await processUpdate(group('@heart_family_bot add milk to the shopping list'))
    expect(lastSent()).not.toContain('went wrong')
    expect(lastSent()).toContain('What I did stands: added to a list')
    // The next turn sees it too, so a second "add milk" is not simply done again.
    const history = await q.recentMessages('-100')
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: lastSent() })
    expect(history.some((m) => m.content === 'Added milk to Shopping.')).toBe(false)
  })

  it('still ends quietly when the chat will not take the notice either', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    runAgent.mockResolvedValueOnce({ text: 'Added milk to Shopping.', notices: [], model: 'g', wrote: ['add_to_list'] } as never)
    // The reply, then the notice.
    send.mockRejectedValueOnce(new Error('Telegram is down')).mockRejectedValueOnce(new Error('Telegram is down'))
    await expect(processUpdate(group('@heart_family_bot add milk to the shopping list'))).resolves.toBeUndefined()
    expect(send.mock.calls.map(([, text]) => text).some((t) => t.includes('went wrong'))).toBe(false)
    expect(error).toHaveBeenCalledWith('[telegram] could not say the reply was not confirmed:', expect.any(Error))
  })
})

describe('agent failures', () => {
  it('are reported to the chat instead of vanishing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runAgent.mockRejectedValueOnce(new Error('model exploded'))
    await processUpdate(dm('what is the weather'))
    expect(lastSent()).toContain('model exploded')
  })

  it('appends notices the reply did not already mention', async () => {
    runAgent.mockResolvedValueOnce({ text: 'Done.', notices: ['Added to the family calendar: Soccer'], model: 'g' })
    await processUpdate(dm('add soccer'))
    expect(lastSent()).toContain('Done.')
    expect(lastSent()).toContain('Soccer')
  })

  it('does not repeat a notice already inside the reply', async () => {
    runAgent.mockResolvedValueOnce({ text: 'Added Soccer to the calendar', notices: ['Soccer'], model: 'g' })
    await processUpdate(dm('add soccer'))
    expect(lastSent()).toBe('Added Soccer to the calendar')
  })

  it('posts one confirmation when the reply restates a notice in its own words', async () => {
    runAgent.mockResolvedValueOnce({
      text: 'Added to the family calendar: Home cleaner on Monday, 5 October 2026 from 1:00 pm to 4:00 pm.',
      notices: ['Added to the family calendar: **Home cleaner** — Mon, 5 Oct 2026, 1:00 pm'],
      model: 'g',
    })
    await processUpdate(dm('the cleaner is coming monday 1 to 4'))
    expect(lastSent()).toBe('Added to the family calendar: Home cleaner on Monday, 5 October 2026 from 1:00 pm to 4:00 pm.')
  })

  it('stays silent when there is nothing at all to say', async () => {
    runAgent.mockResolvedValueOnce({ text: '', notices: [], model: 'g' })
    await processUpdate(dm('hmm'))
    expect(send).not.toHaveBeenCalled()
  })
})

describe('the shapes Telegram sends', () => {
  const from = (who: Record<string, unknown>, text = '/whoami') => ({
    update_id: 9,
    message: { message_id: 3, date: 1787000000, from: { id: 111, is_bot: false, ...who }, chat: { id: 111, type: 'private' }, text },
  }) as never

  it('names a sender by handle when there is no name, and by id when there is neither', async () => {
    await processUpdate(from({ username: 'rowanh' }))
    expect(lastSent()).toContain('**rowanh**')
    await processUpdate(from({}))
    expect(lastSent()).toContain('**user111**')
  })

  it('leaves an edit alone, which answered again would make the same change twice', async () => {
    const edited = dm('add milk and bread to the shopping list') as { update_id: number; message: unknown }
    await processUpdate({ update_id: 10, edited_message: edited.message } as never)
    expect(runAgent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(await q.recentMessages('111')).toEqual([])
  })

  it('ignores a message from another bot', async () => {
    await processUpdate(from({ is_bot: true }, 'hello'))
    expect(send).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('still answers when the bot has no username to be mentioned by', async () => {
    me.value = { id: 1 }
    await processUpdate(dm('@heart_family_bot what is on today?'))
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ text: '@heart_family_bot what is on today?' }))
  })
})

describe('command replies that depend on who is asking', () => {
  it('/connect in a DM sends the link once, with nothing to confirm', async () => {
    await processUpdate(dm('/connect'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('111', expect.stringContaining('Link an account'))
  })

  it('/accounts shows a linked provider plainly when it carries no address', async () => {
    await processUpdate(dm('/whoami'))
    const m = (await q.memberByTelegramId('111'))!
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'r', scopes: null })
    await processUpdate(dm('/accounts'))
    expect(lastSent()).toContain('· google')
    expect(lastSent()).not.toContain('· google —')
  })

  it('/whoami leaves the admin tag off an ordinary member, and /members marks only the admins', async () => {
    await q.saveMember({ telegramUserId: '333', name: 'Ada', email: null, allowed: true, isAdmin: false })
    await processUpdate(dm('/whoami', '333'))
    expect(lastSent()).toContain('`333`')
    expect(lastSent()).not.toContain('admin')

    await processUpdate(dm('/whoami'))
    await processUpdate(dm('/members'))
    expect(lastSent()).toContain('2 people')
    const ada = lastSent().split('\n').find((l) => l.includes('`333`'))!
    expect(ada).not.toContain('admin')
    expect(lastSent().split('\n').find((l) => l.includes('`111`'))).toContain('(admin)')
  })

  it('/allow with an explicit id names them by id, even when replying to someone else', async () => {
    await processUpdate(groupReply('/allow 555', 777))
    expect((await q.memberByTelegramId('555'))!.name).toBe('user555')
  })

  it('/watch list says so when nothing is watched, and marks a paused watcher', async () => {
    await processUpdate(dm('/watch list'))
    expect(lastSent()).toContain('Nothing is being watched')
    await processUpdate(dm('/watch morning'))
    const [a] = await q.listAutomations('111')
    await q.setAutomationEnabled(a.id, false)
    await processUpdate(dm('/watch list'))
    expect(lastSent()).toContain('paused')
  })

  it("describes the brief's mail as everyone's when asked from the group, and as yours in a DM", async () => {
    await processUpdate(group('/watch'))
    expect(lastSent()).toContain("everyone's new mail")
    await processUpdate(dm('/watch'))
    expect(lastSent()).toContain('your new mail')
  })
})
