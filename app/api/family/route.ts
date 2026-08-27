import { NextResponse } from 'next/server'
import { readSession } from '@/lib/auth/session'
import {
  cancelFamilyEvent,
  getAutomation,
  setAutomationEnabled,
  deleteAutomation,
  findOrCreateList,
  setListItemDone,
  deleteListItem,
  addListItems,
} from '@/lib/db/queries'
import { nextRun } from '@/lib/cron'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Household mutations from the Home page. Gated on being a recognised member,
 * not an admin: everything here is something any member can already do by
 * asking the bot in the chat, so the web is just a second pair of hands.
 */
export async function POST(req: Request) {
  if (!(await readSession())) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })

  let body: { action?: string; id?: number; enabled?: boolean; done?: boolean; list?: string; content?: string }
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
      if (!(await deleteAutomation(id))) return NextResponse.json({ error: `No reminder ${id}.` }, { status: 404 })
      return NextResponse.json({ ok: true })
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
