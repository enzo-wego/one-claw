# EnzoBot

A Slack bot powered by Claude that provides DM chat, daily channel summaries, PagerDuty alert investigation, Airflow delay monitoring, and interactive discuss channels.

## Prerequisites

- Node.js 22+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on PATH)
- A Slack app with Socket Mode enabled, plus bot and app-level tokens
- (Optional) PagerDuty API token for alert acknowledgement

## Setup

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your Slack tokens, owner user ID, channels, etc.
```

### Required Slack App Scopes

**Bot Token Scopes:** `chat:write`, `channels:history`, `channels:read`, `im:history`, `im:read`, `im:write`, `users:read`

**App-Level Token:** Socket Mode must be enabled. Generate an app-level token with `connections:write` scope.

## Usage

### Service manager (`./enzo`)

```bash
# Start as background daemon (logs to data/enzo.log)
npm start          # or: ./enzo start

# Stop the daemon
npm stop           # or: ./enzo stop

# Restart
npm run restart    # or: ./enzo restart

# Check status + health endpoint
npm run status     # or: ./enzo status

# Tail live logs
npm run logs       # or: ./enzo logs
```

### Development mode (foreground with auto-reload)

```bash
npm run dev
```

### Auto-restart wrapper

```bash
./start.sh
```

Runs the bot in a loop, restarting automatically on exit (useful for supervised deployments).

## Features

### 1. DM Chat

DM the bot to have a conversation with Claude. Only the configured `OWNER_USER_ID` gets responses. Sessions are tracked per-thread with conversation history stored in SQLite.

**Commands (in DM):**
- `!new` — Archive current session, start fresh
- `!resume <session_id>` — Resume a previous session

### 2. Daily Summary

Scheduled channel summaries delivered as a DM. Uses Claude Agent SDK with Slack MCP tools to read channels and produce a summary.

- Schedule: `DAILY_SUMMARY_TIME` (default `07:00`)
- Channels: `DAILY_SUMMARY_CHANNELS` (comma-separated)
- Manual trigger: `POST http://localhost:3000/daily-summary`

### 3. PagerDuty Alert Monitor

Watches configured channels for PagerDuty messages. When detected:

1. Auto-acknowledges the PD incident via API
2. Spawns a Claude CLI process to investigate using a configurable skill (default: `one:pay-ops-production`)
3. Owner can reply in the thread for follow-up investigation
4. Auto-cleans up after feedback timeout

Configure: `MONITOR_CHANNELS`, `ALERT_SKILL`, `ALERT_MODEL`, `PAGERDUTY_API_TOKEN`

### 4. Airflow Delay Alert Monitor

Watches channels for Airflow task delay alerts. Counts occurrences within a time window and triggers investigation when threshold is reached.

- Matches task name patterns: `DELAY_ALERT_TASK_PATTERNS`
- Threshold: `DELAY_ALERT_THRESHOLD` (default: 3 within 1 hour)
- Skill: `DELAY_ALERT_SKILL` (default: `one:pay-ops-tax-production`)

Configure: `MONITOR_DELAY_CHANNELS`, `DELAY_ALERT_TASK_PATTERNS`, `DELAY_ALERT_THRESHOLD`

### 5. Discuss Channels

Designate channels where owner messages are proxied to persistent Claude CLI sessions. Each top-level message starts a new session; thread replies continue it.

**Thread commands:**
- `!compact` — Compact the CLI session context when it gets large
- `!exit` — End the session

Configure: `DISCUSS_CHANNELS`, `DISCUSS_MODEL`

## HTTP Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Status page (HTML) |
| `/health` | GET | Health check (JSON): uptime, Slack connection, active sessions |
| `/daily-summary` | POST | Manually trigger daily summary |

## Configuration

All configuration is via environment variables (`.env` file). See `.env.example` for the full reference with descriptions.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | — | `xoxb-...` bot token |
| `SLACK_APP_TOKEN` | Yes | — | `xapp-...` app-level token |
| `SLACK_SIGNING_SECRET` | Yes | — | Slack signing secret |
| `OWNER_USER_ID` | Yes | — | Slack user ID of the bot owner |
| `DATABASE_PATH` | No | `./data/bot.db` | SQLite database path |
| `PORT` | No | `3000` | HTTP server port |
| `AGENT_MODEL` | No | `sonnet` | Claude model for DM chat |
| `DAILY_RESTART_HOUR` | No | `23` | Hour (0-23) to auto-restart |
| `DAILY_SUMMARY_CHANNELS` | No | — | Comma-separated channel names |
| `DAILY_SUMMARY_TIME` | No | `07:00` | Schedule time (HH:MM, local) |
| `DAILY_SUMMARY_MODEL` | No | `sonnet` | Model for summaries |
| `MONITOR_CHANNELS` | No | — | PagerDuty alert channels (prefix `!` to disable) |
| `ALERT_SKILL` | No | `one:pay-ops-production` | Skill invoked for PD alerts |
| `ALERT_MODEL` | No | `claude-opus-4-6` | Model for alert investigation |
| `PAGERDUTY_API_TOKEN` | No | — | PagerDuty API token |
| `PAGERDUTY_FROM_EMAIL` | No | — | PagerDuty "From" email |
| `MONITOR_DELAY_CHANNELS` | No | — | Airflow delay channels (prefix `!` to disable) |
| `DELAY_ALERT_TASK_PATTERNS` | No | — | Task name patterns (CSV) |
| `DELAY_ALERT_THRESHOLD` | No | `3` | Alert count before triggering |
| `DELAY_ALERT_WINDOW_MS` | No | `3600000` | Time window (ms) |
| `DELAY_ALERT_SKILL` | No | `one:pay-ops-tax-production` | Skill for delay alerts |
| `DISCUSS_CHANNELS` | No | — | Discuss channel names (CSV) |
| `DISCUSS_MODEL` | No | `claude-sonnet-4-5-20250929` | Model for discuss sessions |
| `PAYMENTS_REPO_PATH` | No | `~/go/src/github.com/payments` | Working directory for CLI processes |
| `REQUIRED_MCP_SERVERS` | No | `chrome-devtools,athena` | MCP servers to force-enable |

## Architecture

```
src/
  index.ts              # Entry point: Slack app init, scheduling, shutdown
  config.ts             # Environment variable parsing
  server.ts             # HTTP server (health, daily summary trigger)
  handlers/
    message.ts          # DM chat handler (owner-only, session management)
    alert-monitor.ts    # PagerDuty message detection + workflow trigger
    delay-alert-monitor.ts  # Airflow task alert counting + threshold trigger
    discuss-monitor.ts  # Discuss channel routing + thread commands
  services/
    agent.ts            # Claude Agent SDK wrapper for DM chat
    daily-summary.ts    # Daily summary via Agent SDK + Slack MCP
    claude-cli.ts       # Claude CLI child process spawner
    alert-workflow.ts   # PagerDuty alert investigation lifecycle
    delay-alert-workflow.ts  # Airflow delay investigation lifecycle
    discuss-workflow.ts # Discuss session lifecycle (start/reply/compact/exit)
    database.ts         # SQLite (sessions + messages)
    session.ts          # In-memory processing locks
    pagerduty.ts        # PagerDuty incident acknowledgement API
    mcp-config.ts       # MCP server override detection
```

## Data

- **SQLite database:** `./data/bot.db` (sessions and message history)
- **Logs:** `./data/enzo.log` (when running via `./enzo start`)
- **PID file:** `.enzo.pid` (managed by `./enzo`)
