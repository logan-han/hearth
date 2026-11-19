# Hearth

[![CI](https://github.com/logan-han/hearth/actions/workflows/ci.yml/badge.svg)](https://github.com/logan-han/hearth/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/logan-han/hearth/branch/main/graph/badge.svg?token=xtB7uJCjn8)](https://codecov.io/gh/logan-han/hearth)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flogan-han%2Fhearth&project-name=hearth&repository-name=hearth&env=TOKEN_ENC_KEY%2CADMIN_EMAILS%2CGOOGLE_CLIENT_ID%2CGOOGLE_CLIENT_SECRET&envDescription=TOKEN_ENC_KEY%3A%20any%2064%20hex%20chars%20%28openssl%20rand%20-hex%2032%29%2C%20encrypts%20stored%20keys%20and%20signs%20sessions.%20ADMIN_EMAILS%3A%20your%20email%2C%20for%20dashboard%20sign-in.%20The%20Google%20OAuth%20client%20powers%20the%20sign-in%20screen.&envLink=https%3A%2F%2Fgithub.com%2Flogan-han%2Fhearth%23setup&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

A self-hosted family assistant you reach through [MCP](https://modelcontextprotocol.io):
Claude Code, Claude Desktop, claude.ai's connectors or any other MCP client. It keeps a
shared family calendar everyone can subscribe to, shared lists, the facts the household
keeps, goals, helpers and routines; it reads and writes each member's own email and
calendar (Google and Microsoft), the household's money feed (PocketSmith), Notion and the
family board (Jira); and it runs jobs on a schedule, keeping what each one finds for the
member who set it up. Every change is kept on a record, so nobody has to take its word for it.

Your MCP client is the brain. Hearth is the household behind it: the tools, the data, the
safety rules and a web dashboard.

Built to run on free tiers (Vercel Hobby, Neon Postgres, Upstash QStash, Tavily). A model of
its own is optional, needed only for the jobs that run while nobody is asking.

> **Telegram was removed on 20 November 2026.** Hearth used to live in a group chat. It is
> now MCP-only: there is no bot, no chat and nothing posted anywhere. The morning brief and
> the money snapshot are reads a client asks for, scheduled jobs leave reports, and MCP keys
> are made on the web.

- [How it fits together](#how-it-fits-together)
- [Layout](#layout)
- [Setup](#setup): [Google Cloud](#1-google-cloud) · [Azure Entra](#2-azure-entra) · [Services](#3-services) · [Model chain](#model-chain) · [Deploy](#4-deploy)
- [Connecting a client](#connecting-a-client)
- [The morning brief and the money snapshot](#the-morning-brief-and-the-money-snapshot)
- [Sweeping email onto the calendar](#sweeping-email-onto-the-calendar)
- [Jobs on a schedule, and their reports](#jobs-on-a-schedule-and-their-reports)
- [What it remembers](#what-it-remembers)
- [Goals](#goals) · [Helpers](#helpers) · [Routines](#routines)
- [Shared lists](#shared-lists) · [Recipes](#recipes) · [Money](#money) · [Finding a time](#finding-a-time) · [Notion](#notion) · [Jira](#jira)
- [What it changed](#what-it-changed)
- [The web dashboard](#the-web-dashboard)
- [Observability](#observability)
- [Safety properties](#safety-properties)
- [Development](#development) · [Licence](#licence)

## How it fits together

```
MCP client ──key or OAuth──> /api/mcp ──> tools ──> Gmail, Google Calendar, MS Graph,
   (Claude)                     │                    PocketSmith, Notion, Jira, Tavily,
                                │                    OpenWeatherMap
                                └──> family calendar, lists, facts, goals, proposals (Neon)

Browser ──Google/Microsoft sign-in──> dashboard: Home, Connect, System, Settings, /setup
QStash ──hourly──> /api/tick ──due jobs──> model chain ──checks──> reports (Neon)
Google/Outlook/Apple Calendar ──subscribe──> /api/calendar/{token}/family.ics
```

`/api/mcp` is stateless streamable HTTP: every request carries its own key, nothing is
remembered between calls, and an idle endpoint costs nothing. The key is the member: every
call runs as whoever holds it, against their mailbox, their calendar, their name on what it
writes.

The hourly tick runs the jobs members have scheduled (reminders, watches, goal check-ins,
jobs handed to helpers) through Hearth's own model chain. What a job writes passes two
checks in fresh contexts before it is kept: each checkable claim is tested against the
evidence by a call that never sees the draft, and what fails is cut with the rest left as
written; then a decision says keep or hold back, judging only whether the draft is true to
its evidence. A draft held back is kept too, marked as held, with why. Reports wait for the
member's client (`hearth_context`, `list_reports`) and Home.

The tick keeps one clock from its start: it starts a job only while a whole run and the
checks on its draft still fit in its first 280 s, so the rest stay due, first in line at
the next tick, rather than claimed and then stopped halfway through.

## Layout

| Path | What it is |
| --- | --- |
| `app/api/mcp/route.ts` | The MCP endpoint, behind a per-member key |
| `lib/mcp.ts` | What a client is offered, `hearth_context`, and who each call runs as |
| `app/api/mcp-keys/route.ts` | A signed-in member's own keys: make, list, revoke |
| `lib/oauth/server.ts` | Hearth as an OAuth 2.1 authorisation server for MCP clients |
| `app/api/oauth/{register,authorize,token}/` | Dynamic registration, the approval page, the token endpoint |
| `app/.well-known/` | Protected-resource and authorisation-server metadata |
| `app/api/oauth/{google,microsoft}/` | Dashboard sign-in and account linking, start and callback |
| `app/api/tick/route.ts` | QStash-signed scheduler: runs due jobs, keeps their reports, tidies up |
| `app/api/calendar/[token]/` | Token-protected ICS feed |
| `app/api/family/route.ts` | Home's and Connect's buttons |
| `app/page.tsx` | Sign-in, or Home: waiting on a yes, reports, calendar, goals, reminders, lists, facts, helpers, what changed, MCP keys |
| `app/connect/` | Link, unlink or make read-only your Google or Microsoft account; the ICS URL |
| `app/setup/` | Admin: first-run guide: family, model, timezone |
| `app/system/` | Admin: model chain health, changes, keys, every reminder |
| `app/settings/` | Admin: family, sign-out everywhere, model order, keys and behaviour |
| `lib/settings.ts` | Encrypted, DB-backed settings for a fixed allowlist of keys, seeded once from the environment |
| `lib/auth/session.ts` | Dashboard sign-in, and who counts as an admin |
| `lib/agent.ts` | A scheduled run, and the checks on what it writes |
| `lib/brief.ts` | The morning brief and the money snapshot, gathered in code |
| `lib/model.ts` | Tiered model chain: local, OpenRouter, Gemini |
| `lib/tools/` | search, mail, calendar, family calendar, proposals, lists, money, notion, jira, memory, automations and reports, goals, helpers, routines, activity, brief |
| `lib/activity.ts` | Each member's record of every change made in their name, one readable line each |
| `lib/helpers.ts` | Named helpers: the ready-made ones and their roles |
| `lib/free-time.ts` | Free time worked out from busy time, for `find_free_time` |
| `lib/recurring.ts` | Subscriptions and regular bills found in the bank feed |
| `lib/ics-parse.ts` | Reading a calendar file attached to an email |
| `lib/model-events.ts` | One row per model call, folded into the chain health on System |
| `scripts/probe-model.ts` | `npm run probe`: a real tool call against a candidate model before it joins the chain |
| `lib/providers/` | Gmail and Microsoft Graph behind one interface, and the other services |
| `lib/db/` | Drizzle schema and queries |
| `lib/crypto.ts` | AES-256-GCM for refresh tokens at rest, signing keys, MCP key tags |

## Setup

**One click**: the Deploy button above clones this repo into your own GitHub,
provisions a Neon Postgres through the Vercel Marketplace, asks for the four
bootstrap values, and deploys; migrations run inside the build, so there is
nothing to run by hand. Sign in and **/setup** walks you through the rest.
The Google OAuth client is the one real errand: create it (section 1) and add
your deployment's callback URL once you know the domain.

Only that bootstrap has to live in env vars: the database, `TOKEN_ENC_KEY`,
`ADMIN_EMAILS` and one OAuth client to sign in with. Deploy with those, sign in
with an address in `ADMIN_EMAILS`, and /setup adds the family (each by the
address they sign in with), a model provider for scheduled jobs if you want
them, and the timezone, with no redeploys. Everything below can also be seeded
through the environment: an env var for a dashboard-managed setting is read
**once**, the first time the deployment sees that setting, and copied into the
dashboard's encrypted store, which owns it from then on. The env var is never
read again and can be deleted; change the setting in Settings.

### 1. Google Cloud

Create an OAuth **Web application** client. Authorised redirect URI:

```
https://<your-deployment>/api/oauth/google/callback
```

Scopes: `gmail.modify`, `gmail.send`, `calendar.events`, `calendar.readonly`.

Publish the consent screen to **Production** and leave it unverified. Members see
a one-time "Google hasn't verified this app" warning and click through
*Advanced → continue*. This avoids Testing mode's 7-day refresh-token expiry;
verification is not required for private family use.

### 2. Azure Entra

Register an app with **Accounts in any organisational directory and personal
Microsoft accounts**. Redirect URI (Web):

```
https://<your-deployment>/api/oauth/microsoft/callback
```

Delegated permissions: `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`,
`User.Read`, `offline_access`.

Microsoft hands back a new refresh token every time one is used, each good for
90 days from its own issue, and Hearth stores each one as it arrives. A link in
use stays linked; one Microsoft stops honouring (a password change, a revoked
consent) tells the member to link it again on Connect rather than failing with
an AADSTS code.

Both clients serve two purposes through the same callback: signing in to the
dashboard, and a signed-in member linking their mailbox and calendar. They are
told apart by a `purpose` claim in the signed state, so **no extra redirect URI
has to be registered** in either console.

### 3. Services

- **Neon**: add Postgres from the Vercel Marketplace; it injects `DATABASE_URL`
  and friends into the project, and every build migrates that database itself.
  Never `db:push` to it, before the first deploy or after: push records no
  migrations, so the next build replays them all from the start and stops on
  the first column that already exists. A database pushed while this README
  still advised it is safe: migrations 0000 to 0006 skip whatever is already
  there, so its next build only records them. `drizzle.config.ts` prefers
  `DATABASE_URL_UNPOOLED` for DDL, since pgbouncer in transaction mode is a
  poor host for migrations.
- **Upstash QStash**: optional, for scheduled jobs. One recurring schedule,
  `0 * * * *`, POSTing to `https://<your-deployment>/api/tick`. Copy both
  signing keys into Settings → Scheduler (or the env). Hourly is deliberate:
  every tick wakes the Neon compute and the free plan keeps it awake for five
  minutes afterwards, so a tick every five minutes never lets it sleep. That is
  0.25 CU around the clock, 180 CU-hours a month against the 100 the free plan
  allows, after which Neon suspends the database until the next month. Hourly
  ticks cost about 16 CU-hours a month. A reminder due between ticks runs at
  the next one, so schedules belong on the hour. Hearth holds itself to this:
  it learns the tick grid from QStash's own calls (a retry of a failed one lands
  off the grid, so it counts only for a tick that left no record, and then at
  the time that tick was due), `create_automation` refuses a cron that would
  not land on a tick and offers the nearest that does, and Home marks any
  reminder already off the grid with the tick it will really run at. (Vercel
  Hobby cron is once-a-day minimum, which cannot drive reminders.)
- **Tavily**: API key, 1k credits a month free, for `web_search`.
- **OpenWeatherMap**: optional; a free key from
  [home.openweathermap.org/api_keys](https://home.openweathermap.org/api_keys)
  powers `weather` and the morning brief, cached so the free tier is never dented.
- **Google AI Studio**, **OpenRouter** or a **self-hosted** model: optional; see
  [Model chain](#model-chain).
- **Langfuse**: optional; a project's public and secret key turn on tracing of
  every model call. See [Observability](#observability).

### Model chain

Hearth needs a model of its own only for scheduled jobs: reminders, watches,
goal check-ins and jobs handed to helpers, and the checks on what they write.
Everything a member asks for goes through their own MCP client, so a deployment
with no model at all still serves every tool; only `create_automation`'s jobs
have nothing to run them.

Three tiers, tried in order, each dropping out when unconfigured. The order is
`LLM_ORDER` and is editable from **Settings** by moving tiers up and down, so
the thing you read is the thing you change. Self-hosted leads by default, being
the only tier where nothing leaves the house. OpenRouter comes next, and
Gemini's free quota covers for it.

1. `LLM_BASE_URL` + `LLM_MODEL`: a self-hosted OpenAI-compatible endpoint
2. `OPENROUTER_API_KEY` + `OPENROUTER_MODEL`
3. `GEMINI_API_KEY` + `GEMINI_MODEL`

Models are picked from what each provider actually serves rather than typed by
hand, and only tool-capable ones are offered. Before promoting a candidate,
probe it with a real tool call and a typed choice, the two things every slot
has to do:

```bash
npm run probe -- openrouter '~deepseek/deepseek-flash-latest'
```

An id starting with `~` is OpenRouter's alias for a family's newest model, so
the next DeepSeek Flash takes over without an edit. Quote it, or the shell
reads the `~` as a home directory. The probe takes the provider's key from
`.env.local`, or, when that holds the database URL and `TOKEN_ENC_KEY`, from
the dashboard's store; it only reads the store.

Each `*_MODEL` takes a comma-separated list tried left to right, so a tier can
offer a fast model first and a stronger one behind it. Put `:free` models ahead
of paid ones and the paid slot only ever answers when everything free has
failed. A rate limit, timeout, provider outage, or a model that cannot drive
tools all collapse to the same behaviour: move to the next slot. The one
exception is a run that has already done something that would double if done
again (added to a list, set up a reminder): the next slot would start from the
instruction again and do it twice, so the run ends there with a problem report
saying what was done so far. `LLM_REASONING` (none, minimal, low, medium, high)
is passed through as `reasoning_effort` when set.

**On training:** whether a provider may train on your prompts is an account
setting at `openrouter.ai/settings/privacy`, not a property of a model. With
training disabled OpenRouter simply will not route to providers that train, so
**Test** next to each model in Settings is the practical answer: one that
answers has not trained on you, one that is refused is being declined on your
behalf.

The checks are structured calls to the chain (each claim supported or not; the
draft invented anything or only says there is nothing new), asked first of the
models that have lately been returning an object. Code turns the answers into
keep or hold, so the judge is never handed a verdict to reach. A draft the claim
check has passed whole is held only on an invention the judge is sure of
(`CHAIN_POST_CONFIDENCE` in `lib/agent.ts`), and when the judge quotes the one
statement it faults, that statement is cut and the rest judged again rather than
the whole report held.

### 4. Deploy

```bash
cp .env.example .env.local        # fill in at least the bootstrap
openssl rand -hex 32              # -> TOKEN_ENC_KEY
vercel --prod                     # the build applies drizzle/ migrations itself
```

The build runs pending migrations whenever `DATABASE_URL` is present in the
environment, which is what makes the Deploy button a complete install. On
Vercel only the production build does: a preview built from an unmerged branch
shares production's database unless Neon gives each preview a branch of its
own. With a Neon branch per preview, set `MIGRATE_PREVIEWS=1` on the Preview
environment. A plain local `npm run build` finds no database and skips that
step; point a local database at the schema with `npm run db:migrate`.

Turn **Deployment Protection → Vercel Authentication** off. It is on by default
for new projects and would make MCP clients, QStash and calendar apps bounce
off an SSO redirect.

A fresh deployment, end to end: sign in with an address in `ADMIN_EMAILS`, add
yourself and the family at /setup, sign in again as yourself, make a key on Home
under **Claude and other MCP clients**, connect your client with the line shown
there, and call `hearth_context`, `list_family_events` and `money_snapshot`.

## Connecting a client

Every member connects their own client, and every client acts as that member.

**With a key** (Claude Code, Cursor, anything driven by `mcp-remote`): sign in
to the dashboard, open Home, name the key after the client under **Claude and
other MCP clients**, and **Make a key**. The key is shown once, with the line
that adds it to Claude Code:

```bash
claude mcp add --transport http hearth https://<your-deployment>/api/mcp \
  --header "Authorization: Bearer <key>"
```

Make one key per client, so each can be revoked on its own without breaking the
others. The list shows when each was made and last used; **Revoke** stops one at
once.

**With OAuth** (claude.ai's custom connectors, Claude Desktop's connectors, or
`claude mcp add --transport http hearth https://<your-deployment>/api/mcp` with
no header): the client is turned away with a pointer to the protected-resource
metadata, registers itself, and sends you to Hearth's approval page. Signed out,
you sign in first and come straight back. The page names the client as it named
itself and the address it will send you back to; say yes only to a client you
just started connecting yourself, since anyone can register under any name. A
yes hands the client a key of its own, made in your name and listed on Home with
your other keys as "<client>, via sign-in", where you revoke it like any other.

A key reads `<member id>.<random>.<tag>`, the tag an HMAC over the rest under a
key derived from `TOKEN_ENC_KEY`. A key this deployment did not mint is turned
away on its tag before anything is read, so made-up keys sent every few minutes
cannot keep the database awake. One whose tag checks must still match a stored
SHA-256 digest; only the digest is kept, so the store cannot hand a key back
out, and a revoked key, whose row is gone, stays dead. Replacing `TOKEN_ENC_KEY`
voids every key. Keys issued before keys were made on the web had the same format
and were carried over, labelled "Key from before keys were made on the web";
revoke them on Home once their clients have a new one.

A client is handed all 71 tools at once, and `hearth_context` beside them.
`hearth_context` is the first call to make: who it is acting as, the household
clock, the family and their linked accounts, the facts on file, your drafts, the
event proposals and open questions with the ids the other tools want, your goals,
the helpers and routines, and the latest reports from your scheduled jobs.

What a client has seen is its own: `new_mail` keeps markers per key, so asking
one client "any new mail?" never spends what another of your clients, your
scheduled jobs or your morning brief has not shown you. Nothing is posted
anywhere on a client's behalf: what a tool returns is for the client to pass on.

## The morning brief and the money snapshot

Both used to be scheduled posts. They are now reads a client asks for, gathered
in code so they cost no model call of Hearth's own:

- **`morning_brief`**: what is on today on the family calendar and your own
  (Google or Outlook), what starts tomorrow, what is coming over the rest of the
  fortnight (the family calendar, your calendar, your reminders and the board's
  due dates), the mail that has arrived since your last brief, anything overdue
  or due today on the board, your reminders later today, the events waiting on a
  yes, the weather, and the questions still open for the family. "Today" means
  anything on during the day, so the third day of a camp is on it too; tomorrow
  is only what starts then. The brief keeps mail markers of its own, up to 20
  messages a mailbox, and says how many more there were rather than dropping
  them. A mailbox or calendar that will not answer is listed under
  `could_not_read`, and its mail waits for the next brief. A quiet day says
  `nothing_new`. `how_to_read` says how to give it: in parts, mail sorted into
  To do and Heads up, requests a later email answered set aside, mail copied in
  to the household treated as someone else's, and calendar-worthy dates proposed.
- **`money_snapshot`**: the past seven days in, out and net with their categories
  and largest payments, the month so far against the budget, and where each
  budgeted category stands (see [Money](#money)).

Neither is pushed on a schedule any more: a member who wants one asks their client
for it, whenever suits.

## Sweeping email onto the calendar

Dates found in mail become **proposals**, never calendar entries: a person says
yes first, from a client (`accept_event_proposal`) or on Home. The brief's guide
tells a client to propose any calendar-worthy date still ahead, tagged with the
message it came from, and a scheduled job can do the same ("every weekday at 7am,
check my inbox for anything with a date in it and propose it for the family
calendar").

The same notice is never proposed twice, however many mornings it turns up or
however many clients read it. Before anything is proposed, code looks for the
proposal already standing for that occasion: the same source; the same message
on the same day, with or without the date a message holding several events adds
after a slash; or the same title on the same day (case, spacing and punctuation
aside) that is still waiting or was turned down. A match comes back as that
proposal (`already_proposed`), or as `skipped` for one already settled, and
nothing new is made. Past that, a find on a day that already holds something is
handed back with that day's events and proposals for the client to judge, since
the same occasion reaches several mailboxes under different subjects.

Accepting says what happened, in `status`:

- `added`: on the family calendar, with its event id.
- `needs_confirmation`: the same day already has something on the calendar that
  may be the same occasion, each named in `clashes` with its time, and the reason
  says so. `to_confirm` is the exact call that adds it anyway
  (`accept_event_proposal` with `confirmed_distinct: true`), and `if_same` the one
  that settles it as a duplicate. Home shows the clash and an **Add anyway** button.
- `failed`: and why: already accepted, turned down, its date passed, already on
  the calendar, or no such proposal.

An accept never leaves a proposal quietly still waiting, and the proposal is
claimed before the event is added, so two yeses cannot add it twice. A proposal
whose occasion has passed, or whose event reached the calendar another way,
drops out of every list at once, and the next tick records why.

## Jobs on a schedule, and their reports

`create_automation` sets a job up in its member's name, with read-only tools,
and says how often:

- **always**, the default: on every time its cron gives.
- **once**: a reminder or a job for later, given as a single local time (`at`)
  and kept as that very moment: a cron has no year. The claim that starts its
  run switches it off, and once it has had its run it leaves the list.
- **until**: on a schedule until it finds what it is waiting for. "Let me know
  when the school emails the camp dates" checks hourly, says nothing while there
  is nothing, and once it reports, the report says it has stopped and the job
  leaves the list.

Nothing is posted anywhere. What a run finds is kept as a **report** for the
member who set it up: `hearth_context` carries the last three days' newest few,
`list_reports` reads back thirty days, and Home lists them. A report is one of:

- **found this**: what the job wrote, through both checks, perhaps with a note
  (a statement cut, the checks unavailable, the output allowance cutting its end);
- **held back by the checks**: the unchecked draft, marked, with why;
- **ran into a problem**: what went wrong, from the job's own PROBLEM line or a
  failure. A mailbox held at the same place for three runs and twelve hours is
  moved past, and a report says which span was skipped.

What a job read counts as seen only once a report is kept or it deliberately kept
none. A run that fails leaves the mail new, so the next run tries again; one that
wrote something it cannot take back on the strength of it (a list item) spends it
whatever happened. Each job keeps its own markers for what is new, so an hourly
watch over the mail never spends what your brief or your clients are there to show.

A job runs as its author: their mailbox alone. An author revoked or removed takes
their jobs with them: they are paused before they run again. Home marks each job
with **once** or **until it happens**, and every member pauses, resumes or
deletes their own there.

## What it remembers

The household keeps facts: routines, allergies, who goes where, sizes, standing
arrangements. A member's client files one when asked ("remember that bin night is
Monday") with `remember`, corrects one by passing the old id, and retires one with
`forget`. A rewording of a fact already on file is turned away at write time.

When a fact would be worth keeping but nobody has said who it is about, or it
rests on a notice, bill or email rather than on a person, a client puts it to the
family with `unsure` instead of guessing. The next morning brief asks it once,
Home lists it until it is answered, and any member can answer from a client
(`answer_question`) or on Home. A yes keeps the fact in their words, a correction
keeps the corrected version, a no keeps nothing. A yes that changes only a number
or a "not" in a Known fact retires the old one, so the two do not both stand.

Scheduled jobs read the same facts. A standing instruction remembered earlier,
such as leaving one sender's mail out, holds for every job. Home lists what is
remembered with a Forget for each; forgetting is soft, so a fact can be brought
back by hand.

## Goals

Some things take weeks: a trip to save for, a birthday party, a house to ready for
sale. `create_goal` keeps one: what done looks like, the date it is meant for, and
its plan as steps of its own, ticked off from a client or on Home, never one of the
household's shared lists. A check-in is set up beside it, Sunday at 7pm unless asked
otherwise: an ordinary scheduled job that reads the goal with `goal_status` and
reports the progress, the next open step and the days left, ending with one question
that would move it forward. Done or dropped closes it and removes its check-in;
reopening one sets the check-in up again.

A goal is its owner's alone: another member's client never sees it, and Home shows
it to its owner only.

## Helpers

A helper is a specialist role: Chef for meals, Treasurer for the money, Planner for
the calendars, Researcher for finding things out, Secretary for turning meeting
notes into a recap, Coach for goals. Those six come ready to add by name alone
("add the Chef helper"); any other needs a role, written as its standing
instructions. `hand_off` gives a helper a job to do in the background: research to
look into, a week of dinners to plan. It runs at the next tick unless a time is
given, as that helper, with read-only tools and both checks, and its report carries
the helper's name. Asked to talk to a helper by name, a client takes its role up
itself; `hearth_context` lists each with its role. A helper cannot be given a family
member's name, or Hearth's own. Removing one leaves the jobs already handed to it to
Hearth itself.

## Routines

Something the household does the same way each time is taught once and run by name.
`save_routine` writes the steps down as instructions, with the lists, people and
details that make them repeatable; saving under a name already kept replaces its
steps. `run_routine` hands the steps back to the caller, which carries them out with
its own tools. A routine can run on a schedule too ("every Sunday at 5pm do the
Sunday reset"), where it gets a scheduled run's read-only tools: anything that would
need a yes is drafted or proposed, never done.

## Shared lists

Lists are created on first mention and addressed by name, so "packing list" and
"hardware list" work without setup. Ticking off matches on substring, so "milk"
ticks off "2L milk". `clear_list` removes only the ticked items unless told
otherwise, which is the usual tidy-up after a shop. Home shows everything still to
get and the ten most recently added ticked items; the rest are a click away.

## Recipes

`read_recipe` reads the recipe most recipe sites publish in a standard form
(schema.org's Recipe, in the page's JSON-LD): its name, what it serves, how long it
takes, the ingredients exactly as written and the method, without the life story
above it. A page without one says so, and `read_url` reads it as a page instead.

## Money

One optional integration, read-only and household-wide: **PocketSmith**
(`POCKETSMITH_DEVELOPER_KEY`), the categorised view across every account connected
there, plus budgets. It is the only bank feed.

`list_transactions` lists them one by one, each with what the household wrote on it
in PocketSmith (its note, memo and labels), and a search finds a word in any of those
as well as in the payee, category or account. Spending summaries **exclude
transfers**, and spend is reckoned the way PocketSmith reckons it, by the side of the
ledger each category keeps: a payment filed under an income category (a tax payment,
say) is a deduction from income, never spend. Either follows every page of the
range, up to 5,000 transactions, and says so when a range holds more.

**Budgets.** PocketSmith's allowance for a month is the budget *after rollover*, so a
category overspent earlier in the year can be allowed $0 this month while still being
budgeted. `budget_summary` names three states exactly, and never confuses them:

- **no budget set**: the category has no budget at all;
- **nothing left after rollover**: budgeted, with an allowance of $0 this month. Never
  called "no budget set", and never listed as overspent on its own, whatever
  PocketSmith counts as over a zero;
- **over by $X**: an allowance above $0, spent past.

Each category's position says which, and the result lists `over_budget`,
`nothing_left_after_rollover` and `no_budget_set` together, worked out in code.

### Subscriptions and bills

`recurring_payments` finds them in the feed in code, never by a model's reading of a
list: a payee paid again and again a steady distance apart (weekly, fortnightly,
monthly, quarterly or yearly), three payments at least, two for a quarterly or yearly
one. Each comes with how often, what it usually costs and comes to a month, when the
next is due, a price change at its last payment, new in the month it is first seen,
and overdue once its next payment is late by half an interval. The monthly total is
added up in code.

## Finding a time

`find_free_time` reads your own linked calendars and the family calendar, and gives
the stretches free for long enough within the hours and days asked (8am to 8pm, any
day, unless told otherwise). The gaps are worked out in code from the busy times, so
overlaps are never missed and no free afternoon is invented. All-day entries do not
block time; they are listed by day so they can be weighed. Another member's calendar
is never read.

## Notion

`NOTION_TOKEN` is an internal integration token from
[notion.so/my-integrations](https://www.notion.so/my-integrations).

**The token grants nothing on its own.** Every page and database has to be shared
with the integration by hand, in Notion, under the page's `⋯` menu → Connections.
Anything unshared returns an *empty result* rather than an error, so the tools say
as much when a search comes back empty.

The API version is pinned to `2025-09-03`. That release split a database into a
container plus one or more data sources, so queries address a `data_source_id`,
which is why `notion_query_database` resolves a name to a data source first. Bumping
the version is a breaking change, not an upgrade. Writes are **additive only**: the
client can append paragraphs to a page and has no way to edit or delete anything.

## Jira

The household board, for the jobs that need tracking rather than a shopping list:
rates, renewals, tax, repairs.

**Use a plain API token, not a scoped one.** At
[id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens),
"Create API token" works against `JIRA_BASE_URL` with basic auth. "Create API token
**with scopes**" does not: a scoped token returns 401 against the site URL, which
looks exactly like a wrong password.

Issues can be created, changed, moved between statuses and commented on, and an
email's attachment copied onto one (`jira_attach_email_file`). There is **no
delete**: no tool exposes it and the client has no code path for it. Moving an
issue goes through Jira's transitions, so an unreachable target reports what *is*
reachable from where the issue sits. Free-text search terms are escaped before they
reach JQL, so a quote cannot rewrite the query or reach another project.

## What it changed

Every write a tool makes that goes through is kept as one line a person can read, on
the record of the member it was done for, with how it was asked for: through an MCP
client, on Home, or by one of their scheduled jobs. A write that failed, or that
changed nothing after all (a proposal already standing, an accept waiting on a
confirmation, a fact already known), is not kept, and a record that cannot be written
never fails the call that made the change.

`recent_activity` answers "what have you done today?" or "did you put the dentist
in?" from the record rather than from anyone's memory of the conversation. Each
member sees their own record, never another's, on Home and from their clients. The
record keeps ninety days.

## The web dashboard

The site root is a sign-in screen (Google or Microsoft), then **Home**: anything
waiting on a yes (your own email drafts, with Send and Discard, and the event
proposals any member can settle), your reports, the month calendar, your goals, next
up, your reminders, the shared lists, what is remembered and the questions still
open, the helpers, what was changed in your name lately, and your MCP keys. Home is
not read-only: everything on it is something you could ask a client to do, one click
closer.

**Connect** is where a signed-in member links their Google or Microsoft account, makes
one read-only (read, never draft, send or add events through it) or unlinks it, and
finds the family calendar's subscription address. Linking acts for whoever is signed
in, never for whoever a link was sent to, and an account the household already knows
as another member's is turned away. Signing in also completes the link whenever the
provider hands back a refresh token, though it only fills a gap or refreshes the same
address, never repointing a link at a different account.

An address is recognised if it is in `ADMIN_EMAILS`, or an admin recorded it against a
member, or that member linked a mailbox with it. Admin members get **System** and
**Settings** as well; an admin landing on a deployment with nobody in the family yet
is sent to **/setup**. The check happens on every request, not only at sign-in: the
session cookie only says who signed in, so a revoke or a demotion takes effect on the
next click. **Sign everyone out** on Settings ends every session at once and voids
every account link under way. Sessions, OAuth state, MCP key tags and the MCP OAuth
flow are each signed with their own key, derived from `TOKEN_ENC_KEY`.

Admins manage the family on Settings: add someone by name and the address they sign in
with, change an address, allow, revoke, promote or remove. Adding an address already
in the family renames that person and changes only what was filled in. The **last
admin cannot be revoked, demoted or removed**, only succeeded, so the house cannot
lock itself out. Removing someone takes their keys, links and drafts with them, and
pauses their scheduled jobs.

System shows the chain's health over a week (per slot: how many calls it answered and
how quickly, how many times it was skipped and why), which models ran the scheduled
jobs, what was changed each day of the fortnight and how, every MCP key with whose it
is and when it was last used, every reminder with its owner and schedule, and **Last
tick**: when QStash last called the scheduler, flagged once three of its intervals
have passed without one.

Settings groups fold to a line each, showing live dots, how many keys are set and the
values that are safe to show. Editable settings are a **fixed allowlist**:
`DATABASE_URL`, `TOKEN_ENC_KEY` and `ADMIN_EMAILS` are deliberately not on it, so a
stolen session cannot repoint the deployment at another database or lock the owner
out. Stored values are AES-256-GCM encrypted and are **never sent back to the
browser** for credential-shaped keys. The store is read at the start of every request,
on every instance, so a change applies to the next call or tick. The tick, the
calendar feed and `/api/mcp` check a caller against what the instance already holds
before reading the store or the database, so someone fetching junk every few minutes
cannot keep the database awake and run out the free plan's compute hours.

## Observability

With `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` set, every
model call is traced to Langfuse: the prompt and reply, each tool call and its result,
tokens, timing, and the checks on each scheduled report with their confidence. Each
scheduled run is a trace of its own, `hearth.watcher`, and the calls inside it (the
claim check, the keep-or-hold decision) nest under it rather than renaming it. The
root of a run says what it was given and what came of it: its input is the
instruction, facts and tool results its checks judged the draft against, its output
what was kept or the draft held back, and its metadata the outcome (`kept`, `held
back`, `skipped`, `not run`, `failed`), the decision and its confidence, and how many
claims were checked. Tracing is registered once at server start from
`instrumentation.ts` and is inert without the keys.

Traces carry the family's mail; set `LANGFUSE_RECORD_CONTENT=off` to keep only the
shape of each call. The keys are environment variables, not dashboard settings,
because the tracer starts before the database is read. The integration is built for
Langfuse v4 (`@langfuse/otel` 5.4 or later, 5.13 installed); `tests/langfuse-v4.test.ts`
guards that contract, down to every model call in the code sitting inside `traced()`.

An LLM-as-a-judge rule in Langfuse ("Groundedness of scheduled reports") can score
runs against their evidence: target the root observation of `hearth.watcher` traces
whose metadata `draft` is `yes`. A trace scored *Not grounded* is the next case for
`evals/`.

## Safety properties

- **Authorisation is per person.** `/api/mcp` accepts only a bearer key it can match
  to an allowed member; the dashboard only a session whose address belongs to one. A
  deployment with nobody in the family accepts nothing but the `ADMIN_EMAILS`
  bootstrap, and that only on the dashboard.
- **A key is its member.** Every call runs as whoever holds it: their mailbox and
  never another member's, their calendar, their name on what it writes. Keys are
  stored as SHA-256 digests; each carries an HMAC tag that is checked before the
  lookup, so a made-up one costs no database read. A revoked key's row is gone, so it
  never matches again; a member who is revoked or removed takes every key with them.
- **One member's things stay theirs.** Mail, personal calendars, drafts, goals,
  reminders, reports and the record of changes are each member's own: no tool, client
  or page reads another member's. The family calendar, lists, facts, proposals,
  helpers and routines are the household's.
- **OAuth for MCP clients** is PKCE (S256) only, for public clients; a client's
  registration, the approval it asks for and each code are signed tokens, a code is
  good for five minutes and one use, bound to its client, redirect and challenge, and
  the approval page names the client and where it will send the member, refuses to be
  framed, and needs a signed-in member. A malformed request is shown on Hearth's own
  page rather than sent back to a redirect anyone could have registered; only the
  member's own yes or no sends them back. A redirect is https, or http to this machine
  for a native client, or a native app's own scheme; never one that runs in the browser.
- **OAuth `state`** for sign-in and linking is a 10-minute signed JWT, and each
  consumer says which purpose it takes: the sign-in state anyone can ask for never
  passes as a member's link, and a link acts only for the member whose session asked
  for it. An address in `ADMIN_EMAILS` counts as an admin's even with no row naming
  its owner, so only an admin, or the member an admin recorded it against, may link it.
- A member decides what Hearth may do with each account they link: read it and write
  from it, or read it alone. A read-only account takes no draft and no calendar entry,
  and sends nothing even from a draft written before it was made read-only.
- Refresh tokens are AES-256-GCM encrypted with `TOKEN_ENC_KEY`.
- The ICS feed sits behind a long random token, compared without early exit. An admin
  can replace it if the URL gets out; everyone subscribed then subscribes again.
- `/api/tick` verifies the QStash signature.
- Email is never sent without a human "yes": `draft_email` and `send_email` are
  separate tools, the draft is persisted, and the send claims it atomically so a
  repeated confirmation cannot send twice. A send that times out stays claimed, since
  it may have gone. Over MCP each call stands alone, so the client's own approval of
  each tool call is the gate; on Home the yes is the writer's own click on Send.
- Nothing that runs unattended can do what would need a yes. Scheduled jobs (handed to
  a helper, a goal's check-in, a watch-until, a routine on a schedule) get read-only
  tools (adding to a list and proposing an event aside), their author's mailbox alone,
  and every report goes through the claim check and the decision.
- Once a scheduled run has read anything from outside the household, `read_url` (and
  `read_recipe`) opens only a link that appears, as written, in something the run was
  given or read, and not one the model had put into a tool call first, so it requests
  no address composed in that run to carry the household's details out.

## Development

### Evals

`npm run evals` runs scheduled-run prompts against the live model chain with recorded
tool results, and scores the reports two ways: deterministic checks (every dollar
figure appears in what the tools returned, no trip read into a payee string, no
working shown) and an LLM judge for groundedness. It also puts drafts to the claim
check and the decision. The judge defaults to the last Gemini slot so it is not from
the family under test; `EVAL_JUDGE_MODEL=provider:model` overrides it. Judge scores
are reported and only fail the run with `EVAL_STRICT=1`. It spends quota, so it is not
part of `npm test` or CI.

```bash
npm run dev           # http://localhost:3000
npm test              # vitest
npm run test:coverage # vitest + coverage, thresholds at 98% (lines 98.5%, branches 96.5%)
npm run typecheck
npm run db:generate   # after editing lib/db/schema.ts; CI fails without it
```

Query-layer tests run against a real Postgres, in process, via PGlite. The harness in
`tests/helpers/db.ts` builds one database per test file with drizzle's migrator, the
one the deploy runs, so the migrations in `drizzle/` go in as they will in production.
Constraints, defaults and the claim-by-predicate updates that stop double-sends behave
exactly as they do on Neon. `lib/db/index.ts` exposes `__setDb` purely so that
instance can be swapped in.

To try a client against a local server, run `npm run dev`, sign in, make a key on Home
and point the client at `http://localhost:3000/api/mcp`.

## Licence

MIT
