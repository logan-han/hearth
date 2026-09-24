import { describe, it, expect, beforeEach, vi } from 'vitest'

const { getChatMemberCount, getChatMember, allowedMembers } = vi.hoisted(() => ({
  getChatMemberCount: vi.fn<(chatId: string) => Promise<number>>(),
  getChatMember: vi.fn<(chatId: string, userId: number) => Promise<{ status: string; is_member?: boolean }>>(),
  allowedMembers: vi.fn(async () => [] as { telegramUserId: string }[]),
}))
vi.mock('@/lib/telegram', () => ({ bot: () => ({ api: { getChatMemberCount, getChatMember } }) }))
vi.mock('@/lib/db/queries', () => ({ allowedMembers }))

const { unaccountedIn } = await import('@/lib/headcount')

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.ALLOWED_TELEGRAM_IDS = '111'
  allowedMembers.mockResolvedValue([{ telegramUserId: '111' }, { telegramUserId: '222' }, { telegramUserId: '333' }])
})

describe('unaccountedIn', () => {
  it('is zero when the room is the bot and allowed members only', async () => {
    getChatMemberCount.mockResolvedValue(3)
    getChatMember.mockImplementation(async (_c, id) => ({ status: id === 111 ? 'creator' : id === 222 ? 'member' : 'left' }))
    expect(await unaccountedIn('-100')).toBe(0)
  })

  it('counts the silent people nobody has vouched for', async () => {
    getChatMemberCount.mockResolvedValue(6)
    getChatMember.mockImplementation(async (_c, id) => ({ status: id === 333 ? 'kicked' : 'administrator' }))
    // 6 in the room, less the bot and the two allowed members present.
    expect(await unaccountedIn('-100')).toBe(3)
  })

  it('counts a restricted member only while they are still in the room', async () => {
    getChatMemberCount.mockResolvedValue(3)
    getChatMember.mockImplementation(async (_c, id) =>
      id === 111 ? { status: 'restricted', is_member: true } : id === 222 ? { status: 'restricted', is_member: false } : { status: 'member' },
    )
    expect(await unaccountedIn('-100')).toBe(0)
  })

  it('treats an id Telegram has never seen in the room as absent', async () => {
    getChatMemberCount.mockResolvedValue(2)
    getChatMember.mockImplementation(async (_c, id) => {
      if (id === 111) return { status: 'member' }
      throw new Error(id === 222 ? 'Bad Request: PARTICIPANT_ID_INVALID' : 'Bad Request: user not found')
    })
    expect(await unaccountedIn('-100')).toBe(0)
  })

  it('cannot say when Telegram refuses to show a member, rather than counting them absent', async () => {
    getChatMemberCount.mockResolvedValue(3)
    getChatMember.mockImplementation(async (_c, id) => {
      if (id === 111) return { status: 'member' }
      throw new Error('Bad Request: CHAT_ADMIN_REQUIRED')
    })
    expect(await unaccountedIn('-100')).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not look up a member'), expect.stringContaining('CHAT_ADMIN_REQUIRED'))
  })

  it('cannot say when Telegram will not count the room, which callers read as unsafe', async () => {
    getChatMemberCount.mockRejectedValue(new Error('Forbidden: bot was kicked from the group chat'))
    expect(await unaccountedIn('-100')).toBeNull()
    expect(getChatMember).not.toHaveBeenCalled()
  })

  it('asks about each person once, founders included, and skips a malformed seed entry', async () => {
    process.env.ALLOWED_TELEGRAM_IDS = '111,444,not-an-id'
    getChatMemberCount.mockResolvedValue(1)
    getChatMember.mockResolvedValue({ status: 'left' })
    await unaccountedIn('-100')
    expect(getChatMember.mock.calls.map(([, id]) => id).sort()).toEqual([111, 222, 333, 444])
  })
})
