import { eq } from 'drizzle-orm'
import { db } from './db'
import { secrets } from './db/schema'
import { encrypt, decrypt } from './crypto'
import { formatLocal } from './cron'
import { timezone } from './env'

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
  'TYPESAFE_API_KEY',
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
  'TYPESAFE_API_KEY',
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

/**
 * The `updated_by` a row carries when its value was taken from the
 * deployment's environment rather than typed into the dashboard.
 */
export const FROM_ENVIRONMENT = 'environment'

/** What the store holds for one key, decrypted: the value and who last wrote it. */
type StoredValue = { value: string; updatedAt: Date; updatedBy: string | null }

/** What one read of the store found, and whether the read itself worked. */
type Store = { values: Map<ManagedKey, StoredValue>; ok: boolean }

let reading: Promise<Store> | null = null
/** Whether this instance has ever read the store without the read failing. */
let everRead = false

/** Put a value where the rest of the code reads it. An empty value is an unset key. */
function apply(key: string, value: string): void {
  if (value) process.env[key] = value
  else delete process.env[key]
}

/**
 * Read every managed setting from the store and put it where the code reads
 * it. Called at the start of every request and never memoised: under Fluid
 * compute several instances serve at once, each with its own process.env, and
 * a memo meant a key saved on the dashboard was applied on one instance and
 * unknown to the others for up to a minute, so the page that rendered on one
 * of the others said it was not set. One small read per request is what makes
 * the database the only source of truth. Concurrent callers within one
 * instance share the read in flight. Copying into process.env spares
 * threading an async accessor through every `process.env.X` read.
 *
 * Every managed setting has one home. The store owns a key from the moment it
 * holds a row for it; a key the store has never seen is imported from the
 * deployment's environment, once, and owned from then on. An env var changed
 * after that is simply never read.
 */
export function hydrateSecrets(): Promise<void> {
  return readStore().then(() => undefined)
}

function readStore(): Promise<Store> {
  if (!reading) {
    reading = load().finally(() => {
      reading = null
    })
  }
  return reading
}

async function load(): Promise<Store> {
  const out = new Map<ManagedKey, StoredValue>()
  let ok = false
  try {
    const stored = new Map((await db().select().from(secrets)).map((r) => [r.key, r]))
    ok = true
    everRead = true
    for (const key of MANAGED_KEYS) {
      const row = stored.get(key)
      if (row) {
        try {
          const value = await decrypt(row.value)
          apply(key, value)
          out.set(key, { value, updatedAt: row.updatedAt, updatedBy: row.updatedBy })
        } catch (err) {
          console.error(`[settings] could not decrypt ${key}:`, err)
        }
        continue
      }
      // With no row, process.env still holds whatever the deployment set:
      // nothing here has written to it yet. That is the seed.
      const fromEnv = process.env[key]
      if (fromEnv) out.set(key, await seed(key, fromEnv))
    }
  } catch (err) {
    // A missing table or an unreachable database must not take the bot
    // down; whatever the deployment's env vars say still applies.
    console.error('[settings] could not read the settings store, using the environment:', err)
  }
  return { values: out, ok }
}

/**
 * First sight of a key the environment sets: it becomes a row, marked as the
 * environment's, and the store owns it from here. Do-nothing on conflict, so
 * two instances importing at once cannot fight over it, and a value typed
 * into the dashboard in the meantime wins: whoever lost the race reads the
 * row that won.
 */
async function seed(key: ManagedKey, value: string): Promise<StoredValue> {
  const inserted = await db()
    .insert(secrets)
    .values({ key, value: await encrypt(value), updatedBy: FROM_ENVIRONMENT })
    .onConflictDoNothing()
    .returning({ updatedAt: secrets.updatedAt })
  if (inserted.length) {
    console.info(`[settings] ${key} imported from the deployment environment; the dashboard owns it now`)
    apply(key, value)
    return { value, updatedAt: inserted[0].updatedAt, updatedBy: FROM_ENVIRONMENT }
  }
  const [row] = await db().select().from(secrets).where(eq(secrets.key, key))
  const plain = await decrypt(row.value)
  apply(key, plain)
  return { value: plain, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
}

/** When this instance last read the store for a caller it was about to turn away. */
let recheckedAt = -Infinity
const RECHECK_MS = 60 * 60_000

/**
 * For a route that checks its caller's credential against what this instance
 * already holds, before anything touches the database: a caller that fails
 * the check gets one fresh read of the store, in case the credential changed
 * on another instance, but no more than one an hour. Each read wakes the
 * database for five minutes. A read for every refusal let anyone who knew the
 * host keep it awake around the clock by posting junk every few minutes,
 * which runs out the month's compute hours (see the README's QStash note),
 * and Neon then suspends the whole deployment. Returns whether it read.
 *
 * The hour starts only after a read of its own that worked, on an instance
 * that had read the store before. A caller arriving while a read is under
 * way shares it rather than being refused: an album's pages reach a fresh
 * instance together, and all but the first were turned away while the first
 * was still reading. An instance that has never read the store holds nothing
 * yet, so its first delivery has to come this way and must not use up the
 * hour. A read that failed changed nothing, so it does not count either, or a
 * database that was down left the instance refusing every delivery for an
 * hour after it was back.
 */
export async function recheckSecrets(): Promise<boolean> {
  if (reading) {
    await reading
    return true
  }
  if (everRead && Date.now() - recheckedAt < RECHECK_MS) return false
  const first = !everRead
  const { ok } = await readStore()
  if (ok && !first) recheckedAt = Date.now()
  return true
}

/** Test seam: forget a read in flight, whether the store was ever read, and when it was last read for a refusal. */
export function resetHydration(): void {
  reading = null
  everRead = false
  recheckedAt = -Infinity
}

export async function setSecret(key: ManagedKey, value: string, updatedBy: string): Promise<void> {
  const encrypted = await encrypt(value)
  await db()
    .insert(secrets)
    .values({ key, value: encrypted, updatedBy })
    .onConflictDoUpdate({ target: secrets.key, set: { value: encrypted, updatedAt: new Date(), updatedBy } })
  apply(key, value)
}

/**
 * Unset a key for good. The row stays, holding an empty value, so the key is
 * not seeded from the environment again on the next cold start: removed means
 * removed, whatever the deployment's env vars still say.
 */
export async function clearSecret(key: ManagedKey, updatedBy: string): Promise<void> {
  await setSecret(key, '', updatedBy)
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
    help: 'Put :free models first. A paid slot answers only once every model above it has been skipped: an error, a rate limit (free models get 50 requests a day until you buy any credit), a reply that takes over 60 seconds, or no reply at all. System shows who actually answered.',
  },
  LLM_BASE_URL: {
    group: 'Self-hosted LLM', label: 'Endpoint',
    help: 'Any OpenAI-compatible server you run yourself: Ollama, vLLM, LM Studio, llama.cpp. Nothing leaves the house when this one answers.',
  },
  LLM_API_KEY: { group: 'Self-hosted LLM', label: 'API key', help: 'Leave empty if your server does not check one.' },
  LLM_MODEL: { group: 'Self-hosted LLM', label: 'Models', help: 'Must support tool calling.' },
  TYPESAFE_API_KEY: {
    group: 'TypeSafe Jev', label: 'API key',
    help: 'Optional. With a key, the yes-or-no and pick-one questions behind the bot go to Jev; without one they go to the chain above.',
    link: { href: 'https://console.typesafe.ai/settings/keys', text: 'console.typesafe.ai' },
  },
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
  'TypeSafe Jev',
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
    'QStash calls /api/tick on a schedule to fire reminders; these keys prove a call really came from it. Hourly is plenty: every call wakes the Neon database for five minutes, and a five-minute schedule never lets it sleep. A change applies straight away, no redeploy.',
  Telegram:
    'How the family reaches the bot. A change takes effect straight away, but Telegram keeps delivering with the old token and secret until the webhook is reconnected below.',
  OpenRouter:
    'Whether a provider may train on your prompts is an account setting at openrouter.ai/settings/privacy, not a property of the model. With training off, OpenRouter only routes to providers that do not train, so a free model that answers has not trained on you, and one that cannot be reached is being refused rather than quietly used. Test below to see which is which.',
  'Self-hosted LLM':
    'The only tier where nothing leaves the house. Point this at a server you run and put it first, and the rest become the fallback.',
  'TypeSafe Jev':
    'Jev judges rather than writes: given a question with a yes or a name for an answer, it returns a probability in about a tenth of a second, for a fraction of a cent. With a key set it decides whether an unaddressed group message is for the bot, whether a reply claims a change no tool made, and whether each watcher post is true to its evidence; the chain above still writes every reply and post. System lists its calls under jev:.',
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
  /**
   * Where the value was written from: this dashboard, or the deployment's
   * environment the first time the setting was seen. Null while the key is
   * unset.
   */
  origin: 'dashboard' | 'environment' | null
  updatedAt: string | null
  updatedBy: string | null
  /** When the value was written, in household time: "28 Aug" and the full form. */
  savedOn: string | null
  savedAt: string | null
}

/**
 * The page's rows, from the store itself rather than from this instance's
 * process.env: a key saved a moment ago on another instance is set, and says
 * so, whatever this instance had applied.
 */
export async function listSettings(): Promise<SettingView[]> {
  const stored = (await readStore()).values

  return MANAGED_KEYS.map((key) => {
    const row = stored.get(key)
    const secret = isSecretShaped(key)
    const set = Boolean(row?.value)
    return {
      key,
      ...SETTING_META[key],
      secret,
      set,
      value: secret ? null : row?.value || null,
      origin: row && set ? (row.updatedBy === FROM_ENVIRONMENT ? 'environment' : 'dashboard') : null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
      // Formatted here, in the household's zone, so the server-rendered page
      // and the browser agree on the day.
      savedOn: row ? new Intl.DateTimeFormat('en-AU', { timeZone: timezone(), day: 'numeric', month: 'short' }).format(row.updatedAt) : null,
      savedAt: row ? formatLocal(row.updatedAt) : null,
    }
  })
}
