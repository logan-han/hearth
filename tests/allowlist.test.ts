import { describe, it, expect, beforeEach, vi } from 'vitest'
import { idSet } from '@/lib/env'
import type { Member, Stranger } from '@/lib/db/schema'

const upsertMember = vi.fn<(id: string, name: string, grant?: object) => Promise<Member>>()
const memberByTelegramId = vi.fn<(id: string) => Promise<Member | undefined>>()
const strangersIn = vi.fn<(chatId: string) => Promise<Stranger[]>>()
const noteStranger = vi.fn<(chatId: string, s: Stranger) => Promise<boolean>>()
const clearStranger = vi.fn()
const rememberChat = vi.fn()
const send = vi.fn<(chatId: string, text: string, reply?: number) => Promise<void>>()

vi.mock('@/lib/summary', () => ({ maybeSummarise: vi.fn(async () => false) }))
vi.mock('@/lib/db/queries', () => ({
  upsertMember, memberByTelegramId, strangersIn, noteStranger, clearStranger, rememberChat,
  setMemberAllowed: vi.fn(async () => undefined),
  allowedMembers: vi.fn(async () => []),
  recordMessage: vi.fn(async () => 1),
  pruneMessages: vi.fn(async () => {}),
  connectionsFor: vi.fn(async () => []),
  deleteConnection: vi.fn(async () => {}),
  calendarToken: vi.fn(async () => 'tok'),
}))
vi.mock('@/lib/telegram', () => ({
  send, typing: vi.fn(), bot: () => ({ api: { getMe: async () => ({ id: 1, username: 'heart_family_bot' }) } }),
}))
const runAgent = vi.fn(async () => ({ text: 'sure', notices: [], model: 'test' }))
const shouldChimeIn = vi.fn(async () => false)
vi.mock('@/lib/agent', () => ({ runAgent, shouldChimeIn }))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => p }))

const { processUpdate, processInBackground } = await import('@/lib/handler')

const member = (over: Partial<Member> = {}): Member => ({
  id: 1, telegramUserId: '111', name: 'Logan', allowed: true, isAdmin: true,
  createdAt: new Date(), ...over,
} as Member)

function message(opts: { from: string; chat: string; type?: string; text?: string }) {
  return {
    update_id: 1,
    message: {
      message_id: 7, date: 1787000000,
      from: { id: Number(opts.from), is_bot: false, first_name: `User${opts.from}` },
      chat: { id: Number(opts.chat), type: opts.type ?? 'group', title: 'Family' },
      text: opts.text ?? 'hello',
    },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.ALLOWED_TELEGRAM_IDS = '111,222'
  memberByTelegramId.mockResolvedValue(undefined)
  strangersIn.mockResolvedValue([])
  noteStranger.mockResolvedValue(true)
  send.mockResolvedValue(undefined)
  upsertMember.mockImplementation(async (id, name) => member({ telegramUserId: id, name }))
})

describe('idSet', () => {
  it('parses comma, space and newline separated ids', () => {
    process.env.ALLOWED_TELEGRAM_IDS = '111, 222\n333  444'
    expect([...idSet('ALLOWED_TELEGRAM_IDS')].sort()).toEqual(['111', '222', '333', '444'])
  })

  it('ignores empty entries and is empty when unset', () => {
    process.env.ALLOWED_TELEGRAM_IDS = ' , 111 ,, '
    expect([...idSet('ALLOWED_TELEGRAM_IDS')]).toEqual(['111'])
    delete process.env.ALLOWED_TELEGRAM_IDS
    expect(idSet('ALLOWED_TELEGRAM_IDS').size).toBe(0)
  })
})

describe('authorisation is per person, not per room', () => {
  it('accepts a seeded member in a room nobody registered', async () => {
    await processUpdate(message({ from: '111', chat: '-100999' }))
    expect(upsertMember).toHaveBeenCalledWith('111', 'User111', { allowed: true, isAdmin: true })
    expect(noteStranger).not.toHaveBeenCalled()
  })

  it('accepts the same member in a second, brand new room', async () => {
    await processUpdate(message({ from: '222', chat: '-100777' }))
    await processUpdate(message({ from: '222', chat: '-100888' }))
    expect(noteStranger).not.toHaveBeenCalled()
    expect(rememberChat).toHaveBeenCalledTimes(2)
  })

  it('accepts a member an admin granted, who is not in the env seed', async () => {
    memberByTelegramId.mockResolvedValue(member({ telegramUserId: '333', allowed: true, isAdmin: false }))
    await processUpdate(message({ from: '333', chat: '-100999' }))
    expect(noteStranger).not.toHaveBeenCalled()
  })

  it('rejects a known member whose access was revoked', async () => {
    memberByTelegramId.mockResolvedValue(member({ telegramUserId: '333', allowed: false }))
    await processUpdate(message({ from: '333', chat: '-100999' }))
    expect(noteStranger).toHaveBeenCalledWith('-100999', { id: '333', name: 'User333' })
  })

  it('rejects everyone when nothing is configured', async () => {
    delete process.env.ALLOWED_TELEGRAM_IDS
    await processUpdate(message({ from: '111', chat: '-100999' }))
    expect(upsertMember).not.toHaveBeenCalled()
  })

  it('accepts a member added from the dashboard even with no env seed', async () => {
    delete process.env.ALLOWED_TELEGRAM_IDS
    memberByTelegramId.mockResolvedValue(member({ telegramUserId: '333', allowed: true, isAdmin: false }))
    await processUpdate(message({ from: '333', chat: '-100999' }))
    expect(noteStranger).not.toHaveBeenCalled()
    expect(upsertMember).toHaveBeenCalledWith('333', 'User333')
  })

  it('does not treat a numeric substring as a match', async () => {
    await processUpdate(message({ from: '11', chat: '-100999' }))
    expect(noteStranger).toHaveBeenCalled()
  })

  it('no longer grants access merely because a room was seen before', async () => {
    // The old behaviour trusted any room an allowed member had spoken in.
    await processUpdate(message({ from: '111', chat: '-100999' }))
    vi.clearAllMocks()
    strangersIn.mockResolvedValue([])
    await processUpdate(message({ from: '999', chat: '-100999' }))
    expect(upsertMember).not.toHaveBeenCalled()
    expect(noteStranger).toHaveBeenCalledWith('-100999', { id: '999', name: 'User999' })
  })
})

describe('strangers in a group', () => {
  it('announces an unknown speaker once, then stays quiet', async () => {
    await processUpdate(message({ from: '999', chat: '-100999' }))
    expect(send).toHaveBeenCalledWith('-100999', expect.stringContaining('999'))

    noteStranger.mockResolvedValue(false) // already recorded
    send.mockClear()
    await processUpdate(message({ from: '999', chat: '-100999' }))
    expect(send).not.toHaveBeenCalled()
  })

  const addressed = "@heart_family_bot what's on my calendar?"

  it('refuses to answer an allowed member while a stranger is present', async () => {
    strangersIn.mockResolvedValue([{ id: '999', name: 'Stranger' }])
    await processUpdate(message({ from: '111', chat: '-100999', text: addressed }))
    expect(send).toHaveBeenCalledWith('-100999', expect.stringContaining('Stranger'), 7)
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('answers the same question in a clean room', async () => {
    strangersIn.mockResolvedValue([])
    await processUpdate(message({ from: '111', chat: '-100999', text: addressed }))
    expect(runAgent).toHaveBeenCalled()
    expect(send.mock.calls.filter(([, t]) => String(t).includes('Not while'))).toHaveLength(0)
  })

  it('stays silent rather than refusing when nobody addressed the bot', async () => {
    strangersIn.mockResolvedValue([{ id: '999', name: 'Stranger' }])
    await processUpdate(message({ from: '111', chat: '-100999', text: 'just chatting' }))
    expect(send).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
  })

  it('never gates a private chat on strangers', async () => {
    strangersIn.mockResolvedValue([{ id: '999', name: 'Stranger' }])
    await processUpdate(message({ from: '111', chat: '111', type: 'private', text: 'hi' }))
    expect(runAgent).toHaveBeenCalled()
    expect(send.mock.calls.filter(([, t]) => String(t).includes('Not while'))).toHaveLength(0)
  })

  it('clears the flag when an allowed member speaks', async () => {
    await processUpdate(message({ from: '111', chat: '-100999' }))
    expect(clearStranger).toHaveBeenCalledWith('-100999', '111')
  })
})

describe('ambient mode', () => {
  it('asks the chime-in judge about unaddressed chatter only when switched on', async () => {
    process.env.AMBIENT_MODE = 'on'
    try {
      await processUpdate(message({ from: '111', chat: '-100999', text: 'just chatting' }))
      expect(shouldChimeIn).toHaveBeenCalled()
      expect(runAgent).not.toHaveBeenCalled()
    } finally {
      delete process.env.AMBIENT_MODE
    }
  })
})

describe('processInBackground', () => {
  it('never throws out of the webhook, logging instead', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rememberChat.mockRejectedValueOnce(new Error('db down'))
    processInBackground(message({ from: '111', chat: '-100999' }))
    await vi.waitFor(() =>
      expect(errSpy).toHaveBeenCalledWith('[telegram] processing failed:', expect.any(Error)),
    )
  })
})

describe('/deny against a founder', () => {
  const deny = (target: string) =>
    processUpdate(message({ from: '111', chat: '111', type: 'private', text: `/deny ${target}` }))

  it('refuses, because the env seed would silently undo it', async () => {
    await deny('222')
    expect(send).toHaveBeenCalledWith('111', expect.stringContaining('ALLOWED_TELEGRAM_IDS'))
  })

  it('still revokes an ordinary member granted with /allow', async () => {
    await deny('333')
    expect(send).not.toHaveBeenCalledWith('111', expect.stringContaining('ALLOWED_TELEGRAM_IDS'))
  })
})

describe('unknown sender in a DM', () => {
  it('hands back their own id so an admin can vouch for them', async () => {
    await processUpdate(message({ from: '999', chat: '999', type: 'private', text: '/start' }))
    expect(send).toHaveBeenCalledWith('999', expect.stringContaining('999'))
    expect(noteStranger).not.toHaveBeenCalled()
  })

  it('stays silent on anything else', async () => {
    await processUpdate(message({ from: '999', chat: '999', type: 'private', text: 'let me in' }))
    expect(send).not.toHaveBeenCalled()
  })
})

describe('join and leave events', () => {
  const joinUpdate = (id: number) => ({
    update_id: 2,
    message: {
      message_id: 8, date: 1787000000,
      chat: { id: -100999, type: 'group', title: 'Family' },
      from: { id: 111, is_bot: false, first_name: 'Logan' },
      new_chat_members: [{ id, is_bot: false, first_name: `User${id}` }],
    },
  }) as never

  it('flags an unrecognised joiner before they say anything', async () => {
    await processUpdate(joinUpdate(999))
    expect(noteStranger).toHaveBeenCalledWith('-100999', { id: '999', name: 'User999' })
    expect(send).toHaveBeenCalledWith('-100999', expect.stringContaining('/allow'))
  })

  it('says nothing when the joiner is already a member', async () => {
    await processUpdate(joinUpdate(222))
    expect(noteStranger).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('clears the flag when someone leaves', async () => {
    await processUpdate({
      update_id: 3,
      message: {
        message_id: 9, date: 1787000000,
        chat: { id: -100999, type: 'group' },
        from: { id: 111, is_bot: false, first_name: 'Logan' },
        left_chat_member: { id: 999, is_bot: false, first_name: 'User999' },
      },
    } as never)
    expect(clearStranger).toHaveBeenCalledWith('-100999', '999')
  })
})
