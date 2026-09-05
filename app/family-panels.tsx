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
}: {
  automations: { id: number; label: string; enabled: boolean; nextRun: string | null }[]
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
                  {a.label} {a.enabled ? null : <span className="tag none">paused</span>}
                </span>
                <span className="meta">{a.enabled ? `next ${a.nextRun}` : 'will not run'}</span>
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
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}

export function FamilyLists({
  lists,
}: {
  lists: { name: string; open: number; items: { id: number; content: string; done: boolean }[] }[]
}) {
  const { act, busy, error } = useFamilyActions()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newList, setNewList] = useState({ name: '', item: '' })

  async function add(list: string, content: string) {
    if (!content.trim()) return
    if (await act({ action: 'add_item', list, content })) {
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
              {l.items.map((i) => (
                <li key={i.id} className={i.done ? 'done' : ''}>
                  <button
                    className={`tick${i.done ? ' on' : ''}`}
                    disabled={busy}
                    aria-label={i.done ? `Untick ${i.content}` : `Tick off ${i.content}`}
                    onClick={() => act({ action: 'toggle_item', id: i.id, done: !i.done })}
                  >
                    {i.done ? '✓' : ''}
                  </button>
                  <span className="grow">
                    <span className="title">{i.content}</span>
                  </span>
                  <span className="row-acts">
                    <button disabled={busy} title="Remove item" onClick={() => act({ action: 'delete_item', id: i.id })}>
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
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
      {error ? <p className="flash bad">{error}</p> : null}
    </div>
  )
}
