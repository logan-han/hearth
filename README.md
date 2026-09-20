# Hearth

[![CI](https://github.com/logan-han/hearth/actions/workflows/ci.yml/badge.svg)](https://github.com/logan-han/hearth/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/logan-han/hearth/branch/main/graph/badge.svg?token=xtB7uJCjn8)](https://codecov.io/gh/logan-han/hearth)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flogan-han%2Fhearth&project-name=hearth&repository-name=hearth&env=TOKEN_ENC_KEY%2CADMIN_EMAILS%2CGOOGLE_CLIENT_ID%2CGOOGLE_CLIENT_SECRET&envDescription=TOKEN_ENC_KEY%3A%20any%2064%20hex%20chars%20%28openssl%20rand%20-hex%2032%29%2C%20encrypts%20stored%20keys%20and%20signs%20sessions.%20ADMIN_EMAILS%3A%20your%20email%2C%20for%20dashboard%20sign-in.%20The%20Google%20OAuth%20client%20powers%20the%20sign-in%20screen.&envLink=https%3A%2F%2Fgithub.com%2Flogan-han%2Fhearth%23setup&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

A self-hosted family assistant that lives in one Telegram chat. It answers questions
with web search, reads and writes each member's own email and calendar (Google and
Microsoft), publishes a shared family calendar everyone can subscribe to, and runs
reminders on a schedule.

Built to run entirely on free tiers: Vercel Hobby, Neon Postgres, Upstash QStash,
Tavily, and a local-first OpenAI-compatible LLM with OpenRouter as a fallback.

- [How it fits together](#how-it-fits-together)
- [Layout](#layout)
- [Setup](#setup) — [Telegram](#1-telegram) · [Google Cloud](#2-google-cloud) · [Azure Entra](#3-azure-entra) · [Services](#4-services) · [Model chain](#model-chain) · [Deploy](#5-deploy)
- [Day-to-day](#day-to-day)
- [Reading photos, scans and voice notes](#reading-photos-scans-and-voice-notes)
- [Keeping watch](#keeping-watch)
- [Sweeping email onto the calendar](#sweeping-email-onto-the-calendar)
- [What it remembers](#what-it-remembers)
- [Shared lists](#shared-lists) · [Money](#money) · [Notion](#notion) · [Jira](#jira)
- [The web dashboard](#the-web-dashboard)
- [Claude, and anything else that speaks MCP](#claude-and-anything-else-that-speaks-mcp)
- [Observability](#observability)
- [Safety properties](#safety-properties)
- [Development](#development) · [Licence](#licence)

## How it fits together

```
Telegram ──webhook──> /api/telegram ──ack 200──┐
                        │ waitUntil()          │
                        v                      │
                  agent loop (AI SDK) <──── history + member context (Neon)
                        │ tools
        ┌───────┬───────┼────────┬──────────┬─────────┐
      Tavily  Gmail   GCal    MS Graph   family cal  memory/automations
                                          │
QStash ──hourly tick──> /api/tick ──due automations──> agent ──> Telegram
Google/Outlook/Apple ──subscribe──> /api/calendar/{token}/family.ics
```

Telegram retries any webhook it does not get an ack for within seconds, so
`/api/telegram` validates, acks, and finishes the work in `waitUntil()` under
Vercel Fluid compute (300 s ceiling).

A chat turn does not see all 52 tools. About twenty are always in reach (search,
weather, lists, the shared calendar and its proposals, memory); mail, personal
calendar, money, Notion, Jira and automations are switched on by cues in the
message, and the model can unlock any group itself with `more_tools`. Fewer
tools per call is one of the better-evidenced ways to keep a small model
picking the right one. Watchers and the nightly memory pass get a fixed short
list instead.

History is the last 15 messages verbatim plus a rolling summary of everything
older, refreshed after a reply once six or more messages have fallen out of the
window. The summary keeps names, dates, amounts and open requests and drops
chatter, so a fact from last week is still in reach without the transcript.

Before anything a watcher wrote reaches the chat it passes two checks in fresh
contexts: each checkable claim is tested against the evidence by a call that
never sees the draft, and what fails is removed from the draft with the rest
left as written; then a decision says post or skip with a confidence, judging
only whether the draft is true to its evidence: what the writer chose to
include is not re-judged. With a TypeSafe key these judgements, the ambient
gate and the check on a reply that reports a change no tool made are put to
[Jev](https://typesafe.ai), a model that answers typed yes-or-no and pick-one
questions with a probability rather than writing anything; without one they
are structured calls to the chain, which then tries first the models that have
lately been returning an object, whatever the chain order for chat. A draft
held back at either step goes to an admin by DM with the reason and the draft,
so a snapshot that should have posted is never merely quiet. A chat also hears
from its watchers at most six times an hour, with an admin told the first time
the cap holds something back.

## Layout

| Path | What it is |
| --- | --- |
| `app/api/telegram/route.ts` | Webhook: secret check, ack, background processing |
| `app/api/tick/route.ts` | QStash-signed scheduler entry point |
| `app/api/oauth/{google,microsoft}/` | OAuth start + callback |
| `app/api/calendar/[token]/` | Token-protected ICS feed |
| `app/connect/page.tsx` | Link and unlink accounts, shows the ICS URL |
| `app/page.tsx` | Sign-in, or Home: calendar, next up, reminders, lists |
| `app/setup/` | Admin: first-run guide — bot, webhook, family, model, timezone |
| `app/system/` | Admin: model chain, traffic, integrations, chats |
| `app/settings/` | Admin: family, keys, model pickers, Telegram webhook |
| `lib/settings.ts` | Encrypted, DB-backed settings for a fixed allowlist of keys, seeded once from the environment |
| `lib/auth/session.ts` | Admin sign-in, and who counts as an admin |
| `lib/agent.ts` | Per-mode prompts, agent loop, post decision, ambient gate |
| `lib/handler.ts` | Update parsing, allowlist, commands, reply routing |
| `lib/watchers.ts` | The ready-made watchers: schedule, phrasing rules, context tools |
| `lib/builtins.ts` | Installs the built-in watchers in every household group and keeps them in step with their definitions |
| `lib/model.ts` | Tiered model chain: local, Gemini, OpenRouter |
| `lib/jev.ts` | TypeSafe Jev: the typed judgements (gate, reply check, claim checks, post decision), their questions and thresholds |
| `lib/tools/` | search, mail, calendar, family calendar, proposals, lists, money, notion, jira, memory, automations |
| `lib/tools/router.ts` | Which tool groups a chat turn sees, and the `more_tools` escape hatch |
| `app/api/mcp/route.ts` | The same tools over MCP, behind a per-member key |
| `lib/mcp.ts` | What an MCP client is offered, and who each call runs as |
| `lib/ics-parse.ts` | Reading a calendar file someone sends, for the listing and `import_calendar_file` |
| `lib/model-events.ts` | One row per model call, folded into the chain health on System |
| `scripts/probe-model.ts` | `npm run probe`: a real tool call against a candidate model before it joins the chain |
| `lib/summary.ts` | The rolling summary each chat keeps of what fell out of the raw history window |
| `lib/rate-cap.ts` | The ceiling on scheduled posts per chat per hour |
| `lib/providers/` | Gmail and Microsoft Graph behind one interface |
| `lib/db/` | Drizzle schema and queries |
| `lib/crypto.ts` | AES-256-GCM for refresh tokens at rest |
| `scripts/set-webhook.ts` | Registers the Telegram webhook |

## Setup

**One click**: the Deploy button above clones this repo into your own GitHub,
provisions a Neon Postgres through the Vercel Marketplace, asks for the four
bootstrap values, and deploys — migrations run inside the build, so there is
nothing to run by hand. Sign in and **/setup** walks you through the rest.
The Google OAuth client is the one real errand: create it (section 2) and add
your deployment's callback URL once you know the domain.

Only that bootstrap has to live in env vars: the database, `TOKEN_ENC_KEY`,
`ADMIN_EMAILS` and one OAuth client to sign in with. Deploy with those, sign in,
and Hearth walks you through the rest at **/setup** — bot token, webhook,
family, a model provider (any one of Gemini, OpenRouter or a self-hosted
server is enough), timezone — with no redeploys. Everything below can also be
seeded through the environment: an env var for a dashboard-managed setting is
read **once**, the first time the deployment sees that setting, and copied into
the dashboard's encrypted store, which owns it from then on. The env var is
never read again and can be deleted; change the setting in Settings. Either
way BotFather is still where the bot itself comes from.

### 1. Telegram

BotFather: `/newbot`, then `/setprivacy` → **Disable** so the bot can see group
messages. Add the bot to your family group. The token, webhook secret and
founding members can be set at `/setup` (or Settings) once the app is running;
the env vars below seed the same values.

Get your numeric Telegram user id from [@userinfobot](https://t.me/userinfobot),
or DM the bot `/whoami` (`/start` answers with your id even before you are
allowed). Put the founding members in `ALLOWED_TELEGRAM_IDS`, or add them on
the dashboard afterwards.

### 2. Google Cloud

Create an OAuth **Web application** client. Authorised redirect URI:

```
https://<your-deployment>/api/oauth/google/callback
```

Scopes: `gmail.modify`, `gmail.send`, `calendar.events`, `calendar.readonly`.

Publish the consent screen to **Production** and leave it unverified. Members see
a one-time "Google hasn't verified this app" warning and click through
*Advanced → continue*. This avoids Testing mode's 7-day refresh-token expiry;
verification is not required for private family use.

### 3. Azure Entra

Register an app with **Accounts in any organisational directory and personal
Microsoft accounts**. Redirect URI (Web):

```
https://<your-deployment>/api/oauth/microsoft/callback
```

Delegated permissions: `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`,
`User.Read`, `offline_access`.

### 4. Services

- **Neon** — add Postgres from the Vercel Marketplace; it injects `DATABASE_URL`
  and friends into the project. Copy them into `.env.local` too, so `db:push`
  works. `drizzle.config.ts` prefers `DATABASE_URL_UNPOOLED` for DDL, since
  pgbouncer in transaction mode is a poor host for migrations.
- **Upstash QStash** — one recurring schedule, `0 * * * *`, POSTing to
  `https://<your-deployment>/api/tick`. Copy both signing keys into Settings →
  Scheduler (or the env). Hourly is deliberate: every tick wakes the Neon
  compute and the free plan keeps it awake for five minutes afterwards, so a
  tick every five minutes never lets it sleep. That is 0.25 CU around the
  clock, 180 CU-hours a month against the 100 the free plan allows, after
  which Neon suspends the database until the next month. Hourly ticks cost
  about 16 CU-hours a month, every 15 minutes about 60. A reminder due
  between ticks runs at the next one, so schedules belong on the hour, as the
  built-in watchers are. The bot holds itself to this: it learns the tick
  grid from QStash's own calls, `create_automation` refuses a cron that
  would not land on a tick and offers the nearest that does, and Home marks
  any reminder already off the grid with the tick it will really run at.
  (Vercel Hobby cron is once-a-day minimum, which cannot drive reminders.)
- **Tavily** — API key, 1k credits/month free.
- **OpenWeatherMap** — optional; a free key from
  [home.openweathermap.org/api_keys](https://home.openweathermap.org/api_keys)
  powers weather questions and the morning brief, cached so the free tier is
  never dented.
- **Google AI Studio** — a free Gemini key from
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
- **OpenRouter** — [openrouter.ai/keys](https://openrouter.ai/keys). Free models
  are capped at 50 requests/day until you buy any credit, then 1000.
- **TypeSafe** — optional; an API key from
  [console.typesafe.ai](https://console.typesafe.ai/settings/keys) puts the
  typed decisions to Jev instead of the chain. See [Typed decisions](#typed-decisions).
- **Langfuse** — optional; a project's public and secret key from
  [langfuse.com](https://langfuse.com) turn on tracing of every model call.
  See [Observability](#observability).

### Model chain

Three tiers, tried in order, each dropping out when unconfigured. The order is
`LLM_ORDER` and is editable from **System** by moving tiers up and down, so the
thing you read is the thing you change. Self-hosted leads by default, being the
only tier where nothing leaves the house.

1. `LLM_BASE_URL` + `LLM_MODEL` — a self-hosted OpenAI-compatible endpoint
2. `GEMINI_API_KEY` + `GEMINI_MODEL`
3. `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`

Models are picked from what each provider actually serves rather than typed by
hand, and only tool-capable ones are offered, because a model that cannot drive
tools fails at the worst moment instead of at configuration time. Before
promoting a candidate, probe it with a real tool call and a typed choice, the
two things every slot has to do:

```bash
npm run probe -- openrouter minimax/minimax-m3
```

**On training:** whether a provider may train on your prompts is an account
setting at `openrouter.ai/settings/privacy`, not a property of a model, and the
OpenRouter API exposes no policy field to read. With training disabled
OpenRouter simply will not route to providers that train, so **Test** next to
each model is the practical answer: one that answers has not trained on you,
one that is refused is being declined on your behalf, and a rate limit is
reported as telling you nothing rather than being read as a verdict.

Each `*_MODEL` takes a comma-separated list tried left to right, so a tier can
offer a fast model first and a stronger one behind it. Put `:free` models ahead
of paid ones and the paid slot only ever answers when everything free has
failed.

Order the chain on measured latency, not on price alone. Free OpenRouter
endpoints are deprioritised under load, so the same model can serve in 5s or
16s depending on the hour; a paid slot at the tail is what stops a bad hour
turning into a failed reply. A rate limit, timeout,
provider outage, or a model that cannot drive tools all collapse to the same
behaviour: move to the next slot. Every model in the chain must support tool
calling.

`LLM_REASONING` (none, minimal, low, medium, high) is passed through as
`reasoning_effort` when set. Leave it empty for the provider default. Gemini's
OpenAI-compatible layer ignores values it does not know and cannot switch
thinking off on Gemini 3 models, so check token counts after changing it rather
than assuming it took.

### Typed decisions

Beside the chain sits one optional judge. `TYPESAFE_API_KEY` (Settings →
TypeSafe Jev) sends the typed decisions to TypeSafe's
[Jev](https://docs.typesafe.ai): a System One model that does not write, only
answers yes-or-no and pick-one questions with a calibrated probability, in
about 100 ms, at $0.042 per million input tokens and nothing for output. Hearth
asks it four things: whether an unaddressed group message is for the bot,
whether a chat reply reports a change no tool made, whether each statement in
a watcher draft is in its evidence, and whether the draft as a whole is. The
chain still writes every reply, draft and edit.

Every question and every threshold is in `lib/jev.ts`, so what the bot asks
and where it draws each line is one file to read. Without the key those four
go to the chain as structured outputs, as before; if Jev cannot answer, the
same question goes to the chain, or falls the safe way (the gate stays quiet,
a reply is left alone). The post decision is the same two questions whichever
judge answers: is anything in the draft not in the evidence, and does the
draft only say there is nothing new. Code turns the answers into post or skip,
so neither judge is ever handed a verdict to reach, and neither is asked
whether the writer obeyed its instruction: a judge that was once asked for a
verdict held a whole brief back over a collection whose time had passed, which
was the writer's selection to make and nothing the evidence lacked. `TYPESAFE_DEFAULT_MODEL` pins a version
(`jev-1.13.0`) where `jev-latest` would move without notice. Its calls sit
beside the chain's on **System** under `jev:`, and in Langfuse as generations
named after the decision.

### 5. Deploy

```bash
cp .env.example .env.local        # fill in at least the bootstrap
openssl rand -hex 32              # -> TOKEN_ENC_KEY
vercel --prod                     # the build applies drizzle/ migrations itself
npm run set-webhook               # or connect the webhook from /setup instead
```

The build runs pending migrations whenever `DATABASE_URL` is present in the
environment, which is what makes the Deploy button a complete install. A plain
local `npm run build` finds no database and skips that step; point a local
database at the schema with `npm run db:migrate` (or `db:push` while iterating
on the schema).

`drizzle-kit` and `set-webhook` both read `.env.local`, so secrets only have to
live in one place locally. On Vercel they come from the project's environment
variables.

Turn **Deployment Protection → Vercel Authentication** off. It is on by default
for new projects and would make Telegram, QStash and calendar apps bounce off an
SSO redirect.

## Day-to-day

| Command | Effect |
| --- | --- |
| `/help` | What the bot can do |
| `/connect` | DMs a personal link to link Google or Microsoft |
| `/accounts` | List linked accounts |
| `/unlink google` | Remove an account |
| `/calendar` | The family calendar subscription URL |
| `/mcp` | DMs a personal key for the MCP endpoint; `/mcp new` replaces it, `/mcp off` revokes it |
| `/whoami` | Your Telegram id |
| `/members` | Who the bot answers to |
| `/allow <id>` | Admin: let someone in, or reply to their message with `/allow` |
| `/deny <id>` | Admin: revoke someone |

In a group, @mention the bot or reply to one of its messages. Every group message
is stored as context either way. Set `AMBIENT_MODE=on` to let the bot decide for
itself whether an unaddressed message deserves an answer. The decision is a
typed choice (reply, stay silent, unsure) from the head of the model chain,
asked from both sides ("should it reply?", then "should it stay silent?") and
acted on only when the two agree; unsure counts as silence, and every decision
is logged.

## Reading photos, scans and voice notes

Send the bot a photo of a notice, a letter or an invitation and it reads the
picture, not just the caption. A message with no text at all is
still processed, which is the usual case for a snap of something on the fridge.
PDFs and voice notes go the same way.

Anything with a date in it becomes a **proposal** rather than a calendar entry:
the bot shows what it found and waits for someone to say yes. Nothing the bot
merely *found* reaches the shared calendar on its own, which is the same rule
that governs outbound email.

Only some models can read images. Gemini and MiniMax M3 (free or paid) can;
the older `minimax-m2.7` cannot, and fails with a clear error the fallback
simply steps past, which is one reason the paid tail in `.env.example` is
`minimax/minimax-m3` rather than m2.7: same price, newer, and it reads what the
free head reads. Attachments that cannot be fetched or are of a type no model
reads are dropped, and the bot answers on the text alone.

Text files are read in code and handed to the model as text, because the
model endpoints accept no file type beyond images, PDFs and audio. A calendar
file (`.ics`, recognised by its content as well as its name) gets one thing
more: its events are parsed here, with time zones, all-day dates and repeats
worked out deterministically, and listed for the model; asked to add them, it
calls `import_calendar_file` once and the whole file lands on the family
calendar, duplicates skipped and repeating events reported rather than
guessed at. A file is readable only in the message it arrives with, so send
the request as the file's caption.

A file attached to an **email** is a different path. `read_email` lists an
email's attachments by filename, and `read_attachment` reads one: a PDF or a
text file as its text (the PDF through the same extractor `read_url` uses), a
calendar file as its parsed events. An image attached to an email cannot be
read this way yet; the bot says so and asks for it as a photo in the chat.
Something made from an email, a ticket above all, is made after the email and
its attachments have been read, not from the inbox snippet: a renewal notice
once became a board ticket with nothing in it but its subject line. The board
tools can also change a ticket afterwards (`jira_update_issue`: title,
description, due date) and copy an email's attachment onto it
(`jira_attach_email_file`), so the notice sits with the job.

**Saying a thing is done is not doing it.** A chat reply that reports a change
(added, replaced, cancelled, sent) while no tool that changes anything ran is
judged by a typed model call, the same shape as the ambient gate, and one
that reports a change is sent back to the model with the note that nothing
happened: act now, or say so. Should it insist a second time, the reply goes
out with a line saying nothing was changed. Events are also changed in place
with `update_family_event`, so "replace" is one call and every subscribed
calendar updates the same entry instead of showing a cancellation beside a new
one.

## Keeping watch

The bot is not only reactive. Two watchers come built in and are switched on
in every household group without anyone asking — each an ordinary automation
underneath that checks on a schedule and posts **only when there is something
worth saying**:

- **Morning brief**, daily at 7am: today's family calendar; the mail that has
  arrived since the last brief and is worth knowing about (appointments,
  notices, bills, deliveries), with calendar-worthy dates proposed for the
  family calendar; anything overdue on the board; and the weather. In the
  group it sweeps every member's linked mailbox, each on its own cursor via
  `new_mail`, and says whose each item was by name (Sam's Outlook), never by
  provider. A day with nothing on, no new mail and nothing due gets no brief;
  weather alone is not news.
- **Money snapshot**, Sunday at 6pm: the week's spending and the month so far,
  with the budget's pacing and the categories over it where PocketSmith is
  connected, or the totals from the raw Up feed where it is not. Spend is
  reckoned the way PocketSmith reckons it, by the side of the ledger each
  category keeps: a payment filed under an income category (a tax payment,
  say) is a deduction from income, reported as one and never as spend, and a
  rebate filed under the expense it refunds comes off that spend. The figures
  and the over-budget categories go out as two-column tables, which
  `lib/telegram-format.ts` lays out as aligned monospace lines in inline
  `code` spans: Telegram has no table element, and the `pre` block that could
  hold one is drawn as a code box with a copy button. A budget position comes
  from PocketSmith's own analysis, in which a month's allowance is the budget
  after rollover, so a category overspent earlier in the year can be allowed
  nothing this month while still being budgeted: it reads "over by $X", the
  categories in that state are named together once under the table, and only
  a category with no budget at all is called "no budget set".

Home lists both under Reminders with a pause; neither can be deleted, since
the next tick would only put it back. The tick also keeps them in step with
their definitions in `lib/watchers.ts`, and leaves a room alone while someone
unrecognised is in it — nothing is posted there, by any watcher, until they go.

**/watch** adds the rest, or switches a paused one back on:

- `/watch morning` — the brief, in a DM as well, where it reads your own mailbox.
- `/watch snapshot` — the money snapshot.
- `/watch money` — new 2Up transactions, checked hourly 9am–10pm. Cursor-disciplined,
  so a transaction is never posted twice.
- `/watch list` — what this chat is already watching.

Watchers are grounded before they are clever. Each ready-made watcher fetches
its data in code first, so an hour with nothing new never reaches a model at
all. When there is something, the model only phrases it, with a handful of
context tools: a transaction arrives as payee, amount and date, with a purpose
only when a household fact, calendar entry or email names one, and "purpose not
recorded" otherwise. Then post or skip is decided against the evidence, on
grounding alone, with a confidence: by Jev when a TypeSafe key is set,
otherwise by a second, tool-free call to the chain. Each judge draws its own
line (Jev's in `lib/jev.ts`, the chain's at 0.7 of its own confidence in
`lib/agent.ts`) and the tick posts what comes back as decided. A draft held
back is logged and sent to an admin with the reason. The commands are registered with
Telegram, so the `/` menu lists them; nothing to remember. Anything the
templates don't cover is a sentence away:
describe a schedule in plain words and it becomes a custom automation with
read-only tools, the same right to stay silent, and the same post decision.

## Sweeping email onto the calendar

The morning brief already does this for the family group: each day's mail
worth acting on is read, and every calendar-worthy date in it is proposed,
tagged with the message it came from, so the same notice is never proposed
twice however many mornings it turns up. Home lists the proposals under
"Waiting on a yes", each with what it is and where it came from in words, and
Add or No settles it.

A variation is a sentence away, and becomes a custom automation:

> every weekday at 7am, check my inbox for anything with a date in it and
> propose it for the family calendar

## What it remembers

The bot keeps household facts between conversations: routines, allergies, who
goes where, sizes, standing arrangements. Two things file them: a member asking
in the chat ("remember that bin night is Monday"), and a nightly pass that
re-reads the previous day's talk for what deserves keeping. The pass files only
what a family member said. Its own words, the morning brief and the watcher
posts included, are context for reading replies and never a source.

When a fact would be worth keeping but the talk does not say who it is about,
or it rests on a notice, bill or email rather than on a person, the pass does
not guess: it puts a question to the family instead. The next morning brief
asks it once, Home lists it under Remembered until it is answered, and any
member can answer in either place. A yes keeps the fact in their words, a
correction keeps the corrected version, a no keeps nothing. One-off events and
their venues, contact details from notices, and anything the calendar already
holds are left out altogether.

Scheduled posts read the same facts. A standing instruction remembered in the
chat, such as leaving one sender's mail out of the morning brief, holds for the
brief and the other watchers as it does for live replies.

Home lists what is remembered with a Forget for each. Forgetting is soft, so a
fact can be brought back by hand if a correction was wrong.

## Shared lists

> add milk and eggs to the shopping list
> what's on the shopping list?
> got the milk

Lists are created on first mention and addressed by name, so "packing list" and
"hardware list" work without setup. Ticking off matches on substring, so "milk"
ticks off "2L milk". `clear_list` removes only the ticked items unless told
otherwise, which is the usual tidy-up after a shop.

## Money

Two optional integrations, both read-only and both household-wide rather than
per member, since one token covers the household's accounts:

- **Up Bank** (`UP_API_TOKEN`) is the live account feed. Accounts marked `JOINT`
  are the shared 2Up ones, and each 2Up transaction names which partner made it.
- **PocketSmith** (`POCKETSMITH_DEVELOPER_KEY`) is the categorised view across
  every account connected there, plus budgets.

> how much have we spent this month?
> what's on the 2Up account?
> post any new 2Up transactions in this chat

Spending summaries default to PocketSmith because it has categories, and they
**exclude transfers**: money moved between your own accounts is not spending,
and counting it would roughly double every total. The Up feed has no transfer
flag, so an Up-sourced summary is the raw number and will read higher.

The third example is a scheduled announcement, and `new_transactions` is built
for it. Each chat keeps its own marker of what it has already seen, so however
often the automation runs nothing is posted twice. The first run looks back only
24 hours, so switching it on does not dump months of history into the chat.

Ask for it once and it keeps happening:

> every hour, post any new 2Up transactions here

Financial answers are subject to the same group rule as everything else: a room
holding anyone unrecognised gets no reply at all.

## Notion

`NOTION_TOKEN` is an internal integration token from
[notion.so/my-integrations](https://www.notion.so/my-integrations).

**The token grants nothing on its own.** Every page and database has to be
shared with the integration by hand, in Notion, under the page's `⋯` menu →
Connections. Anything unshared returns an *empty result* rather than an error,
so a missing page looks like a broken query. The tools say as much when a search
comes back empty.

> what's on my travel plans?
> add "read the tax guide" to my reading list

The API version is pinned to `2025-09-03`. That release split a database into a
container plus one or more data sources, so queries address a `data_source_id`,
which is why `notion_query_database` resolves a name to a data source first.
Bumping the version is a breaking change, not an upgrade.

Writes are **additive only**: the client can append paragraphs to a page and has
no way to edit or delete anything already there.

## Jira

The household board, for the jobs that need tracking rather than a shopping
list: rates, renewals, tax, repairs.

> what's on the board?
> what's overdue?
> add "fix the gutter" to the board, due end of September
> mark HTL-344 done

**Use a plain API token, not a scoped one.** At
[id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens),
"Create API token" works against `JIRA_BASE_URL` with basic auth. "Create API
token **with scopes**" does not: a scoped token has to be routed through
`api.atlassian.com/ex/jira/{cloudId}` instead and returns 401 against the site
URL, which looks exactly like a wrong password.

The bot can create issues, move them between statuses and comment. It **cannot
delete**: no tool exposes deletion and the client has no code path for it.
Moving an issue goes through Jira's transitions rather than setting a status
directly, so an unreachable target reports what *is* reachable from where the
issue currently sits.

Free-text search terms are escaped before they reach JQL, so a quote in a
message cannot rewrite the query or reach another project.

## The web dashboard

The site root is a sign-in screen, then **Home**: anything the bot has
proposed and is waiting on a yes for, listed with when it is, which chat it
was proposed in and what was found, then the month calendar with what's next,
the reminders that are running and the shared lists beneath it. Home is not
read-only: any recognised member can add or decline a proposal, cancel an
event, pause, resume or delete a reminder, and tick off, add or remove list
items — the same things they could ask the bot to do, one click closer. The
list only ever holds live questions: a proposal whose occasion has passed, or
whose event has since reached the calendar another way, drops out at once,
and the next tick records it as expired or superseded. Admins also get **System** and
**Settings**; for everyone else Home is the only destination, so no tabs are
shown at all. An admin landing on a deployment with no bot token is redirected
to **/setup**, the first-run guide.

The calendar leads because it is the thing the household actually wants to
look at. It is a real month grid, Monday-first, always six weeks tall so
flicking between months never moves the page, with events placed on their
Melbourne day rather than their UTC one, and multi-day events repeated across
each day they cover.

Sign-in reuses the Google and Microsoft clients already configured for member
linking. Both flows come back through the same provider callback and are told
apart by a `purpose` claim in the signed state, so **no extra redirect URI has
to be registered** in either console. Linking forces Google's consent screen,
because that is the only way to be handed a refresh token; signing in does
not, so a returning admin picks an account and is through, and only a first
sign-in still consents (and, as below, links). For a recognised member, signing in also
completes the mailbox link whenever the provider hands back a refresh token —
to the family, the web button and /connect are the same ceremony — though it
only fills a gap or refreshes the same address, never repointing an existing
link at a different account.

An address is recognised if it is in `ADMIN_EMAILS`, or an admin recorded it
against a member, or that member linked a mailbox with it. Admin members get the
admin view. Everyone else is signed in by the provider and then turned away,
because the check happens on the way back rather than the way out.

Admins manage the family from the same page: add someone by Telegram id and
name, optionally with an email so they can sign in before linking anything,
then change their email, allow, revoke, promote or remove. Revoking takes
admin with it. A founding member from `ALLOWED_TELEGRAM_IDS` cannot be removed
here, because the env seed would recreate them on their next message and the
removal would be a lie — and the **last admin cannot be revoked, demoted or
removed at all**, only succeeded, so the house cannot lock itself out.

System shows message volume over a fortnight, which model in the chain
actually answered (the head answering nearly everything is the healthy shape),
every reminder with its schedule, and any chat currently muted by an
unrecognised person. Two diagnostics sit beside those. **Last tick** is when
QStash last called the scheduler, with the cadence read off its last two
calls, and flagged once three of those intervals have passed without one,
because a scheduler that has gone quiet otherwise shows up only as reminders
not arriving. **Chain health** is every model call of the last
seven days, per slot: how many it answered and how quickly, how many times it
was skipped for the next slot and why (rate limited, timed out, no reply,
provider error), and how many chat replies were sent back for reporting a
change no tool had made. Integration status lives in Settings instead, as a
live dot beside the keys that drive each service.

Settings groups fold to a line each, showing the live dots, how many keys are
set and the values that are safe to show; a group opens on a click, or on its
own when an integration in it is failing. Editable settings are a **fixed
allowlist**. `DATABASE_URL`, `TOKEN_ENC_KEY`
and `ADMIN_EMAILS` are deliberately not on it, so a stolen session cannot
repoint the deployment at another database or lock the owner out. The Telegram
token, webhook secret and founding members *are* editable — an admin session
can already manage the family, so hiding the bot's own wiring bought nothing —
and Settings shows what Telegram thinks of the bot, with one button to point
the webhook back at this deployment after a change. Stored values are
AES-256-GCM encrypted and are **never sent back to the browser** for
credential-shaped keys. Every setting has exactly one home: the deployment's
environment seeds a key the first time it is seen, and the store owns it from
then on, with the env var never read again. Removing a setting leaves it
unset, whatever the environment still says.

## Claude, and anything else that speaks MCP

Everything the bot can do is also an [MCP](https://modelcontextprotocol.io)
server at `/api/mcp`, so Claude Code, Claude Desktop or any other MCP client can
work the family calendar, the shared lists, what the household remembers, each
member's mail and calendar, the money feed, Notion, the board and the reminders
directly. Send `/mcp` to the bot and it DMs a key and the line that connects it:

```bash
claude mcp add --transport http hearth https://<your-deployment>/api/mcp \
  --header "Authorization: Bearer <the key it sent you>"
```

The key *is* the member. Every call runs as whoever holds it — their mailbox,
their calendar, their name on what it writes — so it is only ever sent in a DM,
and `/mcp off` revokes it. Only the SHA-256 of a key is kept, which is why `/mcp`
on its own reports what is there rather than quietly reissuing and breaking
whatever is connected; `/mcp new` replaces it and stops the old one working. A
member who is denied takes their key with them, like every other door here.

A key travels as a header, which is what Claude Code, Claude Desktop, Cursor and
anything driven by `mcp-remote` take. Custom connectors on claude.ai want OAuth
and cannot be given a header, so that one is not a way in.

A client is handed all fifty tools at once rather than the routed subset a chat
turn sees: `more_tools` exists so a small model can start from twenty and widen,
and a capable client picks well from a long list. The two that mean nothing down
this pipe are left out — `more_tools` itself, and the import tool that reads a
calendar file attached to a Telegram message.

What a chat turn gets for free, a client has to ask for. `hearth_context` is the
first call to make: who it is acting as, the household clock, the family and
their linked accounts, the facts on file, and the drafts, event proposals and
open questions with the ids the other tools want.

Nothing changes about how the household hears of it. A tool that announces
itself still says so in the family chat, so an event added through Claude turns
up in the group and not only on the calendar, and mail still waits for a yes.
The room is the household's own group, or the member's DM with the bot while
there is someone unrecognised in it. The transport is stateless streamable HTTP:
nothing is remembered between calls, and an idle endpoint costs nothing.

## Observability

With `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` set,
every model call is traced to Langfuse: the prompt and reply, each tool call
and its result, tokens, timing, and the watcher post decisions with their
confidence. Traces are named by what the bot was doing (`hearth.chat`,
`hearth.watcher`, `hearth.sweep`, `hearth.gate`, `hearth.decision`), grouped
into a session per chat, and carry the member's Telegram id, so one bad reply
can be followed back to the exact tool result it misread. Jev's calls appear
in the same traces as generations named after the decision, with the state
and questions sent, the probabilities returned and the tokens spent. Tracing is
registered once at server start from `instrumentation.ts` and is inert without
the keys; the OpenTelemetry modules are not even loaded.

Two things worth knowing. Traces carry the family's messages and mail; set
`LANGFUSE_RECORD_CONTENT=off` to keep only the shape of each call. And the
keys are environment variables, not dashboard settings, because the tracer
starts before the database is read. The integration is built for Langfuse v4:
ingestion goes over OpenTelemetry through `@langfuse/otel` 5.4 or later, trace
attributes are propagated before each model call so every child observation
carries them, and nothing uses the legacy `langfuse` SDK, the old ingestion
endpoint or trace-level input/output setters. `tests/langfuse-v4.test.ts`
guards that contract.

Inside Langfuse, an LLM-as-a-judge rule ("Groundedness of watcher posts")
scores every `hearth.watcher` and `hearth.decision` trace, the draft and the
final wording of each proactive post, against the evidence in its input. The judge is OpenRouter's
MiniMax, deliberately not the Gemini family that writes the posts. A trace
scored *Not grounded* or *Somewhat grounded* is the next case for `evals/`.

## Safety properties

- The webhook rejects any request without the right `x-telegram-bot-api-secret-token`.
- **Authorisation is per person, never per room.** A message is answered only if
  the *sender's* Telegram id is an allowed member, so a room grants nothing by
  existing and the family can spin up new group chats without registering them.
  `ALLOWED_TELEGRAM_IDS` seeds the founders as admins; they add everyone else
  with `/allow` or from the dashboard, neither of which needs a redeploy. A
  deployment with no seed and no recorded members accepts **nothing** rather
  than everything.
- A group holding someone unrecognised is a group the bot stays quiet in. It
  notices them either when they join or when they first speak, says so once, and
  resumes when they are vouched for or leave. Without this, member-based auth
  would still read a private inbox aloud in front of an outsider.
- OAuth `state` is a 10-minute signed JWT bound to one Telegram user.
- Refresh tokens are AES-256-GCM encrypted with `TOKEN_ENC_KEY`.
- The ICS feed sits behind a long random token, compared without early exit.
- `/api/mcp` accepts only a bearer key it can match to an allowed member, and
  keys are stored as SHA-256 digests, so the store cannot hand one back out.
- `/api/tick` verifies the QStash signature.
- Email is never sent without a human "yes": `draft_email` and `send_email` are
  separate tools, the draft is persisted, and the send claims it atomically so a
  repeated confirmation cannot send twice.

## Development

### Evals

`npm run evals` runs the prompts against the live model chain with recorded
tool results, and scores the replies two ways: deterministic checks (every
dollar figure appears in what the tools returned, no trip read into a payee
string, no working shown, the right tool called) and an LLM judge for
groundedness and usefulness. The judge defaults to the paid OpenRouter slot so
it is not from the family under test; `EVAL_JUDGE_MODEL=provider:model`
overrides it. Judge scores are reported and only fail the run with
`EVAL_STRICT=1`. The cases in `evals/` are the failures the family has actually
seen; when a new one turns up, it belongs there before the prompt is touched.
It spends quota, so it is not part of `npm test` or CI. With `TYPESAFE_API_KEY`
set, `evals/jev.eval.ts` puts the gate, the reply check, the claim checks and
the post decision to Jev on the same fixtures, so a threshold in `lib/jev.ts`
is judged on cases rather than by feel.

```bash
npm run dev           # http://localhost:3000
npm test              # vitest
npm run test:coverage # vitest + coverage, thresholds at 80%
npm run typecheck
npm run db:generate   # after editing lib/db/schema.ts
```

The badge reads lower than the local run, and both are right: vitest reports
line coverage, while Codecov counts a line whose branches are only partly taken
as a partial and holds it against the total. Judge changes against the badge,
since it is the stricter of the two.

Query-layer tests run against a real Postgres, in process, via PGlite. The
harness in `tests/helpers/db.ts` applies every migration in `drizzle/` to a
fresh database per test, so constraints, defaults and the claim-by-predicate updates
that stop double-sends behave exactly as they do on Neon. `lib/db/index.ts`
exposes `__setDb` purely so that instance can be swapped in.

To test the webhook locally, tunnel port 3000 and point `APP_URL` at the tunnel
before running `npm run set-webhook`.

## Licence

MIT
