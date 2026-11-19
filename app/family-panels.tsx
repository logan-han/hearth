'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Empty } from './ui'

/**
 * The Home panels, able to act as well as show: everything here is something
 * a member could already do from their MCP client, so the buttons are just the
 * shorter path. Mutations go through /api/family, then the server component
 * re-renders via router.refresh(), so there is no client-side copy of truth.
 */

function useFamilyActions() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/family', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'That did not work.')
      router.refresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  return { act, busy, error }
}

/**
 * Events found in an email or a notice that will not be added on their own.
 * Saying yes here is the same yes as accept_event_proposal, one click closer,
 * and it says where each one came from so nobody has to go and find the message.
 */
export function Proposals({
  proposals,
}: {
  proposals: { id: number; title: string; when: string; who: string | null; detail: string }[]
}) {
  const { act, busy, error } = useFamilyActions()
  const router = useRouter()
  // A proposal whose day already holds something on the calendar waits for a
  // second click that says it is a different occasion, with the clash named.
  const [held, setHeld] = useState<Record<number, string>>({})
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  async function add(id: number, confirmedDistinct = false) {
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch('/api/family', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'accept_proposal', id, confirmedDistinct }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.reason ?? data.error ?? 'That did not work.')
      if (data.status === 'needs_confirmation') {
        setHeld((h) => ({ ...h, [id]: data.reason as string }))
        return
      }
      setHeld(({ [id]: _, ...rest }) => rest)
      router.refresh()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="panel">
      <p className="group-note">
        Found in mail or a notice. Nothing here reaches the family calendar until someone says yes.
      </p>
      <ul className="listing doable">
        {proposals.map((p) => (
          <li key={p.id}>
            <span className="grow">
              <span className="title">{p.title}</span>
              <span className="meta">
                {p.when}{p.who ? ` · found for ${p.who}` : ''}
              </span>
              {p.detail ? <span className="meta">{p.detail}</span> : null}
              {held[p.id] ? <span className="meta warn">{held[p.id]}</span> : null}
            </span>
            <span className="row-acts">
              {held[p.id] ? (
                <button className="primary" disabled={busy || adding} title="It is a different occasion: add it anyway" onClick={() => add(p.id, true)}>
                  Add anyway
                </button>
              ) : (
                <button className="primary" disabled={busy || adding} title="Add to the family calendar" onClick={() => add(p.id)}>
                  Add
                </button>
              )}
              <button disabled={busy || adding} title="Not this one" onClick={() => act({ action: 'reject_proposal', id: p.id })}>
                No
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error || addError ? <p className="flash bad">{error ?? addError}</p> : null}
    </div>
  )
}

export function NextUp({ events }: { events: { id: number; title: string; when: string }[] }) {
  const { act, busy, error } = useFamilyActions()

  return (
    <div className="panel">
      {events.length === 0 ? (
        <Empty>Nothing coming up. Add an event from your MCP client and it lands here.</Empty>
      ) : (
        <ul className="listing doable">
          {events.map((e) => (
            <li key={e.id}>
              <span className="grow">
                <span className="title">{e.title}</span>
                <span className="meta">{e.when}</span>
              </span>
              <span className="row-acts">
                <button
                  disabled={busy}
                  title="Cancel this event"
                  onClick={() => confirm(`Cancel "${e.title}" for everyone?`) && act({ action: 'cancel_event', id: e.id })}
                >
                  Cancel
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}

export function Reminders({
  automations,
  scheduler,
}: {
  automations: {
    id: number
    label: string
    enabled: boolean
    /** A job that goes once it has run, or once it has found what it was waiting for. */
    repeat?: 'once' | 'until' | null
    nextRun: string | null
    offGrid: boolean
    runsAt: string | null
  }[]
  /** When the scheduler ticks, in words, once it has shown its cadence. */
  scheduler: string | null
}) {
  const { act, busy, error } = useFamilyActions()

  return (
    <div className="panel">
      {automations.length === 0 ? (
        <Empty>None scheduled. Ask your MCP client to set one up; what each one finds is kept under Reports.</Empty>
      ) : (
        <ul className="listing doable">
          {automations.map((a) => (
            <li key={a.id}>
              <span className="grow">
                <span className="title">
                  {a.label}
                  {a.repeat === 'once' ? <span className="tag none">once</span> : null}
                  {a.repeat === 'until' ? <span className="tag none">until it happens</span> : null}
                  {a.enabled ? null : <span className="tag none">paused</span>}
                  {a.offGrid ? <span className="tag none">off the tick</span> : null}
                </span>
                <span className="meta">
                  {!a.enabled ? 'will not run' : a.offGrid ? `due ${a.nextRun}, runs ${a.runsAt}` : `next ${a.nextRun}`}
                </span>
              </span>
              <span className="row-acts">
                <button disabled={busy} onClick={() => act({ action: 'pause_automation', id: a.id, enabled: !a.enabled })}>
                  {a.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  disabled={busy}
                  title="Delete this reminder"
                  onClick={() => confirm(`Delete "${a.label}" for good?`) && act({ action: 'delete_automation', id: a.id })}
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {scheduler ? (
        <p className="meta">Reminders fire when the scheduler ticks, {scheduler}. One set for a time between ticks waits for the next.</p>
      ) : null}
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}

type ListItem = { id: number; content: string; done: boolean }

export function FamilyLists({
  lists,
}: {
  lists: {
    id: number
    name: string
    open: number
    /** Every ticked item on the list; Home carries only the ten added last in items. */
    ticked: number
    items: ListItem[]
  }[]
}) {
  const { act, busy, error } = useFamilyActions()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newList, setNewList] = useState({ name: '', item: '' })
  // The lists opened out to their older ticked items, fetched whole by id.
  // Nothing records when an item was ticked, so one ticked just now can be
  // among the older ones, and this is the way back to it. It is a copy, so
  // every change made here fetches it again.
  const [whole, setWhole] = useState<Record<number, ListItem[]>>({})
  const [loadError, setLoadError] = useState<string | null>(null)

  async function fetchWhole(ids: number[]) {
    setLoadError(null)
    try {
      const got = await Promise.all(
        ids.map(async (id) => {
          const res = await fetch(`/api/family?list=${id}`)
          if (!res.ok) throw new Error((await res.json()).error ?? 'Could not load that list.')
          return [id, ((await res.json()) as { items: ListItem[] }).items] as const
        }),
      )
      setWhole((w) => ({ ...w, ...Object.fromEntries(got) }))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  function fold(id: number) {
    setWhole((w) => {
      const rest = { ...w }
      delete rest[id]
      return rest
    })
  }

  async function change(body: Record<string, unknown>) {
    const ok = await act(body)
    const opened = Object.keys(whole).map(Number)
    if (ok && opened.length > 0) await fetchWhole(opened)
    return ok
  }

  // Ticked items Home left out of this list, which only the whole list shows.
  const older = (l: { ticked: number; items: ListItem[] }) => l.ticked - l.items.filter((i) => i.done).length

  async function add(list: string, content: string) {
    if (!content.trim()) return
    if (await change({ action: 'add_item', list, content })) {
      setDrafts((d) => ({ ...d, [list]: '' }))
      setNewList({ name: '', item: '' })
    }
  }

  return (
    <div className="panel">
      {lists.length === 0 ? (
        <Empty>No lists yet. Ask your MCP client to &ldquo;add milk to the shopping list&rdquo;, or start one below.</Empty>
      ) : (
        lists.map((l) => (
          <div key={l.name} className="weblist">
            <p className="subhead">
              {l.name} · {l.open} open
            </p>
            <ul className="listing doable">
              {(whole[l.id] ?? l.items).map((i) => (
                <li key={i.id} className={i.done ? 'done' : ''}>
                  <button
                    className={`tick${i.done ? ' on' : ''}`}
                    disabled={busy}
                    aria-label={i.done ? `Untick ${i.content}` : `Tick off ${i.content}`}
                    onClick={() => change({ action: 'toggle_item', id: i.id, done: !i.done })}
                  >
                    {i.done ? '✓' : ''}
                  </button>
                  <span className="grow">
                    <span className="title">{i.content}</span>
                  </span>
                  <span className="row-acts">
                    <button disabled={busy} title="Remove item" onClick={() => change({ action: 'delete_item', id: i.id })}>
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {l.ticked > 0 ? (
              <p className="weblist-ticked">
                {whole[l.id] ? (
                  <button onClick={() => fold(l.id)}>Hide older ticked</button>
                ) : older(l) > 0 ? (
                  <button disabled={busy} title="Show every ticked item on this list" onClick={() => fetchWhole([l.id])}>
                    Show {older(l)} older ticked
                  </button>
                ) : (
                  <span />
                )}
                <button
                  disabled={busy}
                  title="Remove every ticked item from this list"
                  onClick={() =>
                    confirm(`Clear the ${l.ticked} ticked ${l.ticked === 1 ? 'item' : 'items'} from ${l.name}?`) &&
                    change({ action: 'clear_ticked', id: l.id })
                  }
                >
                  Clear ticked
                </button>
              </p>
            ) : null}
            <div className="additem">
              <input
                placeholder={`Add to ${l.name}…`}
                value={drafts[l.name] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [l.name]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && add(l.name, drafts[l.name] ?? '')}
              />
              <button disabled={busy || !(drafts[l.name] ?? '').trim()} onClick={() => add(l.name, drafts[l.name] ?? '')}>
                Add
              </button>
            </div>
          </div>
        ))
      )}
      <div className="additem newlist">
        <input
          placeholder="New list"
          value={newList.name}
          onChange={(e) => setNewList({ ...newList, name: e.target.value })}
        />
        <input
          placeholder="First item"
          value={newList.item}
          onChange={(e) => setNewList({ ...newList, item: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && add(newList.name.trim(), newList.item)}
        />
        <button
          disabled={busy || !newList.name.trim() || !newList.item.trim()}
          onClick={() => add(newList.name.trim(), newList.item)}
        >
          Start
        </button>
      </div>
      {error || loadError ? <p className="flash bad">{error ?? loadError}</p> : null}
    </div>
  )
}

/**
 * What the household keeps in mind, so everyone can see what Hearth has been
 * told and take back what is wrong or out of date. Forgetting here is the same
 * soft forget as the forget tool: the row stays as history, it just stops
 * being a Known fact.
 */
export function Remembered({
  memories,
  questions,
}: {
  memories: { id: number; fact: string; who: string | null; since: string }[]
  /** What nobody could stand behind yet, waiting on a yes. */
  questions: { id: number; question: string; candidate: string; since: string }[]
}) {
  const { act, busy, error } = useFamilyActions()
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const answerFor = (qn: { id: number; candidate: string }) => answers[qn.id] ?? qn.candidate

  return (
    <div className="panel">
      <p className="group-note">
        What Hearth keeps in mind for the household, filed when someone asked it to remember. When something could not be
        stood behind, it is asked below rather than guessed. Forgetting one here is the same as asking it to forget.
      </p>
      {questions.length > 0 ? (
        <>
          <p className="subhead">Not sure about</p>
          <ul className="listing doable">
            {questions.map((qn) => (
              <li key={qn.id}>
                <span className="grow">
                  <span className="title">{qn.question}</span>
                  <input
                    className="answer"
                    aria-label="The fact to keep if the answer is yes"
                    value={answerFor(qn)}
                    onChange={(e) => setAnswers((a) => ({ ...a, [qn.id]: e.target.value }))}
                  />
                </span>
                <span className="row-acts">
                  <button
                    className="primary"
                    disabled={busy || !answerFor(qn).trim()}
                    title="Keep this as a fact"
                    onClick={() => act({ action: 'answer_question', id: qn.id, fact: answerFor(qn).trim() })}
                  >
                    Yes
                  </button>
                  <button disabled={busy} title="Not a fact to keep" onClick={() => act({ action: 'answer_question', id: qn.id })}>
                    No
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {memories.length > 0 ? <p className="subhead">Known</p> : null}
        </>
      ) : null}
      {memories.length === 0 ? (
        <Empty>Nothing remembered yet. Ask your MCP client to &ldquo;remember that bin night is Monday&rdquo; and it lands here.</Empty>
      ) : (
        <ul className="listing doable">
          {memories.map((m) => (
            <li key={m.id}>
              <span className="grow">
                <span className="title">{m.fact}</span>
                <span className="meta">
                  {m.who ? `filed for ${m.who}` : 'filed by Hearth'} · {m.since}
                </span>
              </span>
              <span className="row-acts">
                <button
                  disabled={busy}
                  title="Forget this"
                  onClick={() => confirm(`Forget “${m.fact}”?`) && act({ action: 'forget_memory', id: m.id })}
                >
                  Forget
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}

/**
 * What was changed in the viewer's name lately, and how: their own record, so
 * nobody has to take anyone's word that something was done. Read-only; each
 * line is undone the way it was done, by asking or on the panel that holds it.
 */
export function Lately({
  activity,
}: {
  activity: { id: number; summary: string; how: string; when: string }[]
}) {
  return (
    <div className="panel">
      {activity.length === 0 ? (
        <Empty>Nothing changed yet. Whatever is added, ticked off, sent or scheduled in your name is listed here, with how.</Empty>
      ) : (
        <ul className="listing">
          {activity.map((a) => (
            <li key={a.id}>
              <span className="grow">
                <span className="title">{a.summary}</span>
                <span className="meta">
                  {a.when} · {a.how}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * What the viewer is working towards. Each goal's steps tick off here as they
 * do with update_goal, and Done or Drop closes it and ends its check-ins.
 */
export function Goals({
  goals,
}: {
  goals: {
    id: number
    title: string
    outcome: string | null
    target: string | null
    daysLeft: number | null
    done: number
    steps: ListItem[]
    latest: string | null
  }[]
}) {
  const { act, busy, error } = useFamilyActions()

  return (
    <div className="panel">
      {goals.map((g) => (
        <div key={g.id} className="weblist">
          <p className="subhead">
            {g.title} · {g.done} of {g.steps.length} steps
            {g.target ? ` · by ${g.target}${g.daysLeft !== null && g.daysLeft >= 0 ? `, ${g.daysLeft} days` : ', overdue'}` : ''}
          </p>
          {g.outcome ? <p className="meta">{g.outcome}</p> : null}
          {g.steps.length ? (
            <ul className="listing doable">
              {g.steps.map((i) => (
                <li key={i.id} className={i.done ? 'done' : ''}>
                  <button
                    className={`tick${i.done ? ' on' : ''}`}
                    disabled={busy}
                    aria-label={i.done ? `Untick ${i.content}` : `Tick off ${i.content}`}
                    onClick={() => act({ action: 'toggle_goal_step', id: i.id, done: !i.done })}
                  >
                    {i.done ? '✓' : ''}
                  </button>
                  <span className="grow">
                    <span className="title">{i.content}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {g.latest ? <p className="meta">Latest: {g.latest}</p> : null}
          <p className="weblist-ticked">
            <button className="primary" disabled={busy} title="Achieved: close it and end its check-ins" onClick={() => act({ action: 'close_goal', id: g.id, status: 'done' })}>
              Done
            </button>
            <button
              disabled={busy}
              title="No longer wanted: close it and end its check-ins"
              onClick={() => confirm(`Drop "${g.title}"?`) && act({ action: 'close_goal', id: g.id, status: 'dropped' })}
            >
              Drop
            </button>
          </p>
        </div>
      ))}
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}

/**
 * The signed-in member's own email drafts, waiting on their yes. Send here is
 * the same yes as send_email: the draft goes from their mailbox as written,
 * once, and Discard throws it away. Nobody else's drafts are shown, since
 * only the writer can send one.
 */
export function Drafts({
  drafts,
}: {
  drafts: { id: number; to: string; cc: string | null; subject: string; body: string; from: string; when: string }[]
}) {
  const { act, busy, error } = useFamilyActions()

  return (
    <div className="panel">
      <p className="group-note">Your email drafts. Nothing is sent until you say yes, here or to your MCP client.</p>
      <ul className="listing doable">
        {drafts.map((d) => (
          <li key={d.id}>
            <span className="grow">
              <span className="title">{d.subject}</span>
              <span className="meta">
                to {d.to}
                {d.cc ? `, copy to ${d.cc}` : ''} · from your {d.from} · drafted {d.when}
              </span>
              <span className="meta draft-body">{d.body}</span>
            </span>
            <span className="row-acts">
              <button
                className="primary"
                disabled={busy}
                title="Send it now, as written"
                onClick={() => confirm(`Send "${d.subject}" to ${d.to} now?`) && act({ action: 'send_draft', id: d.id })}
              >
                Send
              </button>
              <button disabled={busy} title="Throw this draft away" onClick={() => act({ action: 'discard_draft', id: d.id })}>
                Discard
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}

/**
 * The household's helpers, each handed jobs by name. New ones are made by
 * asking an MCP client, where a role is worked out with whoever asks; here
 * one can only be let go.
 */
export function Helpers({ helpers }: { helpers: { id: number; name: string; role: string }[] }) {
  const { act, busy, error } = useFamilyActions()

  return (
    <div className="panel">
      <p className="group-note">Hand one a job from your MCP client, like &ldquo;ask {helpers[0].name} to ...&rdquo;; what it finds is kept under Reports. Ask your client to add another.</p>
      <ul className="listing doable">
        {helpers.map((h) => (
          <li key={h.id}>
            <span className="grow">
              <span className="title">{h.name}</span>
              <span className="meta">{h.role}</span>
            </span>
            <span className="row-acts">
              <button disabled={busy} title={`Remove ${h.name}`} onClick={() => confirm(`Remove ${h.name}?`) && act({ action: 'remove_helper', id: h.id })}>
                ×
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}

/** How each report's state reads beside it. */
const REPORT_TAG: Record<'ready' | 'held' | 'problem', string | null> = {
  ready: null,
  held: 'held back',
  problem: 'problem',
}

/**
 * What the viewer's scheduled jobs found: reminders, watches, goal check-ins
 * and helpers' jobs, newest first. Nothing is posted anywhere, so this and
 * the viewer's MCP client are where a job's findings wait. A draft the checks
 * held back is shown marked, with why.
 */
export function Reports({
  reports,
}: {
  reports: { id: number; label: string; helper: string | null; status: 'ready' | 'held' | 'problem'; body: string; detail: string | null; when: string }[]
}) {
  return (
    <div className="panel">
      <p className="group-note">What your reminders, watches, check-ins and helpers found. Your MCP client reads the same with list_reports.</p>
      <ul className="listing">
        {reports.map((r) => (
          <li key={r.id}>
            <span className="grow">
              <span className="title">
                {r.label} {REPORT_TAG[r.status] ? <span className="tag none">{REPORT_TAG[r.status]}</span> : null}
              </span>
              <span className="meta">
                {r.when}
                {r.helper ? ` · by ${r.helper}` : ''}
              </span>
              <span className="meta draft-body">{r.body}</span>
              {r.detail ? <span className="meta">{r.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
