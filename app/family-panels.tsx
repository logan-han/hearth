'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Empty } from './ui'

/**
 * The Home panels, able to act as well as show: everything here is something
 * any member could already do by asking the bot, so the buttons are just the
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
 * Events the bot found in an email or a photo and will not add on its own.
 * Saying yes here is the same yes as in the chat, one click closer, and it
 * says where each one came from so nobody has to go and find the message.
 */
export function Proposals({
  proposals,
}: {
  proposals: { id: number; title: string; when: string; chat: string; detail: string }[]
}) {
  const { act, busy, error } = useFamilyActions()

  return (
    <div className="panel">
      <p className="group-note">
        The bot spotted these in mail or a photo. Nothing here reaches the family calendar until someone says yes.
      </p>
      <ul className="listing doable">
        {proposals.map((p) => (
          <li key={p.id}>
            <span className="grow">
              <span className="title">{p.title}</span>
              <span className="meta">
                {p.when} · proposed in {p.chat}
              </span>
              {p.detail ? <span className="meta">{p.detail}</span> : null}
            </span>
            <span className="row-acts">
              <button className="primary" disabled={busy} title="Add to the family calendar" onClick={() => act({ action: 'accept_proposal', id: p.id })}>
                Add
              </button>
              <button disabled={busy} title="Not this one" onClick={() => act({ action: 'reject_proposal', id: p.id })}>
                No
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}

export function NextUp({ events }: { events: { id: number; title: string; when: string }[] }) {
  const { act, busy, error } = useFamilyActions()

  return (
    <div className="panel">
      {events.length === 0 ? (
        <Empty>Nothing coming up. Tell the bot about an event and it lands here.</Empty>
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
    /** Part of the product: it can be paused, but the tick would only put a deleted one back. */
    builtin: boolean
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
        <Empty>None scheduled. Ask the bot in the chat, or send /watch, to set one up.</Empty>
      ) : (
        <ul className="listing doable">
          {automations.map((a) => (
            <li key={a.id}>
              <span className="grow">
                <span className="title">
                  {a.label} {a.builtin ? <span className="tag none">built in</span> : null}
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
                {a.builtin ? null : (
                  <button
                    disabled={busy}
                    title="Delete this reminder"
                    onClick={() => confirm(`Delete "${a.label}" for good?`) && act({ action: 'delete_automation', id: a.id })}
                  >
                    ×
                  </button>
                )}
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
        <Empty>No lists yet. Say &ldquo;add milk to the shopping list&rdquo; in the chat, or start one below.</Empty>
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
 * What the bot keeps in mind between conversations, so the household can
 * see what it has been told and take back what is wrong or out of date.
 * Forgetting here is the same soft forget as in the chat: the row stays as
 * history, it just stops being a Known fact.
 */
export function Remembered({
  memories,
  questions,
}: {
  memories: { id: number; fact: string; who: string | null; since: string }[]
  /** What the nightly pass would have filed but could not stand behind, waiting on a yes. */
  questions: { id: number; question: string; candidate: string; since: string }[]
}) {
  const { act, busy, error } = useFamilyActions()
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const answerFor = (qn: { id: number; candidate: string }) => answers[qn.id] ?? qn.candidate

  return (
    <div className="panel">
      <p className="group-note">
        What the bot keeps in mind between conversations, filed from the chat or by its nightly pass over the day&rsquo;s talk.
        When it was not sure, it asks below rather than guessing. Forgetting one here is the same as telling it to forget in the chat.
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
        <Empty>Nothing remembered yet. Say &ldquo;remember that bin night is Monday&rdquo; in the chat and it lands here.</Empty>
      ) : (
        <ul className="listing doable">
          {memories.map((m) => (
            <li key={m.id}>
              <span className="grow">
                <span className="title">{m.fact}</span>
                <span className="meta">
                  {m.who ? `filed for ${m.who}` : 'filed by the bot'} · {m.since}
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
