import { NextResponse } from 'next/server'
import { Receiver } from '@upstash/qstash'
import {
  dueAutomations, claimAutomation, allowedMembers, recordMessage,
  messagesSince, getSetting, setSetting,
} from '@/lib/db/queries'
import { localDateKey, tzOffsetMs } from '@/lib/cron'
import { timezone } from '@/lib/env'
import { db, schema } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { runAgent } from '@/lib/agent'
import { nextRun } from '@/lib/cron'
import { send } from '@/lib/telegram'
import { hydrateSecrets } from '@/lib/settings'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

/** QStash signs every delivery; without keys we only accept a manual admin secret. */
async function authorised(req: Request, body: string): Promise<boolean> {
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY
  const next = process.env.QSTASH_NEXT_SIGNING_KEY
  const signature = req.headers.get('upstash-signature')

  if (current && signature) {
    try {
      const receiver = new Receiver({ currentSigningKey: current, nextSigningKey: next ?? current })
      return await receiver.verify({ signature, body, url: req.url })
    } catch (err) {
      console.warn('[tick] signature verification failed:', err)
      return false
    }
  }

  const adminSecret = process.env.TICK_SECRET
  return Boolean(adminSecret) && req.headers.get('x-tick-secret') === adminSecret
}

/**
 * Failures and diagnostics belong in an admin's DM, not the family group: the
 * chat is for the household, not for stack traces. Preference order is the
 * automation's creator, then any admin; if nobody is reachable it stays in
 * the logs rather than the group.
 */
async function tellAdminQuietly(creator: { telegramUserId: string } | undefined, text: string): Promise<void> {
  const admins = await allowedMembers()
    .then((all) => all.filter((m) => m.isAdmin).map((m) => m.telegramUserId))
    .catch(() => [] as string[])
  const targets = [...new Set([creator?.telegramUserId, ...admins].filter(Boolean))] as string[]
  for (const to of targets) {
    try {
      await send(to, text)
      try {
        // Into that DM's history too, or the admin's next reply lands on a
        // conversation the model cannot see.
        await recordMessage({ chatId: to, role: 'assistant', content: text })
      } catch {
        // Delivered is what matters; history here is best-effort.
      }
      return
    } catch {
      // They may never have opened a DM with the bot; try the next admin.
    }
  }
  console.error('[tick] no admin reachable by DM:', text)
}

const isSkipLine = (line: string) => /^skip[.!]*$/i.test(line.trim())

/**
 * The nightly memory pass: relying on the chat-turn model to file memories
 * while it is busy answering leaves most facts on the floor, so once a day the
 * previous day's talk is re-read purely for what deserves keeping. One model
 * call, silent, add/update/delete through the ordinary memory tools.
 */
async function maybeConsolidateMemory(now: Date): Promise<void> {
  const localHour = new Date(now.getTime() + tzOffsetMs(now, timezone())).getUTCHours()
  if (localHour < 3) return
  const today = localDateKey(now)
  if ((await getSetting('memory_sweep_day')) === today) return
  // Claim before working; a racing tick at worst repeats an idempotent pass.
  await setSetting('memory_sweep_day', today)

  const talk = await messagesSince(26)
  if (talk.length === 0) return

  const transcript = talk
    .map((m) => `[${m.chatId}] ${m.role === 'user' ? (m.authorName ?? 'someone') : 'you'}: ${m.content.slice(0, 400)}`)
    .join('\n')

  try {
    await runAgent({
      chatId: 'memory-sweep',
      chatType: 'private',
      member: null,
      memberName: 'the household',
      history: false,
      text:
        "Nightly memory pass. Below is yesterday's household talk; your Known household facts are in context. " +
        'Store any durable fact that is missing with `remember`, and where the talk contradicts a known fact, `forget` the old one and `remember` the new (the newer statement wins). ' +
        'The test for durable is simple: would the household need this again weeks or months from now? Examples, not limits: who people are (family, friends, neighbours, teachers, coaches, doctors, tradies), recurring dates like birthdays and anniversaries, health, allergies and dietary needs, routines and standing arrangements, schools, clubs and activities, pets, vehicles, sizes, codes and account identifiers, house rules, strong preferences and dislikes. ' +
        'Not durable: one-off plans (the calendar holds those), shopping and list items, tasks, and passing chatter. ' +
        'Then reply with exactly SKIP.\n\n' +
        transcript,
    })
  } catch (err) {
    // A failed pass costs nothing; tomorrow re-reads a fresh day.
    console.error('[tick] memory pass failed:', err)
  }
}

async function runDue(): Promise<{ ran: number; skipped: number }> {
  const now = new Date()
  const due = await dueAutomations(now)
  let ran = 0
  let skipped = 0

  for (const a of due) {
    // Claim before running: an overlapping tick then finds nothing to do.
    const following = nextRun(a.cronExpr, new Date(now.getTime() + 1000))
    if (!(await claimAutomation(a.id, a.nextRunAt, following))) {
      skipped++
      continue
    }

    try {
      const member = a.memberId
        ? (await db().select().from(schema.members).where(eq(schema.members.id, a.memberId)).limit(1))[0]
        : undefined

      const result = await runAgent({
        chatId: a.chatId,
        chatType: 'group',
        member: member ?? null,
        memberName: member?.name ?? 'the family',
        text:
          `Scheduled automation "${a.label}" is due now. Carry out this instruction; whatever you write will be posted to the family chat, briefly:\n\n${a.instruction}\n\n` +
          'Interpret rather than relay: a scheduled post should read like a sharp-eyed housemate noticing something, not an API response. ' +
          'If the instruction only wants a post under some condition and that condition is not met (nothing new, nothing to report), reply with exactly SKIP and nothing will be posted. ' +
          'If a tool fails or errors, never post the failure to the chat: reply with a one-line diagnosis and then SKIP on its own line — it goes privately to the admins instead. ' +
          'Reply with the post alone: no preamble, no planning notes, no commentary about what the tools returned.',
        history: false,
      })

      // Any part carrying a lone SKIP line stays out of the chat: a bare SKIP
      // is a quiet run, and anything written around it is a diagnosis for the
      // admins, not the family. Tool notices without SKIP still post.
      const speak: string[] = []
      const quiet: string[] = []
      for (const part of [result.text, ...result.notices].filter(Boolean)) {
        const lines = part.split('\n')
        if (lines.some(isSkipLine)) {
          const rest = lines.filter((l) => !isSkipLine(l)).join('\n').trim()
          if (rest) quiet.push(rest)
        } else {
          speak.push(part)
        }
      }

      const message = speak.join('\n\n').trim()
      if (message) {
        await send(a.chatId, message)
        await db().insert(schema.messages).values({
          chatId: a.chatId,
          role: 'assistant',
          content: message,
          model: result.model,
        })
      }
      if (quiet.length) {
        await tellAdminQuietly(member, `Watcher **${a.label}** stayed quiet in the chat, but reported:\n\n${quiet.join('\n\n')}`)
      }
      ran++
    } catch (err) {
      console.error(`[tick] automation ${a.id} failed:`, err)
      const reason = err instanceof Error ? err.message : String(err)
      try {
        await tellAdminQuietly(undefined, `Watcher **${a.label}** failed: ${reason}`)
      } catch (sendErr) {
        // One broken automation must not stop the rest of the tick.
        console.error(`[tick] could not report automation ${a.id} failure:`, sendErr)
      }
    }
  }

  return { ran, skipped }
}

export async function POST(req: Request) {
  // Automations run the agent and message Telegram, so dashboard-managed
  // settings must be hydrated the same as on the webhook path.
  await hydrateSecrets()
  const body = await req.text()
  if (!(await authorised(req, body))) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  const result = await runDue()
  await maybeConsolidateMemory(new Date())
  return NextResponse.json({ ok: true, ...result })
}

export async function GET(req: Request) {
  // Vercel Cron sends GET; QStash sends POST. Both land here.
  return POST(new Request(req.url, { method: 'POST', headers: req.headers, body: '' }))
}
