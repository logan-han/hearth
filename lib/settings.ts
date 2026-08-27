import { eq } from 'drizzle-orm'
import { db } from './db'
import { secrets } from './db/schema'
import { encrypt, decrypt } from './crypto'

/**
 * Settings an admin may change from the dashboard. Anything not on this list
 * cannot be written, so a compromised session cannot repoint DATABASE_URL or
 * rewrite TOKEN_ENC_KEY, which is what decrypts everything else here.
 */
export const MANAGED_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'ALLOWED_TELEGRAM_IDS',
  'LLM_ORDER',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'TAVILY_API_KEY',
  'OPENWEATHER_API_KEY',
  'UP_API_TOKEN',
  'POCKETSMITH_DEVELOPER_KEY',
  'NOTION_TOKEN',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  'TICK_SECRET',
  'AMBIENT_MODE',
  'TIMEZONE',
  'LANGUAGE',
  'UNITS',
] as const

export type ManagedKey = (typeof MANAGED_KEYS)[number]

/**
 * Which settings are credentials, and so are never rendered back to the
 * browser. Declared rather than inferred from the name: JIRA_PROJECT_KEY is a
 * board code like HTL, and a name-matching rule hid it behind dots.
 */
const CREDENTIALS = new Set<string>([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'LLM_API_KEY',
  'TAVILY_API_KEY',
  'OPENWEATHER_API_KEY',
  'UP_API_TOKEN',
  'POCKETSMITH_DEVELOPER_KEY',
  'NOTION_TOKEN',
  'JIRA_API_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  'TICK_SECRET',
])

export function isManaged(key: string): key is ManagedKey {
  return (MANAGED_KEYS as readonly string[]).includes(key)
}

export function isSecretShaped(key: string): boolean {
  return CREDENTIALS.has(key)
}

let hydrated: { at: number; done: Promise<void> } | null = null

/** How long one instance may trust its copy before re-reading the store. */
const HYDRATE_TTL_MS = 60_000

/**
 * Copy stored overrides into process.env, so every existing `process.env.X`
 * read picks them up without threading an async accessor through the whole
 * codebase. Stored values win over the deployment's env: an admin changing a
 * key in the dashboard is the more recent intent.
 *
 * Memoised with a short TTL rather than per cold start: under Fluid compute a
 * warm instance can live for hours, and a memo-forever meant a key changed in
 * the dashboard kept failing in instances that had already hydrated.
 */
export function hydrateSecrets(): Promise<void> {
  if (!hydrated || Date.now() - hydrated.at > HYDRATE_TTL_MS) {
    const done = (async () => {
      try {
        const rows = await db().select().from(secrets)
        for (const row of rows) {
          if (!isManaged(row.key)) continue
          try {
            process.env[row.key] = await decrypt(row.value)
          } catch (err) {
            console.error(`[settings] could not decrypt ${row.key}:`, err)
          }
        }
      } catch (err) {
        // A missing table or an unreachable database must not take the bot
        // down; the deployment's own env vars still apply.
        console.error('[settings] hydrate failed, using env only:', err)
      }
    })()
    hydrated = { at: Date.now(), done }
  }
  return hydrated.done
}

/** Test seam, and used after a write so the next read sees the new value. */
export function resetHydration(): void {
  hydrated = null
}

export async function setSecret(key: ManagedKey, value: string, updatedBy: string): Promise<void> {
  const encrypted = await encrypt(value)
  await db()
    .insert(secrets)
    .values({ key, value: encrypted, updatedBy })
    .onConflictDoUpdate({ target: secrets.key, set: { value: encrypted, updatedAt: new Date(), updatedBy } })
  process.env[key] = value
}

export async function clearSecret(key: ManagedKey): Promise<void> {
  await db().delete(secrets).where(eq(secrets.key, key))
  delete process.env[key]
  // The deployment's own env var, if any, is only visible again next cold start.
  resetHydration()
}

/**
 * How the dashboard presents each setting: what to call it in plain words,
 * which service it belongs to, and where to go to get one. Keyed by env var
 * because that is what the deployment actually reads.
 */
export const SETTING_META: Record<
  ManagedKey,
  {
    group: string
    label: string
    help?: string
    link?: { href: string; text: string }
    /** Renders as an on/off switch instead of a text field. Values are 'on'/'off'. */
    toggle?: boolean
    /** Renders as a dropdown of these values instead of a text field. */
    options?: readonly string[]
  }
> = {
  TELEGRAM_BOT_TOKEN: {
    group: 'Telegram', label: 'Bot token',
    help: 'After changing it, reconnect the webhook below so Telegram delivers to the new bot.',
    link: { href: 'https://t.me/BotFather', text: '@BotFather' },
  },
  TELEGRAM_WEBHOOK_SECRET: {
    group: 'Telegram', label: 'Webhook secret',
    help: 'Telegram echoes this on every delivery, and the webhook route refuses anything without it. Reconnecting the webhook generates one when empty.',
  },
  ALLOWED_TELEGRAM_IDS: {
    group: 'Telegram', label: 'Founding members',
    help: 'Comma separated Telegram user ids, made admins on sight. Optional once someone is in the family list; they cannot be revoked while listed here.',
  },
  LLM_ORDER: { group: 'Google Gemini', label: 'Provider order', help: 'Which provider answers first, then who covers for it.' },
  GEMINI_API_KEY: {
    group: 'Google Gemini', label: 'API key',
    link: { href: 'https://aistudio.google.com/apikey', text: 'Google AI Studio' },
  },
  GEMINI_MODEL: { group: 'Google Gemini', label: 'Models', help: 'Tried top to bottom.' },
  OPENROUTER_API_KEY: {
    group: 'OpenRouter', label: 'API key',
    link: { href: 'https://openrouter.ai/keys', text: 'openrouter.ai/keys' },
  },
  OPENROUTER_MODEL: {
    group: 'OpenRouter', label: 'Models',
    help: 'Put :free models before paid ones, so the paid slot only answers when everything free has failed.',
  },
  LLM_BASE_URL: {
    group: 'Self-hosted LLM', label: 'Endpoint',
    help: 'Any OpenAI-compatible server you run yourself: Ollama, vLLM, LM Studio, llama.cpp. Nothing leaves the house when this one answers.',
  },
  LLM_API_KEY: { group: 'Self-hosted LLM', label: 'API key', help: 'Leave empty if your server does not check one.' },
  LLM_MODEL: { group: 'Self-hosted LLM', label: 'Models', help: 'Must support tool calling.' },
  TAVILY_API_KEY: {
    group: 'Web search', label: 'Tavily key',
    link: { href: 'https://app.tavily.com', text: 'app.tavily.com' },
  },
  OPENWEATHER_API_KEY: {
    group: 'Weather', label: 'OpenWeatherMap key',
    help: 'Powers weather questions and the morning brief. The free tier is plenty.',
    link: { href: 'https://home.openweathermap.org/api_keys', text: 'openweathermap.org' },
  },
  UP_API_TOKEN: {
    group: 'Money', label: 'Up Bank token',
    help: 'Read-only. Covers joint 2Up accounts.',
    link: { href: 'https://api.up.com.au/getting_started', text: 'Up developer portal' },
  },
  POCKETSMITH_DEVELOPER_KEY: {
    group: 'Money', label: 'PocketSmith key',
    help: 'Categorised spending and budgets.',
    link: { href: 'https://my.pocketsmith.com/security', text: 'PocketSmith security' },
  },
  NOTION_TOKEN: {
    group: 'Notes', label: 'Notion token',
    help: 'Share each page with the integration in Notion, or it sees nothing.',
    link: { href: 'https://www.notion.so/my-integrations', text: 'Notion integrations' },
  },
  JIRA_BASE_URL: { group: 'Tasks', label: 'Jira site', help: 'e.g. https://yoursite.atlassian.net' },
  JIRA_EMAIL: { group: 'Tasks', label: 'Atlassian account' },
  JIRA_API_TOKEN: {
    group: 'Tasks', label: 'Jira token',
    help: 'A plain token, not a scoped one. Scoped tokens 401 against the site URL.',
    link: { href: 'https://id.atlassian.com/manage-profile/security/api-tokens', text: 'Atlassian API tokens' },
  },
  JIRA_PROJECT_KEY: { group: 'Tasks', label: 'Board', help: 'Where new tasks go, e.g. HTL.' },
  QSTASH_CURRENT_SIGNING_KEY: {
    group: 'Scheduler', label: 'QStash current signing key',
    help: 'Proves a tick really came from QStash.',
    link: { href: 'https://console.upstash.com/qstash', text: 'the Upstash console' },
  },
  QSTASH_NEXT_SIGNING_KEY: {
    group: 'Scheduler', label: 'QStash next signing key',
    help: 'The second key in the console; QStash rotates onto it.',
  },
  TICK_SECRET: {
    group: 'Scheduler', label: 'Manual tick secret',
    help: 'Optional: lets you POST /api/tick by hand with an x-tick-secret header.',
  },
  AMBIENT_MODE: {
    group: 'Behaviour', label: 'Chime in unprompted', toggle: true,
    help: 'Lets the bot judge whether an unaddressed group message deserves a reply.',
  },
  TIMEZONE: {
    group: 'Behaviour', label: 'Household timezone',
    help: 'Where the house is, not where you are reading this. Reminders and calendar entries mean this time wherever anyone happens to be.',
  },
  LANGUAGE: {
    group: 'Behaviour', label: 'Language',
    help: 'The language and spelling the bot replies and drafts in.',
    options: [
      'Australian English', 'British English', 'American English',
      'German', 'French', 'Spanish', 'Italian', 'Portuguese', 'Dutch',
      'Japanese', 'Korean', 'Chinese', 'Vietnamese', 'Hindi',
    ],
  },
  UNITS: {
    group: 'Behaviour', label: 'Units',
    help: 'Metric or imperial, for weather, distances and recipes.',
    options: ['metric', 'imperial'],
  },
}

export const SETTING_GROUPS = [
  'Telegram',
  'Google Gemini',
  'OpenRouter',
  'Self-hosted LLM',
  'Money',
  'Tasks',
  'Notes',
  'Web search',
  'Weather',
  'Scheduler',
  'Behaviour',
] as const

/** A word about the group as a whole, shown once above its settings. */
export const GROUP_NOTES: Partial<Record<(typeof SETTING_GROUPS)[number], string>> = {
  Scheduler:
    'QStash calls /api/tick every five minutes to fire reminders; these keys prove a call really came from it. Saved here they apply straight away, no redeploy.',
  Telegram:
    'How the family reaches the bot. Values saved here take effect straight away, but Telegram keeps delivering with the old token and secret until the webhook is reconnected below.',
  OpenRouter:
    'Whether a provider may train on your prompts is an account setting at openrouter.ai/settings/privacy, not a property of the model. With training off, OpenRouter only routes to providers that do not train, so a free model that answers has not trained on you, and one that cannot be reached is being refused rather than quietly used. Test below to see which is which.',
  'Self-hosted LLM':
    'The only tier where nothing leaves the house. Point this at a server you run and put it first, and the rest become the fallback.',
}

export type SettingView = {
  key: string
  group: string
  label: string
  help?: string
  link?: { href: string; text: string }
  toggle?: boolean
  options?: readonly string[]
  secret: boolean
  set: boolean
  /** Present only for non-secret settings; credentials are never sent back. */
  value: string | null
  source: 'dashboard' | 'environment' | 'unset'
  updatedAt: string | null
  updatedBy: string | null
}

export async function listSettings(): Promise<SettingView[]> {
  await hydrateSecrets()
  const stored = new Map((await db().select().from(secrets)).map((r) => [r.key, r]))

  return MANAGED_KEYS.map((key) => {
    const row = stored.get(key)
    const current = process.env[key]
    const secret = isSecretShaped(key)
    return {
      key,
      ...SETTING_META[key],
      secret,
      set: Boolean(current),
      value: secret ? null : (current ?? null),
      source: row ? 'dashboard' : current ? 'environment' : 'unset',
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    }
  })
}
