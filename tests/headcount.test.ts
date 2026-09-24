import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GrammyError, HttpError } from 'grammy'

const { getChatMemberCount, getChatMember, getMe, allowedMembers } = vi.hoisted(() => ({
  getChatMemberCount: vi.fn<(chatId: string) => Promise<number>>(),
  getChatMember: vi.fn<(chatId: string, userId: number) => Promise<{ status: string; is_member?: boolean; user: { id: number } }>>(),
  getMe: vi.fn(async () => ({ id: 1 })),
  allowedMembers: vi.fn(async () => [] as { telegramUserId: string }[]),
}))
vi.mock('@/lib/telegram', () => ({ bot: () => ({ api: { getChatMemberCount, getChatMember, getMe } }) }))
vi.mock('@/lib/db/queries', () => ({ allowedMembers }))

const { unaccountedIn } = await import('@/lib/headcount')

/** Telegram's answer for one person: a status, and who it is about. */
const as = (status: string, id: number, isMember?: boolean) => ({ status, user: { id }, ...(isMember === undefined ? {} : { is_member: isMember }) })
/** A refusal shaped the way grammY builds one. */
const refusal = (code: number, description: string) =>
  new GrammyError(`Call to 'getChatMember' failed! (${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  process.env.ALLOWED_TELEGRAM_IDS = '111'
  getMe.mockResolvedValue({ id: 1 })
  allowedMembers.mockResolvedValue([{ telegramUserId: '111' }, { telegramUserId: '222' }, { telegramUserId: '333' }])
})

// Most totals below are one more than the bot and the members present, so a
// person counted who is not there shows as a wrong answer, not a clamp at 0.
describe('unaccountedIn', () => {
  it('is zero when the room is the bot and allowed members only', async () => {
    getChatMemberCount.mockResolvedValue(3)
    getChatMember.mockImplementation(async (_c, id) => as(id === 111 ? 'creator' : id === 222 ? 'member' : 'left', id))
    expect(await unaccountedIn('-100')).toBe(0)
  })

  it('counts someone nobody has vouched for, and never an allowed member who has left or been removed', async () => {
    getChatMemberCount.mockResolvedValue(4)
    // Present: the bot, 111 and 222. Gone: 333. So one of the four is a stranger.
    for (const gone of ['left', 'kicked']) {
      getChatMember.mockImplementation(async (_c, id) => as(id === 333 ? gone : id === 111 ? 'administrator' : 'member', id))
      expect(await unaccountedIn('-100')).toBe(1)
    }
  })

  it('counts a restricted member only while they are still in the room', async () => {
    getChatMemberCount.mockResolvedValue(4)
    getChatMember.mockImplementation(async (_c, id) =>
      id === 111 ? as('restricted', id, true) : id === 222 ? as('restricted', id, false) : as('member', id),
    )
    expect(await unaccountedIn('-100')).toBe(1)
  })

  it('treats an id Telegram has never seen in the room as absent', async () => {
    getChatMemberCount.mockResolvedValue(3)
    getChatMember.mockImplementation(async (_c, id) => {
      if (id === 111) return as('member', id)
      throw refusal(400, id === 222 ? 'Bad Request: PARTICIPANT_ID_INVALID' : 'Bad Request: user not found')
    })
    expect(await unaccountedIn('-100')).toBe(1)
  })

  it('counts each person once, however their id was written, and never the bot as a member', async () => {
    process.env.ALLOWED_TELEGRAM_IDS = '0111,1'
    getChatMemberCount.mockResolvedValue(3)
    getChatMember.mockImplementation(async (_c, id) => as(id === 111 ? 'member' : 'left', id))
    // The bot, 111 (listed twice over) and one stranger.
    expect(await unaccountedIn('-100')).toBe(1)
    expect(getChatMember.mock.calls.map(([, id]) => id).sort()).toEqual([111, 222, 333])
  })

  it('cannot say when Telegram refuses to show a member, rather than counting them absent', async () => {
    getChatMemberCount.mockResolvedValue(3)
    getChatMember.mockImplementation(async (_c, id) => {
      if (id === 111) return as('member', id)
      throw refusal(400, 'Bad Request: CHAT_ADMIN_REQUIRED')
    })
    expect(await unaccountedIn('-100')).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('could not look up a member'), expect.stringContaining('CHAT_ADMIN_REQUIRED'))
  })

  it('cannot say when Telegram will not count the room, which callers read as unsafe', async () => {
    getChatMemberCount.mockRejectedValue(refusal(403, 'Forbidden: bot was kicked from the group chat'))
    expect(await unaccountedIn('-100')).toBeNull()
    expect(getChatMember).not.toHaveBeenCalled()
  })

  it('throws a rate limit, an outage or a network failure on, rather than reading it as an answer', async () => {
    getChatMemberCount.mockRejectedValueOnce(refusal(429, 'Too Many Requests: retry after 5'))
    await expect(unaccountedIn('-100')).rejects.toThrow(/Too Many Requests/)

    getChatMemberCount.mockResolvedValue(3)
    getChatMember.mockRejectedValueOnce(refusal(502, 'Bad Gateway'))
    await expect(unaccountedIn('-100')).rejects.toThrow(/Bad Gateway/)

    getChatMember.mockRejectedValueOnce(new HttpError('Network request for getChatMember failed!', new Error('ECONNRESET')))
    await expect(unaccountedIn('-100')).rejects.toThrow(/Network request/)
  })

  it('asks about each person once, founders included, and skips a malformed seed entry', async () => {
    process.env.ALLOWED_TELEGRAM_IDS = '111,444,not-an-id'
    getChatMemberCount.mockResolvedValue(1)
    getChatMember.mockImplementation(async (_c, id) => as('left', id))
    await unaccountedIn('-100')
    expect(getChatMember.mock.calls.map(([, id]) => id).sort()).toEqual([111, 222, 333, 444])
  })
})
