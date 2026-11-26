'use client'

import { useState } from 'react'
import type { MemberRow } from '@/lib/db/queries'

const BLANK = { name: '', email: '', isAdmin: false }

export function MembersForm({ initial }: { initial: MemberRow[] }) {
  const [members, setMembers] = useState(initial)
  const [draft, setDraft] = useState(BLANK)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [emailFor, setEmailFor] = useState<number | null>(null)
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

  // Only what was filled in: for an address already here, an unticked admin
  // box leaves theirs as it is, so this row can fix a name.
  async function add() {
    const known = members.some((m) => (m.email ?? '').toLowerCase() === draft.email.trim().toLowerCase())
    const body = {
      name: draft.name,
      email: draft.email.trim(),
      isAdmin: draft.isAdmin || undefined,
    }
    if (await send('POST', body)) {
      setNote(known ? `Updated ${draft.name}.` : `Added ${draft.name}.`)
      setDraft(BLANK)
    }
  }

  const toggle = (m: MemberRow, field: 'allowed' | 'isAdmin') =>
    send('POST', {
      id: m.id,
      name: m.name,
      allowed: field === 'allowed' ? !m.allowed : m.allowed,
      isAdmin: field === 'isAdmin' ? !m.isAdmin : m.isAdmin,
    })

  async function saveEmail(m: MemberRow) {
    const ok = await send('POST', {
      id: m.id,
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
        <div className="person" key={m.id}>
          <div>
            <span className="who">
              {m.name}
              {m.isAdmin ? <span className="tag admin">admin</span> : null}
              {!m.allowed ? <span className="tag none">no access</span> : null}
            </span>
            {emailFor === m.id ? (
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
                {m.email ? <span className="mono">{m.email}</span> : 'no address'}
                {m.linked.length ? ` · ${m.linked.map((l) => l.provider).join(' and ')} linked` : ''}
              </span>
            )}
          </div>
          <div className="acts">
            <button
              disabled={busy}
              onClick={() => {
                setEmailFor(m.id)
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
              onClick={() =>
                confirm(`Remove ${m.name} from the family?`) && send('DELETE', undefined, `?id=${m.id}`)
              }
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      <div className="newperson">
        <input
          placeholder="Name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <input
          placeholder="Email they sign in with"
          type="email"
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
        <button className="primary" disabled={busy || !draft.email.trim() || !draft.name.trim()} onClick={add}>
          Add
        </button>
      </div>

      <p className="empty" style={{ marginTop: '0.8rem' }}>
        The email is how someone signs in here, with Google or Microsoft; once they have linked a
        calendar they can sign in with that address too. Signed in, they link their accounts and make
        keys for their MCP clients. Adding an address that is already here renames that person and
        changes only what you filled in; someone with no access keeps none until you Allow them.
      </p>
      </div>
    </section>
  )
}
