'use client'

import { useState } from 'react'

type Person = { name: string; email: string | null; isAdmin: boolean }
type LlmTier = 'gemini' | 'openrouter' | 'local'
type LlmState = Record<LlmTier, boolean>

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? 'That did not work.')
  return data
}

export function SetupWizard({
  members: initialMembers,
  llm: initialLlm,
  timezone: initialTz,
  language: initialLanguage,
  units: initialUnits,
  languageOptions,
}: {
  members: Person[]
  llm: LlmState
  timezone: string
  language: string
  units: string
  languageOptions: readonly string[]
}) {
  const [members, setMembers] = useState(initialMembers)
  const [llm, setLlm] = useState(initialLlm)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})

  const [person, setPerson] = useState({ name: '', email: '' })
  const [personAdmin, setPersonAdmin] = useState(initialMembers.length === 0)
  const [provider, setProvider] = useState<LlmTier | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [local, setLocal] = useState({ url: '', model: '', key: '' })
  const [tz, setTz] = useState(initialTz)
  const [lang, setLang] = useState(initialLanguage)
  const [unit, setUnit] = useState(initialUnits)

  async function step(name: string, work: () => Promise<void>, done?: string) {
    setBusy(name)
    setErrors((e) => ({ ...e, [name]: '' }))
    setNotes((n) => ({ ...n, [name]: '' }))
    try {
      await work()
      if (done) setNotes((n) => ({ ...n, [name]: done }))
    } catch (err) {
      setErrors((e) => ({ ...e, [name]: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(null)
    }
  }

  const addPerson = () =>
    step(
      'family',
      async () => {
        // Access is said outright: adding someone here is letting them in,
        // and the list above shows only those who are. An address already in
        // the family names that person, who keeps their admin.
        const data = await post('/api/admin/members', {
          name: person.name,
          email: person.email.trim(),
          allowed: true,
          isAdmin: personAdmin || undefined,
        })
        setMembers(
          (data.members as (Person & { allowed: boolean })[])
            .filter((m) => m.allowed)
            .map((m) => ({ name: m.name, email: m.email, isAdmin: m.isAdmin })),
        )
        setPerson({ name: '', email: '' })
        setPersonAdmin(false)
      },
      'Added.',
    )

  const saveApiKey = (which: 'gemini' | 'openrouter') =>
    step(
      'brain',
      async () => {
        await post('/api/admin/settings', {
          key: which === 'gemini' ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY',
          value: apiKey.trim(),
        })
        setApiKey('')
        setProvider(null)
        setLlm((l) => ({ ...l, [which]: true }))
      },
      'Saved.',
    )

  const saveLocal = () =>
    step(
      'brain',
      async () => {
        const url = local.url.trim().replace(/\/+$/, '')
        if (!/^https?:\/\//.test(url)) {
          throw new Error('The endpoint should be a URL, like http://192.168.1.20:11434/v1')
        }
        await post('/api/admin/settings', { key: 'LLM_BASE_URL', value: url })
        await post('/api/admin/settings', { key: 'LLM_MODEL', value: local.model.trim() })
        if (local.key.trim()) await post('/api/admin/settings', { key: 'LLM_API_KEY', value: local.key.trim() })
        setLocal({ url: '', model: '', key: '' })
        setProvider(null)
        setLlm((l) => ({ ...l, local: true }))
      },
      'Saved.',
    )

  const saveChoice = (key: 'LANGUAGE' | 'UNITS', value: string, apply: (v: string) => void) =>
    step(
      'clock',
      async () => {
        await post('/api/admin/settings', { key, value })
        apply(value)
      },
      'Saved.',
    )

  const saveTz = () =>
    step(
      'clock',
      async () => {
        try {
          new Intl.DateTimeFormat('en-AU', { timeZone: tz.trim() })
        } catch {
          throw new Error(`"${tz.trim()}" is not a timezone name. Try the Area/City form, like Australia/Melbourne.`)
        }
        await post('/api/admin/settings', { key: 'TIMEZONE', value: tz.trim() })
      },
      'Saved.',
    )

  const familyDone = members.length > 0
  const llmReady = llm.gemini || llm.openrouter || llm.local
  const ready = familyDone

  const keyForm = (which: 'gemini' | 'openrouter', placeholder: string) => (
    <div className="wizard-row">
      <input
        autoFocus
        type="password"
        placeholder={placeholder}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && apiKey.trim() && saveApiKey(which)}
      />
      <button className="primary" disabled={busy === 'brain' || !apiKey.trim()} onClick={() => saveApiKey(which)}>
        Save key
      </button>
      <button onClick={() => setProvider(null)}>Cancel</button>
    </div>
  )

  const providerRow = (which: LlmTier, name: string, help: React.ReactNode, form: React.ReactNode) => (
    <div className="setting">
      <div>
        <span className="name">
          <i className={`stepdot${llm[which] ? ' on' : ''}`} />
          {name}
        </span>
        <span className="help">{help}</span>
      </div>
      <div className="right">
        {llm[which] ? (
          <span className="val">configured</span>
        ) : provider === which ? null : (
          <button
            onClick={() => {
              setProvider(which)
              setApiKey('')
            }}
          >
            Set up
          </button>
        )}
      </div>
      {provider === which && !llm[which] ? <div className="full">{form}</div> : null}
    </div>
  )

  const flash = (name: string) =>
    errors[name] ? (
      <p className="flash bad">{errors[name]}</p>
    ) : notes[name] ? (
      <p className="flash">{notes[name]}</p>
    ) : null

  return (
    <div className="wizard">
      <h1>Light the fire</h1>
      <p className="lede">
        A fresh deployment needs its family before anyone can use it; the rest is optional. Everything saves as you
        go, so it is safe to leave and come back.
      </p>

      <section>
        <h2>
          <i className={`stepdot${familyDone ? ' on' : ''}`} />1 · The family
        </h2>
        <div className="panel">
          <p className="empty">
            Hearth acts for recognised people only, each signing in here with their Google or Microsoft account. Add
            yourself first, then everyone else, by the address they sign in with. Admins can add more later from
            Settings.
          </p>
          {members.length > 0 ? (
            <ul className="listing" style={{ marginTop: '0.5rem' }}>
              {members.map((m) => (
                <li key={`${m.name}-${m.email ?? ''}`}>
                  <span className="title">
                    {m.name} {m.isAdmin ? <span className="tag admin">admin</span> : null}
                  </span>
                  <span className="meta mono">{m.email ?? 'no address yet'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="wizard-row">
            <input
              placeholder="Name"
              value={person.name}
              onChange={(e) => setPerson({ ...person, name: e.target.value })}
            />
            <input
              placeholder="Email they sign in with"
              type="email"
              value={person.email}
              onChange={(e) => setPerson({ ...person, email: e.target.value })}
            />
            <label>
              <input type="checkbox" checked={personAdmin} onChange={(e) => setPersonAdmin(e.target.checked)} />
              admin
            </label>
            <button
              className="primary"
              disabled={busy === 'family' || !person.name.trim() || !person.email.trim()}
              onClick={addPerson}
            >
              Add
            </button>
          </div>
          {flash('family')}
        </div>
      </section>

      <section>
        <h2>
          <i className={`stepdot${llmReady ? ' on' : ''}`} />2 · A model for scheduled jobs
        </h2>
        <div className="panel">
          <p className="empty">
            Optional. Your MCP client is the brain for everything you ask; Hearth needs a model of its own only for
            what runs while nobody is asking: reminders, watches, goal check-ins and jobs handed to helpers. <b>One
            provider is enough</b>, and anything extra becomes a fallback, in an order managed from{' '}
            <a href="/settings">Settings</a>.
          </p>
          {providerRow(
            'gemini',
            'Google Gemini',
            <>
              Generous free tier, the quickest start.{' '}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                Get a key at Google AI Studio →
              </a>
            </>,
            keyForm('gemini', 'Gemini API key'),
          )}
          {providerRow(
            'openrouter',
            'OpenRouter',
            <>
              One key, hundreds of models, free ones included.{' '}
              <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
                Get a key at openrouter.ai/keys →
              </a>
            </>,
            keyForm('openrouter', 'OpenRouter API key'),
          )}
          {providerRow(
            'local',
            'Self-hosted LLM',
            <>Ollama, vLLM, LM Studio, llama.cpp — any OpenAI-compatible server. Nothing leaves the house.</>,
            <>
              <div className="wizard-row">
                <input
                  autoFocus
                  placeholder="Endpoint, e.g. http://192.168.1.20:11434/v1"
                  value={local.url}
                  onChange={(e) => setLocal({ ...local, url: e.target.value })}
                />
                <input
                  placeholder="Models, comma separated — must support tool calling"
                  value={local.model}
                  onChange={(e) => setLocal({ ...local, model: e.target.value })}
                />
              </div>
              <div className="wizard-row">
                <input
                  type="password"
                  placeholder="API key (only if your server checks one)"
                  value={local.key}
                  onChange={(e) => setLocal({ ...local, key: e.target.value })}
                />
                <button
                  className="primary"
                  disabled={busy === 'brain' || !local.url.trim() || !local.model.trim()}
                  onClick={saveLocal}
                >
                  Save
                </button>
                <button onClick={() => setProvider(null)}>Cancel</button>
              </div>
            </>,
          )}
          {flash('brain')}
        </div>
      </section>

      <section>
        <h2>
          <i className="stepdot on" />3 · The household clock and voice
        </h2>
        <div className="panel">
          <p className="empty">
            Reminders and calendar entries mean this time wherever anyone happens to be reading, and scheduled
            reports are written in this language with these units.
          </p>
          <div className="wizard-row">
            <input value={tz} onChange={(e) => setTz(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveTz()} />
            <button disabled={busy === 'clock' || tz.trim() === ''} onClick={saveTz}>
              Save timezone
            </button>
          </div>
          <div className="wizard-row">
            <select
              className="picker-add inline"
              aria-label="Language"
              disabled={busy === 'clock'}
              value={lang}
              onChange={(e) => saveChoice('LANGUAGE', e.target.value, setLang)}
            >
              {(languageOptions.includes(lang) ? languageOptions : [lang, ...languageOptions]).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <select
              className="picker-add inline"
              aria-label="Units"
              disabled={busy === 'clock'}
              value={unit}
              onChange={(e) => saveChoice('UNITS', e.target.value, setUnit)}
            >
              <option value="metric">metric</option>
              <option value="imperial">imperial</option>
            </select>
          </div>
          {flash('clock')}
        </div>
      </section>

      <section>
        <h2>
          <i className={`stepdot${ready ? ' on' : ''}`} />Then
        </h2>
        <div className="panel">
          <ul className="listing">
            <li>
              <span className="title">Connect an MCP client</span>
              <span className="meta">
                Each member signs in here, makes a key under Claude and other MCP clients on Home, and adds it to their
                client with the one line shown there. Clients that speak OAuth can sign in from the client instead.
              </span>
            </li>
            <li>
              <span className="title">Reminders on a schedule</span>
              <span className="meta">
                Optional: paste both QStash signing keys into Settings under Scheduler, and point an hourly
                QStash schedule at /api/tick. Everything else works without it.
              </span>
            </li>
            <li>
              <span className="title">Money, Notion, Jira, web search</span>
              <span className="meta">All optional, all in Settings, all live without a redeploy.</span>
            </li>
          </ul>
          <div className="wizard-row">
            <a className="btn" href="/" style={{ marginBottom: 0, flex: 1 }}>
              <span>{ready ? 'Done — go to the house' : 'Skip for now — go to the house'}</span>
              <span aria-hidden>→</span>
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
