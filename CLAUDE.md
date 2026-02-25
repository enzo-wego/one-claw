# CLAUDE.md

## Project Overview

EnzoBot — a Slack bot powered by Claude. Provides DM chat, daily channel summaries, PagerDuty/Airflow alert investigation, and @mention-triggered persistent CLI sessions in any channel.

## Tech Stack

- **Runtime:** Node.js 22+, TypeScript (ES2022 modules)
- **Slack:** `@slack/bolt` with Socket Mode
- **AI:** `@anthropic-ai/claude-agent-sdk` (Agent SDK `query()`) + Claude CLI child processes
- **Database:** SQLite via `better-sqlite3`
- **Build:** `tsx` for dev, `tsc` for type checking

## Project Structure

```
src/
  index.ts           — Entry point, Slack app init, scheduling
  config.ts          — All env var parsing (required() / csvList() / channelList())
  server.ts          — HTTP server: /health, /daily-summary, / (status page)
  handlers/          — Slack message event handlers
    message.ts       — DM one-shot CLI + channel @mention discuss sessions
    alert-monitor.ts — Detects PagerDuty messages, triggers alert workflows
    delay-alert-monitor.ts — Counts Airflow alerts, triggers on threshold
  services/          — Business logic
    agent.ts         — Agent SDK query() wrapper for DM chat
    daily-summary.ts — Agent SDK query() with Slack MCP for summaries
    claude-cli.ts    — Spawns `claude` CLI child processes (alert/discuss)
    alert-workflow.ts      — PagerDuty investigation lifecycle
    delay-alert-workflow.ts — Airflow delay investigation lifecycle
    discuss-workflow.ts    — Discuss sessions (start/reply/compact/exit)
    database.ts      — SQLite schema + CRUD (sessions, messages)
    session.ts       — In-memory processing locks
    pagerduty.ts     — PD incident acknowledgement HTTP API
    mcp-config.ts    — Detects disabled MCP servers, writes override JSON
```

## Build & Run

```bash
npm install          # Install deps
npm run dev          # Dev mode (tsx, foreground)
npm start            # Daemon mode via ./enzo start
npm stop             # Stop daemon
npx tsc --noEmit     # Type check only (no emit, outDir is dist/)
```

## Key Patterns

- **Two AI integration modes:**
  1. `query()` from `@anthropic-ai/claude-agent-sdk` — used for daily summaries (`daily-summary.ts`). Streams async iterator of JSON messages.
  2. `claude` CLI child process — used for DM chat, channel @mention sessions, and alert investigation (`claude-cli.ts`). Spawns `claude` with `--output-format stream-json` and parses stdout.

- **Owner-only:** All bot interactions are restricted to `OWNER_USER_ID`. Non-owners get a polite decline.

- **Channel lists:** `channelList()` supports `!` prefix to disable channels (e.g., `alerts,!incidents`). `csvList()` for simple comma-separated lists.

- **DMs:** One-shot Claude CLI — no session tracking, no SQLite.

- **@mention sessions:** `@EnzoBot` in any channel starts a persistent Claude CLI session in that thread. Thread context from other users is fetched and prepended to prompts. `!compact` and `!exit` commands work via @mention. Sessions are tracked in-memory via `discuss-workflow.ts`.

- **Graceful shutdown:** SIGTERM/SIGINT kills all active CLI children, stops Slack, closes HTTP server, closes database.

- **Daily restart:** Configurable hour (default 23:00) — `process.exit(0)` for the `./start.sh` loop or external supervisor to restart.

## Conventions

- ESM only (`"type": "module"` in package.json, `.js` extensions in imports)
- Strict TypeScript
- No test framework currently — type check with `npx tsc --noEmit`
- Environment config centralized in `config.ts` — never read `process.env` directly elsewhere
- Console logging with prefixes: `[DailySummary]`, `[AlertWorkflow]`, `[Discuss]`, `[ClaudeCLI]`, etc.
- Slack message handlers registered via `app.message()` — each handler filters by channel ID

## Important Notes

- `daily-summary.ts` uses `settingSources: ['user', 'project', 'local']` so the Agent SDK subprocess loads MCP server configs (especially Slack MCP for reading channels)
- `claude-cli.ts` processes use `--dangerously-skip-permissions` and optionally `--mcp-config` for force-enabling disabled MCP servers
- The bot auto-restarts daily at `DAILY_RESTART_HOUR` — design expects an external process manager (start.sh loop, systemd, etc.)
- SQLite database at `./data/bot.db` — WAL mode, foreign keys enabled
