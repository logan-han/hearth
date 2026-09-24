import { NextResponse } from 'next/server'
import { requireMember } from '@/lib/auth/session'
import {
  cancelFamilyEvent,
  getAutomation,
  setAutomationEnabled,
  deleteAutomation,
  findOrCreateList,
  setListItemDone,
  deleteListItem,
  addListItems,
  clearList,
  listContents,
  settleProposal,
  addFamilyEvent,
  listFamilyEvents,
  deleteMemory,
  answerQuestion,
} from '@/lib/db/queries'
import { nextRun } from '@/lib/cron'
import { hydrateSecrets } from '@/lib/settings'
import { isBuiltinKind } from '@/lib/watchers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One list in full, older ticked items included. Home carries only the ten
 * ticked items added last, and nothing records when an item was ticked, so
 * one ticked just now can be among those left out; this is how Home reaches
 * it again, to untick or remove it.
 */
export async function GET(req: Request) {
  if (!(await requireMember())) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const id = Number(new URL(req.url).searchParams.get('list'))
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'Which list?' }, { status: 400 })
  const items = await listContents(id)
  return NextResponse.json({ items: items.map((i) => ({ id: i.id, content: i.content, done: i.done })) })
}

/**
 * Household mutations from the Home page. Gated on being a recognised member,
 * not an admin: everything here is something any member can already do by
 * asking the bot in the chat, so the web is just a second pair of hands.
 */
export async function POST(req: Request) {
  const session = await requireMember()
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // A resumed reminder's next run is worked out in the household's zone,
  // which may live in the dashboard rather than this instance's environment.
  await hydrateSecrets()

  let body: { action?: string; id?: number; enabled?: boolean; done?: boolean; list?: string; content?: string; fact?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 })
  }

  const id = Number(body.id)
  switch (body.action) {
    case 'cancel_event': {
      const row = await cancelFamilyEvent(id)
      if (!row) return NextResponse.json({ error: `No event ${id}.` }, { status: 404 })
      return NextResponse.json({ ok: true, cancelled: row.title })
    }

    case 'accept_proposal': {
      // Claim first, as the chat tool does, so two clicks cannot add it twice.
      const row = await settleProposal(id, 'accepted')
      if (!row) return NextResponse.json({ error: `Proposal ${id} is no longer waiting for an answer.` }, { status: 404 })
      // The same occasion may have reached the calendar another way meanwhile.
      const clash = (await listFamilyEvents(row.startsAt, row.endsAt)).find(
        (e) =>
          !e.cancelled &&
          e.startsAt.getTime() === row.startsAt.getTime() &&
          e.title.trim().toLowerCase() === row.title.trim().toLowerCase(),
      )
      if (clash) return NextResponse.json({ ok: true, added: false, already: clash.title })
      const event = await addFamilyEvent({
        title: row.title,
        description: row.description,
        location: row.location,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        allDay: row.allDay,
        createdBy: session.memberId,
      })
      return NextResponse.json({ ok: true, added: true, id: event.id })
    }

    case 'reject_proposal': {
      const row = await settleProposal(id, 'rejected')
      if (!row) return NextResponse.json({ error: `Proposal ${id} is no longer waiting for an answer.` }, { status: 404 })
      return NextResponse.json({ ok: true, rejected: row.title })
    }

    case 'pause_automation': {
      const existing = await getAutomation(id)
      if (!existing) return NextResponse.json({ error: `No reminder ${id}.` }, { status: 404 })
      // A paused automation's next_run_at goes stale, so recompute on resume.
      const enabled = body.enabled === true
      const next = enabled ? nextRun(existing.cronExpr) : null
      await setAutomationEnabled(id, enabled, next ?? undefined)
      return NextResponse.json({ ok: true, enabled })
    }

    case 'delete_automation': {
      const existing = await getAutomation(id)
      if (!existing) return NextResponse.json({ error: `No reminder ${id}.` }, { status: 404 })
      // Built in means the tick would only put it back; a pause is the off switch.
      if (isBuiltinKind(existing.kind)) {
        return NextResponse.json({ error: `${existing.label} is built in. Pause it instead.` }, { status: 400 })
      }
      if (!(await deleteAutomation(id))) return NextResponse.json({ error: `No reminder ${id}.` }, { status: 404 })
      return NextResponse.json({ ok: true })
    }

    case 'forget_memory': {
      // Soft, as in the chat: the fact stops being Known but stays as history.
      const row = await deleteMemory(id)
      if (!row) return NextResponse.json({ error: `Nothing remembered as ${id}.` }, { status: 404 })
      return NextResponse.json({ ok: true, forgotten: row.content })
    }

    case 'answer_question': {
      // A yes keeps the fact as written in the box, a correction included; a no keeps nothing.
      const fact = String(body.fact ?? '').trim()
      const settled = await answerQuestion(id, fact || null, session.memberId)
      if (!settled) return NextResponse.json({ error: `Question ${id} is no longer open.` }, { status: 404 })
      return NextResponse.json({ ok: true, ...(settled.memory ? { kept: settled.memory.content } : { dismissed: true }) })
    }

    case 'toggle_item': {
      const row = await setListItemDone(id, body.done === true)
      if (!row) return NextResponse.json({ error: `No item ${id}.` }, { status: 404 })
      return NextResponse.json({ ok: true, done: row.done })
    }

    case 'delete_item': {
      if (!(await deleteListItem(id))) return NextResponse.json({ error: `No item ${id}.` }, { status: 404 })
      return NextResponse.json({ ok: true })
    }

    case 'clear_ticked': {
      // The ticked ones only, as clearing a list does in the chat: nothing still to get goes.
      const cleared = await clearList(id, true)
      return NextResponse.json({ ok: true, cleared: cleared.length })
    }

    case 'add_item': {
      const content = String(body.content ?? '').trim()
      const listName = String(body.list ?? '').trim()
      if (!content || !listName) return NextResponse.json({ error: 'A list and an item are needed.' }, { status: 400 })
      const list = await findOrCreateList(listName)
      const [item] = await addListItems(list.id, [content])
      return NextResponse.json({ ok: true, id: item.id })
    }

    default:
      return NextResponse.json({ error: `Unknown action "${body.action}".` }, { status: 400 })
  }
}
