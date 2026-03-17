# 🍺 BeerCan

Autonomous AI agent system — powered by Skippy the Magnificent.

Sandboxed projects, multi-agent pipelines with dynamic team composition, 4-layer hybrid RAG memory, conversational chat interface (terminal, Telegram, Slack, WebSocket), REST API with auth, and a magnificently sarcastic AI overlord.

## Install

```bash
npm install -g beercan
```

Requires Node.js 18+ and an [Anthropic API key](https://console.anthropic.com/).

## Setup

```bash
beercan setup
```

Interactive wizard that configures your API keys, models, and optional integrations (Cloudflare, Telegram, Slack). Creates `~/.beercan/.env`.

## Config

Quick config management without the full setup wizard:

```bash
beercan config set KEY=VALUE        # Set a config value
beercan config get KEY              # Get a value (keys masked)
beercan config list                 # Show all config
```

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
  Use # for projects, @ for bloops.

skippy> create a project for my-api at ~/work/my-api
Zounds! A new project! my-api now exists because I willed it so.

skippy [my-api]> analyze the codebase for security issues
▸ Phase: plan (planner)
⚙ read_file • list_directory
✓ Bloop completed — 8,421 tokens

skippy [my-api]> @
Recent Bloops (1)
- a3f2b1c9 [completed] analyze the codebase for security issues

skippy [my-api]> ##
Back to system level. The Magnificent Skippy oversees all.

skippy> #
Projects (1)
- my-api — 1 bloops | ~/work/my-api

skippy> /status
Skippy's Magnificent Status Report
Uptime: 2h 15m | Projects: 1 | Running: 0
```

Natural language or slash commands — Skippy understands both.

### Shortcuts

| Shortcut | Action |
|----------|--------|
| `#` | List all projects |
| `#project-name` | Switch to a project |
| `#project-name do something` | Run a bloop on that project |
| `##` | Exit project context (back to system level) |
| `@` | Show recent bloops |
| `@bloop-id` | Show bloop result |
| `/run`, `/status`, `/help`, etc. | Slash commands |

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

## Built-in Tools

| Category | Tools |
|----------|-------|
| Filesystem | `read_file`, `write_file`, `list_directory`, `exec_command` |
| Web | `web_fetch` (Cloudflare Browser Rendering + native), `http_request` |
| Notification | `send_notification` (macOS desktop) |
| Memory | `memory_search`, `memory_store`, `memory_update`, `memory_link`, `memory_query_graph`, `memory_scratch` |

Plus custom tools from `~/.beercan/tools/` and MCP servers.

## Custom Tools

Drop a `.js` file in `~/.beercan/tools/` and it's auto-loaded on startup. Every agent gets access automatically — no template changes needed.

```bash
# Scaffold a new tool
beercan tool:create google_search

# Edit it
vim ~/.beercan/tools/google_search.js

# List custom tools
beercan tool:list

# Remove
beercan tool:remove google_search
```

Example tool (`~/.beercan/tools/google_search.js`):
```javascript
export const definition = {
  name: "google_search",
  description: "Search Google and return top results",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
};

export async function handler({ query, limit = 5 }) {
  const res = await fetch(`https://api.example.com/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  const data = await res.json();
  return JSON.stringify(data.results);
}
```

Three ways to extend BeerCan with tools:
1. **Plugin directory** — drop `.js` files in `~/.beercan/tools/` (simplest)
2. **MCP servers** — `beercan mcp:add project my-tool npx some-server` (standard protocol)
3. **Programmatic** — `engine.toolRegistry.register(definition, handler)` (library usage)

Custom tools are automatically available to all agent roles. No configuration needed.

## Skills

Skills are higher-level than tools — they orchestrate workflows with instructions, triggers, and config. Drop a `.json` file in `~/.beercan/skills/`.

```bash
beercan skill:create social-post    # Scaffold a skill template
beercan skill:list                  # List installed skills
```

Example skill (`~/.beercan/skills/social-post.json`):
```json
{
  "name": "social-post",
  "description": "Generate and publish social media posts via Mark Supreme",
  "triggers": ["social media", "twitter", "linkedin", "post to"],
  "instructions": "1. Call list_social_platforms to check connections\n2. Generate platform-appropriate content\n3. Use upload_post tool to publish",
  "requiredTools": ["upload_post", "list_social_platforms"],
  "config": {
    "UPLOAD_POST_API_URL": "https://api.marksupreme.com/v1",
    "UPLOAD_POST_API_KEY": "your-key"
  },
  "enabled": true
}
```

When a bloop goal matches a skill's triggers, the instructions are automatically injected into agent context. Skills + tools work together:
- **Tools** = atomic API calls (post to Twitter, fetch a URL)
- **Skills** = workflow recipes (research → generate → post to multiple platforms)

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

### Telegram Quick Setup

1. Message `@BotFather` on Telegram → `/newbot` → get token
2. `beercan config set BEERCAN_TELEGRAM_TOKEN=your-token`
3. `beercan stop && beercan start`
4. Message your bot — Skippy answers!

## Production Features

- **Crash recovery** — stale "running" jobs auto-recovered on startup
- **Timeout enforcement** — `BEERCAN_BLOOP_TIMEOUT_MS` kills stuck bloops (default 10min)
- **Job cancellation** — cancel pending or abort running jobs via API
- **API key auth** — `BEERCAN_API_KEY` secures all endpoints
- **Rate limiting** — per-IP sliding window on all requests
- **Auto-notifications** — desktop notifications + webhook callbacks on completion/failure
- **Interactive setup** — `beercan setup` wizard for first-time configuration
- **Skippy personality** — randomized phrase pools with 60+ responses across 13 categories
- **Status dashboard** — live web UI at `beercan-site/status.html`

## CLI Reference

```
beercan setup                              First-time configuration wizard
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
beercan tool:create <name>              Scaffold a custom tool
beercan tool:list                       List custom tools
beercan tool:remove <name>              Remove a custom tool
beercan skill:create <name>             Scaffold a skill template
beercan skill:list                      List installed skills
beercan config set KEY=VALUE            Set a config value
beercan config get KEY                  Get a config value
beercan config list                     Show all config
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
