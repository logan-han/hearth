'use client'

import { useState } from 'react'
import type { TelegramStatus } from '@/lib/telegram-admin'

type Person = { name: string; telegramUserId: string; isAdmin: boolean }
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
  status: initialStatus,
  members: initialMembers,
  seeded,
  llm: initialLlm,
  timezone: initialTz,
  language: initialLanguage,
  units: initialUnits,
  languageOptions,
}: {
  status: TelegramStatus
  members: Person[]
  seeded: string[]
  llm: LlmState
  timezone: string
  language: string
  units: string
  languageOptions: readonly string[]
}) {
  const [status, setStatus] = useState(initialStatus)
  const [members, setMembers] = useState(initialMembers)
  const [llm, setLlm] = useState(initialLlm)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})

  const [token, setToken] = useState('')
  const [changingToken, setChangingToken] = useState(false)
  const [person, setPerson] = useState({ name: '', telegramUserId: '', email: '' })
  const [personAdmin, setPersonAdmin] = useState(initialMembers.length === 0 && seeded.length === 0)
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

  const saveToken = () =>
    step('bot', async () => {
      setStatus((await post('/api/admin/telegram', { token: token.trim() })) as TelegramStatus)
      setToken('')
      setChangingToken(false)
    })

  const connect = () =>
    step('hook', async () => {
      setStatus((await post('/api/admin/telegram', { register: true })) as TelegramStatus)
    })

  const addPerson = () =>
    step(
      'family',
      async () => {
        const data = await post('/api/admin/members', {
          telegramUserId: person.telegramUserId,
          name: person.name,
          email: person.email,
          isAdmin: personAdmin,
        })
        setMembers(
          (data.members as (Person & { allowed: boolean })[])
            .filter((m) => m.allowed)
            .map((m) => ({ name: m.name, telegramUserId: m.telegramUserId, isAdmin: m.isAdmin })),
        )
        setPerson({ name: '', telegramUserId: '', email: '' })
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

  const botDone = status.ok
  const hookDone = status.connected
  const familyDone = members.length > 0 || seeded.length > 0
  const llmReady = llm.gemini || llm.openrouter || llm.local
  const ready = botDone && hookDone && familyDone && llmReady

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
        Four things stand between a fresh deployment and a working household bot. They save as you go, so
        it is safe to leave and come back.
      </p>

      <section>
        <h2>
          <i className={`stepdot${botDone ? ' on' : ''}`} />1 · The bot
        </h2>
        <div className="panel">
          {botDone && !changingToken ? (
            <div className="wizard-done">
              <p className="empty">
                Talking to Telegram as <b className="mono">@{status.username}</b>.
              </p>
              <button onClick={() => setChangingToken(true)}>Change token</button>
            </div>
          ) : (
            <>
              <p className="empty">
                Message{' '}
                <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                  @BotFather
                </a>{' '}
                in Telegram, send <span className="mono">/newbot</span>, pick a name, and paste the token it
                prints. The token is checked with Telegram before it is kept.
              </p>
              {status.configured && !status.ok ? (
                <p className="empty warn">The stored token is being rejected: {status.error ?? 'unknown error'}</p>
              ) : null}
              <div className="wizard-row">
                <input
                  type="password"
                  placeholder="123456:ABC-…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveToken()}
                />
                <button className="primary" disabled={busy === 'bot' || !token.trim()} onClick={saveToken}>
                  Save token
                </button>
                {changingToken ? <button onClick={() => setChangingToken(false)}>Cancel</button> : null}
              </div>
            </>
          )}
          {flash('bot')}
        </div>
      </section>

      <section>
        <h2>
          <i className={`stepdot${hookDone ? ' on' : ''}`} />2 · The webhook
        </h2>
        <div className="panel">
          <p className="empty">
            Telegram has to be told where this deployment lives before any message arrives. One click:
            Hearth mints a webhook secret if there is none and registers{' '}
            <span className="mono">{status.expectedUrl}</span> with Telegram.
          </p>
          {hookDone ? (
            <p className="empty" style={{ marginTop: '0.5rem' }}>
              Connected{status.webhook && status.webhook.pending > 0 ? `, ${status.webhook.pending} updates pending` : ''}.
            </p>
          ) : status.webhook?.url ? (
            <p className="empty warn" style={{ marginTop: '0.5rem' }}>
              The webhook currently points at {status.webhook.url}.
            </p>
          ) : null}
          {status.webhook?.lastError ? (
            <p className="empty warn" style={{ marginTop: '0.5rem' }}>
              Telegram&rsquo;s last delivery error: {status.webhook.lastError}
            </p>
          ) : null}
          <div className="wizard-row">
            <button className="primary" disabled={busy === 'hook' || !botDone} onClick={connect}>
              {hookDone ? 'Reconnect webhook' : 'Connect webhook'}
            </button>
          </div>
          {flash('hook')}
        </div>
      </section>

      <section>
        <h2>
          <i className={`stepdot${familyDone ? ' on' : ''}`} />3 · The family
        </h2>
        <div className="panel">
          <p className="empty">
            The bot answers recognised people only. Everyone&rsquo;s Telegram id is easy to get: DM the bot{' '}
            <span className="mono">/start</span> and it replies with the sender&rsquo;s id, even before they are
            added. Admins can grant everyone else later with /allow or from Settings.
          </p>
          {members.length > 0 || seeded.length > 0 ? (
            <ul className="listing" style={{ marginTop: '0.5rem' }}>
              {members.map((m) => (
                <li key={m.telegramUserId}>
                  <span className="title">
                    {m.name} {m.isAdmin ? <span className="tag admin">admin</span> : null}
                  </span>
                  <span className="meta mono">{m.telegramUserId}</span>
                </li>
              ))}
              {seeded
                .filter((id) => !members.some((m) => m.telegramUserId === id))
                .map((id) => (
                  <li key={id}>
                    <span className="title">
                      Founding member <span className="tag admin">admin</span>
                    </span>
                    <span className="meta mono">{id} · from ALLOWED_TELEGRAM_IDS, joins on first message</span>
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
              placeholder="Telegram id"
              inputMode="numeric"
              value={person.telegramUserId}
              onChange={(e) => setPerson({ ...person, telegramUserId: e.target.value })}
            />
            <input
              placeholder="Email (optional, lets them sign in here)"
              value={person.email}
              onChange={(e) => setPerson({ ...person, email: e.target.value })}
            />
            <label>
              <input type="checkbox" checked={personAdmin} onChange={(e) => setPersonAdmin(e.target.checked)} />
              admin
            </label>
            <button
              className="primary"
              disabled={busy === 'family' || !person.name.trim() || !person.telegramUserId.trim()}
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
          <i className={`stepdot${llmReady ? ' on' : ''}`} />4 · The brain
        </h2>
        <div className="panel">
          <p className="empty">
            Answers need a model, and <b>one provider is enough</b>. Set up whichever suits; anything extra
            becomes a fallback, in an order managed from <a href="/settings">Settings</a>.
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
          <i className="stepdot on" />5 · The household clock and voice
        </h2>
        <div className="panel">
          <p className="empty">
            Reminders and calendar entries mean this time wherever anyone happens to be reading, and replies
            come in this language with these units.
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
              <span className="title">Let the bot hear the group</span>
              <span className="meta">
                In BotFather: /setprivacy → Disable. Without it the bot only sees @mentions and replies.
              </span>
            </li>
            <li>
              <span className="title">Reminders on a schedule</span>
              <span className="meta">
                Optional: paste both QStash signing keys into Settings under Scheduler, and point a QStash
                schedule at /api/tick every five minutes. Everything else works without it.
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
