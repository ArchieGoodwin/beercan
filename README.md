# 🍺 BeerCan

Autonomous AI agent system — powered by Skippy the Magnificent.

Sandboxed projects, multi-agent pipelines with dynamic team composition, 4-layer hybrid RAG memory, conversational chat interface (terminal, Telegram, Slack, WebSocket), REST API with auth, and a magnificently sarcastic AI overlord.

## Install

```bash
npm install -g beercan
```

Requires Node.js 18+ and an [Anthropic API key](https://console.anthropic.com/).

## Quick Start

```bash
# Set up your API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# Create a project scoped to a directory
beercan init my-project --work-dir ~/projects/my-project

# Run a task (gatekeeper auto-picks the right team)
beercan run my-project "Create a hello world Express server with TypeScript"

# View results
beercan history my-project
beercan result <bloop-id>
beercan status
```

## Chat with Skippy

```bash
# Interactive terminal chat (Skippy manages everything)
beercan chat

# Scoped to a project
beercan chat my-project
```

```
🍺 Skippy the Magnificent
  Elder AI | Beer Can | Your intellectual superior

skippy> create a project for my-api at ~/work/my-api
Project my-api created. Another domain under my glorious rule.

skippy> analyze the codebase for bugs
▸ Phase: plan (planner)
⚙ read_file • list_directory
▸ Phase: review (reviewer)
✦ APPROVE
✓ Bloop completed — 8,421 tokens

skippy> /status
Skippy's Magnificent Status Report
Uptime: 2h 15m | Projects: 3 | Running: 1
```

Natural language or slash commands — Skippy understands both.

## What It Does

You describe a goal. BeerCan figures out the rest:

1. **Gatekeeper** analyzes the goal and dynamically composes the right team
2. **Agents** execute the work — coding, writing, research, analysis, whatever
3. **Reviewers** check quality and can send work back for revision
4. **Memory** persists knowledge across bloops for future context

```
$ beercan run my-project "Add OAuth2 login with Google provider"

▸ gatekeeper (auto)
  Gatekeeper Plan [medium]: Coding task with auth integration...
  Roles: Planner (plan) → Coder (primary) → Reviewer (review) → Tester (validate)

▸ Phase: plan (planner)
  [planner] Breaking down into 3 tasks...

▸ Phase: primary (coder)
  ⚙ read_file  src/auth/...
  ⚙ write_file src/auth/oauth2.ts
  ⚙ exec_command npm run build

▸ Phase: review (reviewer)
  ✦ APPROVE

✓ Bloop completed — 12,847 tokens, 3 iterations
```

## Teams

| Team | Pipeline | Best For |
|------|----------|----------|
| `auto` (default) | Gatekeeper picks | Any task |
| `solo` | One agent | Simple tasks |
| `code_review` | Coder → Reviewer | Code with quality checks |
| `managed` | Manager → Coder → Manager | Planned execution |
| `full_team` | Manager → Coder → Reviewer → Tester | Production code |

## 14 Dynamic Roles

**5 built-in:** manager, coder, reviewer, tester, solo

**9 templates** (gatekeeper picks as needed): writer, researcher, analyst, data_processor, summarizer, planner, editor, devops, architect

The gatekeeper can also invent custom roles with LLM-generated prompts for unusual tasks.

## 13 Built-in Tools

| Category | Tools |
|----------|-------|
| Filesystem | `read_file`, `write_file`, `list_directory`, `exec_command` |
| Web | `web_fetch` (Cloudflare Browser Rendering + native), `http_request` |
| Notification | `send_notification` (macOS desktop) |
| Memory | `memory_search`, `memory_store`, `memory_update`, `memory_link`, `memory_query_graph`, `memory_scratch` |

Plus any tools from MCP servers you connect.

## Memory System

4-layer hybrid RAG — all in SQLite:

- **FTS5** — BM25 keyword search on all stored memories
- **sqlite-vec** — 512-dim TF-IDF vector embeddings for semantic search
- **Knowledge Graph** — entities and relationships with multi-hop BFS traversal
- **Working Memory** — per-bloop ephemeral scratchpad

Search results are merged via Reciprocal Rank Fusion. Agents can store facts, decisions, and insights that persist across bloops.

## Job Queue

SQLite-backed with concurrency control. Scheduler and event triggers route through the queue automatically.

```bash
beercan jobs              # View queue status
```

## Daemon Mode

Run as an always-on service with cron scheduling and event triggers:

```bash
beercan daemon
```

- Webhook server on port 3939
- Filesystem watchers
- Cron-based scheduling
- Graceful shutdown with job queue drain

## REST API

Submit tasks, monitor jobs, and control bloops via HTTP:

```bash
# Start API server
beercan serve

# Submit a task
curl -X POST http://localhost:3939/api/bloops \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BEERCAN_API_KEY" \
  -d '{"projectSlug": "my-project", "goal": "Refactor auth module"}'

# Check status
curl http://localhost:3939/api/status

# Cancel a job
curl -X DELETE http://localhost:3939/api/jobs/<job-id>
```

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | System overview |
| `GET /api/projects` | All projects with stats |
| `POST /api/bloops` | Submit a new task |
| `GET /api/bloops/recent` | Recent bloops |
| `GET /api/bloops/:id` | Bloop detail |
| `GET /api/jobs` | Job queue |
| `DELETE /api/jobs/:id` | Cancel a job |
| `GET /api/schedules` | Schedules |

## Chat Providers

BeerCan's conversational interface is provider-agnostic:

| Provider | Setup | Description |
|----------|-------|-------------|
| Terminal | `beercan chat` | Interactive REPL |
| Telegram | Set `BEERCAN_TELEGRAM_TOKEN` | Bot auto-starts in daemon |
| Slack | Set `BEERCAN_SLACK_TOKEN` + `BEERCAN_SLACK_SIGNING_SECRET` | Socket mode bot |
| WebSocket | `ws://localhost:3940` | Generic JSON protocol |

All providers share the same ChatBridge — slash commands and natural language work everywhere.

## Production Features

- **Crash recovery** — stale "running" jobs auto-recovered on startup
- **Timeout enforcement** — `BEERCAN_BLOOP_TIMEOUT_MS` kills stuck bloops (default 10min)
- **Job cancellation** — cancel pending or abort running jobs via API
- **API key auth** — `BEERCAN_API_KEY` secures all endpoints
- **Rate limiting** — per-IP sliding window on all requests
- **Auto-notifications** — desktop notifications + webhook callbacks on completion/failure
- **Status dashboard** — live web UI at `beercan-site/status.html`

## CLI Reference

```
beercan init <name> [--work-dir <path>]    Create a project
beercan projects                            List projects
beercan status                              Overview of all projects
beercan run <project> [team] <goal>         Run a bloop
beercan history <project> [--status <s>]    List past bloops
beercan result <bloop-id>                   Full bloop details
beercan jobs [status]                       Job queue status
beercan schedule:add <project> "<cron>" <goal>
beercan schedule:list [project]
beercan trigger:add <project> <type> <filter> <goal>
beercan mcp:add <project> <name> <cmd> [args]
beercan daemon                              Run scheduler + events
beercan chat [project]                  Interactive Skippy chat
beercan serve [port]                    API server (default: 3939)
beercan bootstrap [goal]                    Self-improvement bloop
```

## Programmatic API

```typescript
import { BeerCanEngine } from "beercan";

const engine = await new BeerCanEngine().init();

// Run a bloop directly
const bloop = await engine.runBloop({
  projectSlug: "my-project",
  goal: "Refactor the auth module",
  team: "auto",
});

// Query results
engine.getBloop(bloop.id);
engine.getProjectBloops("my-project", "completed");

// Enqueue for background execution
engine.enqueueBloop({ projectSlug: "my-project", goal: "Run daily report" });
```

## Configuration

Set in `.env` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
| `BEERCAN_DATA_DIR` | `~/.beercan` | Data directory |
| `BEERCAN_DEFAULT_MODEL` | `claude-sonnet-4-6` | Default agent model |
| `BEERCAN_HEAVY_MODEL` | `claude-opus-4-6` | Heavy model |
| `BEERCAN_GATEKEEPER_MODEL` | `claude-haiku-4-5-20251001` | Gatekeeper model |
| `BEERCAN_MAX_CONCURRENT` | `2` | Max simultaneous bloops |
| `BEERCAN_BLOOP_TIMEOUT_MS` | `600000` | Per-bloop timeout (10 min) |
| `CLOUDFLARE_API_TOKEN` | — | For web_fetch (Browser Rendering) |
| `CLOUDFLARE_ACCOUNT_ID` | — | For web_fetch (Browser Rendering) |
| `BEERCAN_API_KEY` | — | Bearer token for API auth |
| `BEERCAN_NOTIFY_ON_COMPLETE` | `true` | Desktop notification on completion |
| `BEERCAN_NOTIFY_WEBHOOK_URL` | — | POST results to this URL |
| `BEERCAN_TELEGRAM_TOKEN` | — | Telegram bot token |
| `BEERCAN_SLACK_TOKEN` | — | Slack bot token |
| `BEERCAN_SLACK_SIGNING_SECRET` | — | Slack signing secret |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.
See [docs/TASK_FLOW.md](docs/TASK_FLOW.md) for execution flow.

## License

MIT
