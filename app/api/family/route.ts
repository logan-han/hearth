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
  deleteMemory,
  answerQuestion,
  getGoal,
  closeGoal,
  getGoalStep,
  setGoalStepDone,
  getDraft,
  markDraft,
  connectionsFor,
  getHelper,
  deleteHelper,
  setConnectionReadOnly,
  deleteConnection,
} from '@/lib/db/queries'
import { clientFor } from '@/lib/providers'
import { UnconfirmedError } from '@/lib/deadline'
import { describeAccountError, readOnlyRefusal } from '@/lib/tools/mail'
import { noteActivity } from '@/lib/activity'
import type { Provider } from '@/lib/oauth/providers'
import { resumeAt } from '@/lib/tools/automation'
import { hydrateSecrets } from '@/lib/settings'
import { acceptProposal } from '@/lib/tools/proposals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A goal, a draft and a reminder are their member's alone. */
const own = (row: { memberId: number | null }, viewer: number | null) => viewer !== null && row.memberId === viewer

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
 * Mutations from Home and Connect. Gated on being a recognised member, not an
 * admin: everything here is something a member can already do from their MCP
 * client, so the web is just a second pair of hands. What is a member's own
 * (a goal, a draft, a reminder, a linked account) is theirs alone to change.
 */
export async function POST(req: Request) {
  const session = await requireMember()
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  // A resumed reminder's next run is worked out in the household's zone,
  // which may live in the dashboard rather than this instance's environment.
  await hydrateSecrets()

  let body: {
    action?: string
    id?: number
    enabled?: boolean
    done?: boolean
    list?: string
    content?: string
    fact?: string
    status?: string
    provider?: string
    readOnly?: boolean
    confirmedDistinct?: boolean
  }
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
      // The same accept as accept_event_proposal: added, or held for a named
      // same-day clash until the member says it is a different occasion, or
      // refused with why. Never a click that quietly does nothing.
      const result = await acceptProposal(id, { confirmedDistinct: body.confirmedDistinct === true, memberId: session.memberId })
      if (result.status === 'failed') return NextResponse.json({ ...result }, { status: 409 })
      if (result.status === 'added') {
        await noteActivity({ memberId: session.memberId, via: 'web', tool: 'accept_event_proposal', input: { proposal_id: id }, result })
      }
      return NextResponse.json({ ok: true, ...result })
    }

    case 'reject_proposal': {
      const row = await settleProposal(id, 'rejected')
      if (!row) return NextResponse.json({ error: `Proposal ${id} is no longer waiting for an answer.` }, { status: 404 })
      return NextResponse.json({ ok: true, rejected: row.title })
    }

    case 'pause_automation': {
      const existing = await getAutomation(id)
      if (!existing || !own(existing, session.memberId)) return NextResponse.json({ error: `No reminder ${id} of yours.` }, { status: 404 })
      // A paused automation's next_run_at goes stale, so recompute on resume.
      const enabled = body.enabled === true
      const next = enabled ? resumeAt(existing) : null
      await setAutomationEnabled(id, enabled, next ?? undefined)
      return NextResponse.json({ ok: true, enabled })
    }

    case 'delete_automation': {
      const existing = await getAutomation(id)
      if (!existing || !own(existing, session.memberId)) return NextResponse.json({ error: `No reminder ${id} of yours.` }, { status: 404 })
      if (!(await deleteAutomation(id))) return NextResponse.json({ error: `No reminder ${id}.` }, { status: 404 })
      return NextResponse.json({ ok: true })
    }

    case 'forget_memory': {
      // Soft, as the forget tool is: the fact stops being Known but stays as history.
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

    case 'toggle_goal_step': {
      // As for closing: a goal is its owner's alone to tick.
      const step = await getGoalStep(id)
      const goal = step ? await getGoal(step.goalId) : undefined
      if (!goal || !own(goal, session.memberId)) return NextResponse.json({ error: `No step ${id}.` }, { status: 404 })
      const row = await setGoalStepDone(id, body.done === true)
      return NextResponse.json({ ok: true, done: row!.done })
    }

    case 'close_goal': {
      if (body.status !== 'done' && body.status !== 'dropped') return NextResponse.json({ error: 'A goal closes as done or dropped.' }, { status: 400 })
      // Home lists the viewer's own goals; another member's is theirs to close.
      const goal = await getGoal(id)
      if (!goal || !own(goal, session.memberId)) {
        return NextResponse.json({ error: `No goal ${id}.` }, { status: 404 })
      }
      const closed = await closeGoal(id, body.status)
      if (!closed) return NextResponse.json({ error: `"${goal.title}" is already closed.` }, { status: 404 })
      // Nothing left to check in on.
      if (goal.automationId) await deleteAutomation(goal.automationId)
      return NextResponse.json({ ok: true, closed: goal.title, status: body.status })
    }

    case 'send_draft':
    case 'discard_draft': {
      // A draft is its writer's alone to send or throw away: it goes from their mailbox, in their name.
      const draft = await getDraft(id)
      if (!draft || draft.memberId !== session.memberId) return NextResponse.json({ error: `No draft ${id} of yours.` }, { status: 404 })
      if (body.action === 'discard_draft') {
        if (!(await markDraft(id, 'cancelled'))) return NextResponse.json({ error: `That draft is already ${draft.status}.` }, { status: 409 })
        await noteActivity({ memberId: draft.memberId, via: 'web', tool: 'cancel_draft', input: { draft_id: id }, result: {} })
        return NextResponse.json({ ok: true, discarded: draft.subject })
      }
      // Linked read-only since the draft was written, the account sends nothing, click or no click.
      if ((await connectionsFor(draft.memberId)).some((c) => c.provider === draft.provider && c.readOnly)) {
        return NextResponse.json({ error: readOnlyRefusal(draft.provider as Provider) }, { status: 409 })
      }
      // The click is the yes. Claimed first, as send_email does, so two clicks cannot send it twice.
      if (!(await markDraft(id, 'sent'))) return NextResponse.json({ error: `That draft is already ${draft.status}.` }, { status: 409 })
      const to = draft.recipients.split(',').map((s) => s.trim()).filter(Boolean)
      try {
        await clientFor(draft.memberId, draft.provider as Provider).sendMail({
          to,
          cc: draft.cc?.split(',').map((s) => s.trim()).filter(Boolean),
          subject: draft.subject,
          body: draft.body,
        })
      } catch (err) {
        // One that ran out of time may have gone, and stays claimed so it is not sent again.
        if (err instanceof UnconfirmedError) {
          return NextResponse.json({ error: 'The send took too long to be confirmed, so it may or may not have gone. Check your Sent folder.' }, { status: 504 })
        }
        await markDraft(id, 'pending', 'sent')
        return NextResponse.json({ error: describeAccountError(err) }, { status: 502 })
      }
      await noteActivity({ memberId: draft.memberId, via: 'web', tool: 'send_email', input: { draft_id: id }, result: { to: draft.recipients, subject: draft.subject } })
      return NextResponse.json({ ok: true, sent: draft.subject })
    }

    case 'remove_helper': {
      // Anyone can, as with remove_helper; jobs already handed to it are left to Hearth itself.
      const helper = await getHelper(id)
      if (!helper || !(await deleteHelper(id))) return NextResponse.json({ error: `No helper ${id}.` }, { status: 404 })
      return NextResponse.json({ ok: true, removed: helper.name })
    }

    case 'set_read_only':
    case 'unlink_account': {
      // One of the signed-in member's own accounts, never anyone else's.
      const provider = body.provider
      if (provider !== 'google' && provider !== 'microsoft') return NextResponse.json({ error: 'Which account?' }, { status: 400 })
      if (session.memberId === null) return NextResponse.json({ error: 'Only a family member has accounts linked here.' }, { status: 403 })
      if (body.action === 'unlink_account') {
        await deleteConnection(session.memberId, provider)
        return NextResponse.json({ ok: true, unlinked: provider })
      }
      const row = await setConnectionReadOnly(session.memberId, provider, body.readOnly === true)
      if (!row) return NextResponse.json({ error: `No ${provider} account of yours is linked.` }, { status: 404 })
      return NextResponse.json({ ok: true, readOnly: row.readOnly })
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
      // The ticked ones only, as clear_list does by default: nothing still to get goes.
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
