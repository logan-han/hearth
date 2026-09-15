import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshDb, closeDb } from './helpers/db'
import * as q from '@/lib/db/queries'

const { send, typing, runAgent, sendMessage, sendChatAction, getFile, me } = vi.hoisted(() => ({
  send: vi.fn(async (_chatId: string | number, _text: string, _replyTo?: number) => {}),
  typing: vi.fn(async (_chatId: string | number) => {}),
  runAgent: vi.fn(async () => ({ text: 'sure', notices: [] as string[], model: 'gemini' })),
  sendMessage: vi.fn(async () => ({})),
  sendChatAction: vi.fn(async () => true),
  getFile: vi.fn(),
  /** What getMe answers; a test may take the username away. */
  me: { value: { id: 1, username: 'heart_family_bot' } as { id: number; username?: string } },
}))

vi.mock('@/lib/telegram', async (orig) => ({
  ...(await orig<typeof import('@/lib/telegram')>()),
  send, typing,
  bot: () => ({ api: { getMe: async () => me.value, sendMessage, sendChatAction, getFile } }),
}))
vi.mock('@/lib/agent', () => ({ runAgent, shouldChimeIn: vi.fn(async () => false) }))
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
    from: { id: 111, is_bot: false, first_name: 'Logan' },
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
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64)
  process.env.APP_URL = 'https://hearth.han.life'
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
    expect(lastSent()).toContain('Logan' === 'Logan' ? 'User111' : '')
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

  it('asks for an id when given neither an id nor a reply', async () => {
    await processUpdate(dm('/allow'))
    expect(lastSent()).toContain('Usage')
  })

  it('revokes an ordinary member', async () => {
    await processUpdate(dm('/allow 999'))
    send.mockClear()
    await processUpdate(dm('/deny 999'))
    expect(lastSent()).toContain('Revoked')
    expect((await q.memberByTelegramId('999'))!.allowed).toBe(false)
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
        from: { id: 111, is_bot: false, first_name: 'Logan' },
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
    const m = await q.upsertMember('111', 'Logan', { allowed: true, isAdmin: true })
    await q.saveConnection({ memberId: m.id, provider: 'google', email: null, refreshToken: 'r', scopes: null })
    await processUpdate(dm('/unlink google'))
    expect(await q.connectionsFor(m.id)).toHaveLength(0)

    send.mockClear()
    await processUpdate(dm('/unlink hotmail'))
    expect(lastSent()).toContain('Usage')
  })
})

describe('/calendar', () => {
  it('hands over a subscribable feed url', async () => {
    await processUpdate(dm('/calendar'))
    expect(lastSent()).toMatch(/https:\/\/hearth\.han\.life\/api\/calendar\/.+\/family\.ics/)
    expect(lastSent()).toContain('Google Calendar')
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
    await processUpdate(from({ username: 'loganh' }))
    expect(lastSent()).toContain('**loganh**')
    await processUpdate(from({}))
    expect(lastSent()).toContain('**user111**')
  })

  it('treats an edited message like a new one', async () => {
    const edited = dm('/help') as { update_id: number; message: unknown }
    await processUpdate({ update_id: 10, edited_message: edited.message } as never)
    expect(lastSent()).toContain('/connect')
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
