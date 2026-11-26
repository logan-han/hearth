<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Hearth, for coding agents

Hearth is a self-hosted family assistant reached only through MCP (`/api/mcp`) and a web
dashboard. There is no chat front end: nothing is posted anywhere. The README is the full
account; this is what to keep in mind while changing code.

- **Who a call is.** Every MCP request carries a bearer key, `<member id>.<random>.<tag>`
  (`lib/crypto.ts`), checked on its HMAC tag before any read, then against the SHA-256 in
  `mcp_keys` (`memberByMcpKey`). Members make, list and revoke keys on Home
  (`app/api/mcp-keys/route.ts`); an OAuth 2.1 client gets the same kind of key through
  `lib/oauth/server.ts` (PKCE, dynamic registration, signed codes). Tools run as that
  member: `ToolContext.member`, `via: 'mcp'`.
- **Connecting a client by hand:**
  `claude mcp add --transport http hearth https://<deployment>/api/mcp --header "Authorization: Bearer <key>"`.
- **What is whose.** Personal calendars, goals, automations, reports and activity are
  per member; never read another member's. The family calendar, lists, facts,
  proposals, helpers and routines are household-wide.
- **The morning brief and money snapshot** are on-demand MCP reads (`morning_brief`,
  `money_snapshot` in `lib/tools/brief.ts`, gathered in `lib/brief.ts`), not scheduled posts.
- **No mail.** Hearth reads and sends none, for Gmail or Outlook: members' clients reach
  their mail directly. A member's Google Calendar goes through Google's Calendar MCP server
  (`lib/providers/google-mcp.ts`), with a token from the agent OAuth client
  (`GOOGLE_AGENT_CLIENT_ID`); dashboard sign-in has a Google client of its own.
- **Scheduled jobs** (`create_automation`, `hand_off`, goal check-ins) run on the hourly
  tick (`app/api/tick/route.ts`) through the model chain with read-only tools, pass the
  claim check and the keep-or-hold decision (`lib/agent.ts`), and end as rows in
  `automation_reports` for their author. Nothing unattended may do what needs a yes.
- **Every write tool** that changes something is recorded on its member's activity record
  by `instrument()` in `lib/tools/index.ts`; a result that changed nothing must say so
  (`already_proposed`, `skipped`, `status: 'needs_confirmation'`, ...).
- **Schema changes:** edit `lib/db/schema.ts`, then `npm run db:generate`. drizzle-kit asks
  about renames when a table or column is added and another dropped in one pass and cannot
  ask without a terminal, so generate additions and drops in separate passes. Data moves go
  into the generated SQL by hand. Never `db:push` a database a build migrates.
- **Tests:** `npm test` (vitest, PGlite for the query layer), `npm run typecheck`, and
  `bash scripts/check-migrations.sh`. Coverage thresholds are enforced in CI.
- Write comments and copy in Australian English, and explain a constraint that stays true;
  reasoning about a change belongs in the commit, not the code.
