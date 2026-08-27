'use client'

import { useState } from 'react'
import type { MemberRow } from '@/lib/db/queries'

const BLANK = { telegramUserId: '', name: '', email: '', allowed: true, isAdmin: false }

export function MembersForm({ initial }: { initial: MemberRow[] }) {
  const [members, setMembers] = useState(initial)
  const [draft, setDraft] = useState(BLANK)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [emailFor, setEmailFor] = useState<string | null>(null)
  const [emailDraft, setEmailDraft] = useState('')

  async function send(method: 'POST' | 'DELETE', body?: unknown, query = '') {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch(`/api/admin/members${query}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Could not save')
      setMembers(data.members)
      return true
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function add() {
    if (await send('POST', draft)) {
      setNote(`Added ${draft.name}.`)
      setDraft(BLANK)
    }
  }

  const toggle = (m: MemberRow, field: 'allowed' | 'isAdmin') =>
    send('POST', {
      telegramUserId: m.telegramUserId,
      name: m.name,
      email: m.email ?? '',
      allowed: field === 'allowed' ? !m.allowed : m.allowed,
      isAdmin: field === 'isAdmin' ? !m.isAdmin : m.isAdmin,
    })

  async function saveEmail(m: MemberRow) {
    const ok = await send('POST', {
      telegramUserId: m.telegramUserId,
      name: m.name,
      email: emailDraft.trim(),
      allowed: m.allowed,
      isAdmin: m.isAdmin,
    })
    if (ok) {
      setNote(emailDraft.trim() ? `${m.name} can sign in as ${emailDraft.trim().toLowerCase()}.` : `Cleared ${m.name}'s email.`)
      setEmailFor(null)
      setEmailDraft('')
    }
  }

  // The last admin standing can only be succeeded, never removed; the server
  // refuses too, this just spares the round trip.
  const lastAdmin = (m: MemberRow) =>
    m.allowed && m.isAdmin && members.filter((x) => x.allowed && x.isAdmin).length === 1

  return (
    <section>
      <h2>Family</h2>
      <div className="panel">
      {note ? <p className="flash">{note}</p> : null}

      {members.map((m) => (
        <div className="person" key={m.telegramUserId}>
          <div>
            <span className="who">
              {m.name}
              {m.isAdmin ? <span className="tag admin">admin</span> : null}
              {!m.allowed ? <span className="tag none">no access</span> : null}
            </span>
            {emailFor === m.telegramUserId ? (
              <span className="detail-edit">
                <input
                  autoFocus
                  placeholder="email@example.com (empty clears it)"
                  value={emailDraft}
                  onChange={(e) => setEmailDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveEmail(m)
                    if (e.key === 'Escape') setEmailFor(null)
                  }}
                />
                <button className="primary" disabled={busy} onClick={() => saveEmail(m)}>
                  Save
                </button>
                <button disabled={busy} onClick={() => setEmailFor(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <span className="detail">
                <span className="mono">{m.telegramUserId}</span>
                {m.email ? ` · ${m.email}` : ''}
                {m.linked.length ? ` · ${m.linked.map((l) => l.provider).join(' and ')} linked` : ''}
              </span>
            )}
          </div>
          <div className="acts">
            <button
              disabled={busy}
              onClick={() => {
                setEmailFor(m.telegramUserId)
                setEmailDraft(m.email ?? '')
              }}
            >
              {m.email ? 'Change email' : 'Add email'}
            </button>
            <button
              disabled={busy || lastAdmin(m)}
              title={lastAdmin(m) ? 'The only admin cannot be revoked. Make someone else an admin first.' : undefined}
              onClick={() => toggle(m, 'allowed')}
            >
              {m.allowed ? 'Revoke' : 'Allow'}
            </button>
            <button
              disabled={busy || !m.allowed || lastAdmin(m)}
              title={lastAdmin(m) ? 'The only admin cannot step down. Make someone else an admin first.' : undefined}
              onClick={() => toggle(m, 'isAdmin')}
            >
              {m.isAdmin ? 'Remove admin' : 'Make admin'}
            </button>
            <button
              disabled={busy || lastAdmin(m)}
              title={lastAdmin(m) ? 'The only admin cannot be removed. Make someone else an admin first.' : undefined}
              onClick={() => send('DELETE', undefined, `?telegramUserId=${m.telegramUserId}`)}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      <div className="newperson">
        <input
          placeholder="Telegram id"
          value={draft.telegramUserId}
          onChange={(e) => setDraft({ ...draft, telegramUserId: e.target.value.replace(/[^0-9]/g, '') })}
        />
        <input
          placeholder="Name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <input
          placeholder="Email (optional)"
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
        />
        <label>
          <input
            type="checkbox"
            checked={draft.isAdmin}
            onChange={(e) => setDraft({ ...draft, isAdmin: e.target.checked })}
          />{' '}
          admin
        </label>
        <button className="primary" disabled={busy || !draft.telegramUserId || !draft.name} onClick={add}>
          Add
        </button>
      </div>

      <p className="empty" style={{ marginTop: '0.8rem' }}>
        The Telegram id lets someone talk to the bot; they can find theirs by sending it{' '}
        <span className="mono">/whoami</span>. The email lets them sign in here, and is optional:
        anyone who has linked a mailbox can already sign in with that address.
      </p>
      </div>
    </section>
  )
}
