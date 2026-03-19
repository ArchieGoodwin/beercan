# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Beercan is an autonomous agent system with sandboxed projects and multi-agent pipelines, ruled by Skippy the Magnificent (an Elder AI in the form of a beer can, from Craig Alanson's Expeditionary Force series). It orchestrates Claude-powered agents through configurable team pipelines (solo, code_review, managed, full_team) or dynamically via a Gatekeeper, and provides a conversational interface (terminal, Telegram, Slack, WebSocket) for natural language interaction.

## Commands

```bash
npm run build              # TypeScript compilation (tsc)
npm run dev                # Watch mode with tsx
npm run beercan -- <cmd>   # Run CLI commands (tsx src/cli.ts)
npm start                  # Run compiled output (node dist/index.ts)
npm test                   # Unit tests (213 tests, vitest)
npm run test:integration   # Integration tests with real Claude API
npm run test:all           # All tests (unit + integration)
```

CLI commands via `npm run beercan --` (or `beercan` if installed globally):

**Projects:**
- `init <name> [--work-dir <path>]` — create a project, optionally scoped to a folder
- `projects` — list all projects
- `status` — overview of all projects with bloop counts and token usage

**Bloop execution:**
- `run <project> [team] <goal>` — run a bloop (teams: auto, solo, code_review, managed, full_team). Default team is `auto` (gatekeeper picks).
- `bootstrap <goal>` — self-improvement bloop on this codebase

**Results & history:**
- `history <project> [--status <s>]` — list past bloops with status, tokens, timestamps
- `result <bloop-id>` — full bloop details: result, tool calls, tokens (supports partial ID match)
- `status <bloop-id>` — quick status check for a specific bloop

**Job queue:**
- `jobs [status]` — view job queue (pending, running, completed, failed counts)

**Chat & server:**
- `setup` — interactive first-time configuration wizard (API keys, models, integrations)
- `chat [project]` — interactive conversational mode (terminal REPL)
- `serve [port]` — start API-only server (default port 3939)
- `daemon` — run scheduler + event system + API + chat providers

**Scheduling & events:**
- `schedule:add/list/remove` — cron-based bloop scheduling
- `trigger:add/list/remove` — event-based triggers
- `mcp:add/list` — MCP server management per project
- `tool:create/list/remove` — custom tool plugin management
- `skill:create/list` — skill plugin management
- `config set/get/list` — quick config management

## Architecture

**Three-tier model:** Projects (sandboxed contexts with optional working directory) contain Bloops (atomic agent tasks) executed by Teams (role pipelines).

**Execution flow:** `BeerCanEngine.runBloop()` → Gatekeeper analyzes goal (if team is "auto") → composes dynamic team + roles → creates Bloop record → initializes working memory → retrieves hybrid memory context (including cross-project lessons) → `BloopRunner.executePipeline()` → cycles through team stages → agents use tools (filesystem, web, memory, spawning, scheduling, skills, integration) → handles APPROVE/REVISE/REJECT decisions → stores result in DB + memory → post-bloop reflection (if enabled) → cleans up.

**Key source files:**
- `src/index.ts` — `BeerCanEngine`, main public API (runBloop, enqueueBloop, getBloop, getProjectBloops)
- `src/core/gatekeeper.ts` — `Gatekeeper`, pre-flight goal analysis, dynamic team composition
- `src/core/job-queue.ts` — `JobQueue`, SQLite-backed job queue with concurrency semaphore
- `src/core/logger.ts` — `Logger`, structured JSON logging to stdout + file
- `src/core/role-templates.ts` — 11 dynamic role templates (writer, researcher, analyst, data_processor, summarizer, planner, editor, devops, architect, heartbeat, verifier)
- `src/core/runner.ts` — `BloopRunner`, pipeline execution with multi-agent orchestration + post-bloop reflection
- `src/core/reflection.ts` — `ReflectionEngine`, post-bloop analysis via Haiku structured output
- `src/core/heartbeat.ts` — `HeartbeatManager`, per-project periodic awareness loops
- `src/core/roles.ts` — 5 built-in agent role definitions, team presets, pipeline configs
- `src/schemas.ts` — core domain types as Zod schemas (Bloop, Project with workDir, ToolCallRecord)
- `src/config.ts` — environment config with Zod validation
- `src/cli.ts` — CLI with run/history/result/status/jobs commands
- `src/storage/database.ts` — `BeerCanDB`, SQLite via better-sqlite3 + sqlite-vec, WAL mode, 11 migrations
- `src/tools/registry.ts` — tool registration and dispatch
- `src/tools/builtin/filesystem.ts` — tools: read_file, write_file, list_directory, exec_command
- `src/tools/builtin/web.ts` — tools: web_fetch (Cloudflare Browser Rendering + native fallback), http_request
- `src/tools/builtin/notification.ts` — tool: send_notification (macOS osascript + console fallback)
- `src/tools/builtin/memory.ts` — 6 memory tools for agents
- `src/tools/builtin/spawning.ts` — 6 spawning + cross-project tools (spawn_bloop, get_bloop_result, list_child_bloops, list_projects, search_cross_project, search_previous_attempts)
- `src/tools/builtin/scheduling.ts` — 6 self-scheduling tools (create/remove schedules + triggers)
- `src/tools/builtin/skills.ts` — 4 skill + project context tools (create/update/list skills, update_project_context)
- `src/tools/builtin/integration.ts` — 3 build-verify-integrate tools (register_tool_from_file, register_skill_from_bloop, verify_and_integrate)
- `src/memory/` — layered memory system (see Memory Architecture below)
- `src/mcp/` — Model Context Protocol integration (stdio transport, per-project config)
- `src/events/` — event system with webhook, filesystem, polling, and macOS sources
- `src/scheduler/` — cron-based bloop scheduling via node-cron
- `src/api/index.ts` — `registerStatusApi()`, REST API registration for status/monitoring
- `src/api/handlers/` — API route handlers (status, projects, jobs, schedules, bloops)
- `src/chat/index.ts` — `ChatBridge`, conversational orchestrator with provider-agnostic architecture
- `src/chat/skippy.ts` — Skippy the Magnificent personality system prompt
- `src/chat/skippy-phrases.ts` — Randomized phrase pools (60+ phrases, 13 categories) with `pick()`, `addPhrases()`, `setPhrases()` API
- `src/chat/intent.ts` — Two-tier intent parser (slash commands + LLM classification)
- `src/chat/providers/` — Terminal, Telegram, Slack, WebSocket chat providers
- `src/skills/index.ts` — `SkillManager`, skill loading, trigger matching, context injection
- `~/.beercan/tools/` — Custom tool plugin directory (auto-loaded `.js` files)

**Storage:** SQLite via better-sqlite3 + sqlite-vec extension. All data in `~/.beercan/orchestrator.db`. Per-project config in `~/.beercan/projects/<slug>/`. Structured logs in `~/.beercan/beercan.log`.

## Project Working Directory

Projects can be scoped to a folder via `workDir`. When set, agents are instructed to operate within that directory.

```bash
beercan init my-api --work-dir /Users/me/projects/my-api
```

## Gatekeeper

Pre-flight analysis step that dynamically composes the right team for any goal. Single fast LLM call (Haiku by default) using Anthropic's `tool_choice` for structured JSON output.

- **When:** `team: "auto"` (default) or `team: undefined`. Skipped for preset teams.
- **What it decides:** task complexity, roles, pipeline order, rejection flows, model per role, tools per role, max cycles.
- **Role sources:** 5 built-in + 11 templates + fully custom roles with LLM-generated prompts.
- **Config:** `BEERCAN_GATEKEEPER_MODEL` env var (default: `claude-haiku-4-5-20251001`).

## Status API

REST API served by the daemon's HTTP server (port 3939) or standalone via `beercan serve`. Registered via `registerStatusApi()` on the existing `WebhookSource`.

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | System overview: project count, bloop stats, job stats, uptime |
| `GET /api/projects` | All projects with bloop count summaries + token usage |
| `GET /api/projects/:slug` | Single project detail with recent bloops |
| `GET /api/projects/:slug/bloops` | Project bloops (optional `?status=` filter) |
| `GET /api/jobs` | Job queue stats + recent jobs (optional `?status=`, `?limit=`) |
| `GET /api/schedules` | All schedules (optional `?project=` filter) |
| `GET /api/bloops/recent` | Recent bloops across all projects (`?limit=`) |
| `GET /api/bloops/:id` | Single bloop detail (supports partial ID match) |
| `POST /api/bloops` | Submit a new bloop (enqueue via job queue) |
| `DELETE /api/jobs/:id` | Cancel a pending or running job |

**Authentication:** Set `BEERCAN_API_KEY` env var to require `Authorization: Bearer <key>` on all endpoints (except `/api/health`). Rate limiting enforced per-IP via `BEERCAN_WEBHOOK_RATE_LIMIT`.

**Task submission via API:**
```bash
curl -X POST http://localhost:3939/api/bloops \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BEERCAN_API_KEY" \
  -d '{"projectSlug": "my-project", "goal": "Analyze test coverage"}'
```

Status page at `beercan-site/status.html` consumes these endpoints.

## Job Queue

SQLite-backed job queue with concurrency semaphore. Scheduler and event triggers route through the queue instead of fire-and-forget.

- **Concurrency:** `BEERCAN_MAX_CONCURRENT` (default 2) — max simultaneous bloop executions
- **Priority:** higher priority jobs execute first, FIFO within same priority
- **Direct vs queued:** `engine.runBloop()` executes directly (CLI), `engine.enqueueBloop()` goes through queue (scheduler/triggers)
- **Cancellation:** `engine.getJobQueue().cancelJob(id)` — cancels pending jobs immediately, aborts running jobs via AbortController
- **Crash recovery:** On startup, stale "running" jobs/bloops from crashed processes are automatically marked as failed
- **Timeout enforcement:** `BEERCAN_BLOOP_TIMEOUT_MS` (default 10min) enforced via AbortController — kills stuck bloops
- **Graceful shutdown:** `drain()` waits for all running + pending jobs

## Conversational Interface

Provider-agnostic chat layer for interacting with BeerCan via natural language.

**Architecture:** `ChatBridge` receives messages from any `ChatProvider`, parses intent (slash commands + LLM), executes engine actions, and streams results back.

**Providers:**
- **Terminal** — `beercan chat [project]` — interactive REPL with colored output
- **Telegram** — set `BEERCAN_TELEGRAM_TOKEN` — bot auto-starts in daemon mode (requires `telegraf`)
- **Slack** — set `BEERCAN_SLACK_TOKEN` + `BEERCAN_SLACK_SIGNING_SECRET` — auto-starts in daemon (requires `@slack/bolt`)
- **WebSocket** — generic ws server on port 3940 for custom integrations (requires `ws`)

**Shortcuts:** `#` for projects (`#slug` switch, `#slug goal` run), `@` for bloops (`@id` result), `##` exit project context.

**Conversation memory:** Last 20 messages per channel stored and passed to LLM for multi-turn context. Skippy can reference earlier messages in the same conversation.

**Slash commands:** `/run <project> <goal>`, `/status`, `/projects`, `/history [project]`, `/result <id>`, `/cancel <id>`, `/help`

**Natural language:** Falls back to Haiku LLM call for intent classification — "analyze the test coverage" → run_bloop.

**Key files:**
- `src/chat/index.ts` — `ChatBridge`, main orchestrator
- `src/chat/types.ts` — `ChatProvider` interface, `ChatMessage`, `ChatIntent`
- `src/chat/intent.ts` — slash command parsing + LLM intent classification
- `src/chat/formatter.ts` — BloopEvent/result/status formatting
- `src/chat/providers/` — terminal, telegram, slack, websocket implementations

## Tool System

32 built-in tools registered at engine construction:

| Tool | Category | Description |
|------|----------|-------------|
| `read_file` | Filesystem | Read file contents |
| `write_file` | Filesystem | Write file (creates parent dirs) |
| `list_directory` | Filesystem | List directory tree |
| `exec_command` | Filesystem | Execute shell command (30s timeout) |
| `web_fetch` | Web | Fetch URL content — uses Cloudflare Browser Rendering API if configured, native fetch fallback |
| `http_request` | Web | Full HTTP request (any method, headers, body) |
| `send_notification` | Notification | Desktop notification (macOS osascript, console fallback) |
| `memory_search` | Memory | Hybrid search across all layers (FTS5 + vector + graph RRF) |
| `memory_store` | Memory | Store new memory (fact/insight/decision/note) |
| `memory_update` | Memory | Supersede existing memory with new version |
| `memory_link` | Memory | Create entities and edges in the knowledge graph |
| `memory_query_graph` | Memory | Traverse knowledge graph (multi-hop BFS) |
| `memory_scratch` | Memory | Read/write per-bloop working memory scratchpad |
| `spawn_bloop` | Spawning | Create child bloops (same or cross-project) |
| `get_bloop_result` | Spawning | Check status/result of any bloop by ID |
| `list_child_bloops` | Spawning | List bloops spawned by current bloop |
| `list_projects` | Spawning | Discover all available projects |
| `search_cross_project` | Spawning | Search memories across projects (global or targeted) |
| `search_previous_attempts` | Spawning | Find past bloop results with similar goals |
| `create_schedule` | Scheduling | Create cron schedule for recurring bloops |
| `create_trigger` | Scheduling | Create event trigger for reactive bloops |
| `list_schedules` | Scheduling | List project's cron schedules |
| `list_triggers` | Scheduling | List project's event triggers |
| `remove_schedule` | Scheduling | Remove a cron schedule |
| `remove_trigger` | Scheduling | Remove an event trigger |
| `create_skill` | Skills | Create a reusable skill from experience |
| `update_skill` | Skills | Update an existing skill |
| `list_skills` | Skills | List all available skills |
| `update_project_context` | Skills | Modify project configuration |
| `register_tool_from_file` | Integration | Validate and register a .js file as a live tool |
| `register_skill_from_bloop` | Integration | Package bloop learnings as a skill |
| `verify_and_integrate` | Integration | Spawn verification bloop, integrate on APPROVE |

**Cloudflare Browser Rendering:** Set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` env vars to enable. Fetches clean markdown from JS-rendered pages via their crawl endpoint.

**Custom tools:** Drop `.js` files in `~/.beercan/tools/`. Auto-loaded on startup. Custom tools are automatically available to all agent roles (appended to every role's allowedTools). Three export patterns supported: `{ definition, handler }`, `{ default: { definition, handler } }`, or `{ tools: [{ definition, handler }, ...] }`.

**CLI:** `beercan tool:create <name>`, `beercan tool:list`, `beercan tool:remove <name>`.

## Skills System

Higher-level workflow recipes that orchestrate tools. Skills provide step-by-step instructions, trigger keywords, and config that are automatically injected into agent context when a bloop goal matches.

- **Location:** `~/.beercan/skills/` (`.json` files)
- **Auto-matching:** Goal text matched against skill `triggers` array
- **Context injection:** Matched skill `instructions` appended to agent system prompt
- **CLI:** `beercan skill:create <name>`, `beercan skill:list`
- **Chat:** `/skills` to list, natural language triggers automatic

## Agentic Autonomy

Six subsystems that make agents self-directed rather than task-driven:

### Self-Spawning & Cross-Project
Agents can create child bloops, delegate to other projects, and search global knowledge. `spawn_bloop` with optional `project_slug` for cross-project delegation. Safety: max 5 children per bloop, max depth 3 (configurable). `search_cross_project` and `search_previous_attempts` for global memory search. Projects opt out via `project.context.allowCrossProjectAccess: false`.

### Self-Scheduling
Agents create their own cron schedules and event triggers. `create_schedule` with frequency validation (min 5min interval). `create_trigger` with regex matching and `{{data.field}}` goal interpolation. Max 20 each per project.

### Heartbeat System
Per-project periodic awareness loop. `HeartbeatManager` runs in daemon mode, checks configurable checklists at intervals, suppresses silent results. Config stored in `project.context.heartbeat`. Active hours enforcement. Uses dedicated heartbeat role template.

### Self-Education (Reflection)
Opt-in post-bloop reflection via lightweight Haiku call. `ReflectionEngine` extracts lessons, patterns, errors into memory with `["reflection"]` tags. Creates knowledge graph entities linking bloops to lessons and error resolutions. `retrieveContext()` automatically injects relevant lessons from past bloops. Enable: `BEERCAN_REFLECTION_ENABLED=true` or `project.context.reflectionEnabled: true`. Includes periodic consolidation for merging duplicate memories.

### Self-Modification
Agents create and manage skills via `create_skill`, `update_skill`. Modify project config via `update_project_context` (restricted keys: id, slug, name, createdAt).

### Build-Verify-Integrate Pipeline
Agents build artifacts, spawn verification child bloops, and auto-register tools/skills on APPROVE. `verify_and_integrate` orchestrates the full cycle. `register_tool_from_file` validates exports and runs test commands before registration. Dedicated `verifier` role template.

## Memory Architecture

Four-layer system with unified hybrid search:

- **Layer 1 — Structured (FTS5):** `memory_entries` table with FTS5 virtual table for BM25-ranked keyword search.
- **Layer 2 — Semantic (Vector):** sqlite-vec extension (`memory_vectors` vec0 table) with TF-IDF embeddings (512-dim, local).
- **Layer 3 — Knowledge Graph:** `kg_entities` + `kg_edges` tables. Multi-hop BFS traversal.
- **Layer 4 — Working Memory:** Per-bloop ephemeral scratchpad with SQLite write-through.

**Key memory files:**
- `src/memory/index.ts` — `MemoryManager`, central facade
- `src/memory/schemas.ts` — Zod schemas
- `src/memory/knowledge-graph.ts` — entity/edge CRUD, BFS traversal
- `src/memory/working-memory.ts` — per-bloop scratchpad
- `src/memory/hybrid-search.ts` — RRF across FTS5 + vector + graph
- `src/memory/sqlite-vec-store.ts` — sqlite-vec backed vector store
- `src/memory/embeddings.ts` — LocalEmbedder (TF-IDF), EmbeddingProvider interface

## Results & Bloop Access

**Programmatic API:**
```typescript
engine.getBloop(id)                              // Full bloop record by UUID
engine.getProjectBloops("my-project")            // All bloops for project
engine.getProjectBloops("my-project", "completed") // Filter by status
engine.enqueueBloop({ projectSlug, goal })       // Queue a job
engine.getJobQueue().getStats()                 // Queue stats
```

**CLI:**
```bash
beercan history my-project              # List past bloops
beercan result <bloop-id>                # Full result + tool calls
beercan status                          # All projects overview
beercan jobs                            # Job queue status
```

## Testing

```bash
npm test                    # 213 unit tests (~3s)
npm run test:integration    # 4 API integration tests (~2min, needs ANTHROPIC_API_KEY)
npm run test:all            # Everything
```

- **Unit tests** (`tests/`): database, memory, tools, web tools, job queue, gatekeeper, roles, decision extraction, API, spawning tools, scheduling tools, reflection, heartbeat, skill tools, integration tools
- **Integration tests** (`tests/integration.test.ts`): write utility, summarize CSV, web research, cross-bloop memory

## Code Conventions

- **ESM only** — `"type": "module"`. All imports use `.js` extensions.
- **Strict TypeScript** — `strict: true`, target ES2022.
- **Zod for validation** — domain types as Zod schemas, inferred with `z.infer<>`.
- **Tool pattern** — `ToolDefinition` + `ToolHandler`. Context-aware tools (memory, spawning, scheduling, skills, integration) use factory pattern with closures over `getBloopContext()`.
- **Test framework** — vitest.

## Environment

Requires `ANTHROPIC_API_KEY` in `.env`. Optional env vars:

| Variable | Default | Description |
|----------|---------|-------------|
| `BEERCAN_DATA_DIR` | `~/.beercan` | Data directory |
| `BEERCAN_DEFAULT_MODEL` | `claude-sonnet-4-6` | Default agent model |
| `BEERCAN_HEAVY_MODEL` | `claude-opus-4-6` | Heavy model for complex roles |
| `BEERCAN_GATEKEEPER_MODEL` | `claude-haiku-4-5-20251001` | Gatekeeper analysis model |
| `BEERCAN_MAX_CONCURRENT` | `2` | Max simultaneous bloop executions |
| `BEERCAN_BLOOP_TIMEOUT_MS` | `600000` (10 min) | Per-bloop timeout |
| `BEERCAN_MAX_ITERATIONS` | `50` | Max iterations per bloop |
| `BEERCAN_TOKEN_BUDGET` | `100000` | Default token budget |
| `BEERCAN_LOG_LEVEL` | `info` | debug, info, warn, error |
| `BEERCAN_LOG_FILE` | `~/.beercan/beercan.log` | Structured log file path |
| `BEERCAN_WEBHOOK_RATE_LIMIT` | `60` | Webhook requests/min/IP |
| `BEERCAN_WEBHOOK_MAX_BODY_SIZE` | `1048576` (1MB) | Max webhook body size |
| `CLOUDFLARE_API_TOKEN` | — | For Cloudflare Browser Rendering |
| `CLOUDFLARE_ACCOUNT_ID` | — | For Cloudflare Browser Rendering |
| `BEERCAN_API_KEY` | — | Bearer token for API authentication |
| `BEERCAN_NOTIFY_ON_COMPLETE` | `true` | Desktop notification on bloop completion |
| `BEERCAN_NOTIFY_WEBHOOK_URL` | — | POST bloop results to this URL |
| `BEERCAN_TELEGRAM_TOKEN` | — | Telegram bot token (enables chat in daemon) |
| `BEERCAN_SLACK_TOKEN` | — | Slack bot token |
| `BEERCAN_SLACK_SIGNING_SECRET` | — | Slack signing secret |
| `BEERCAN_SLACK_APP_TOKEN` | — | Slack app token (socket mode) |
| `BEERCAN_MAX_CHILDREN_PER_BLOOP` | `5` | Max child bloops per parent |
| `BEERCAN_MAX_SPAWN_DEPTH` | `3` | Max parent chain depth for spawning |
| `BEERCAN_MAX_SCHEDULES_PER_PROJECT` | `20` | Max cron schedules per project |
| `BEERCAN_MAX_TRIGGERS_PER_PROJECT` | `20` | Max event triggers per project |
| `BEERCAN_MIN_CRON_INTERVAL` | `5` | Minimum cron interval in minutes |
| `BEERCAN_HEARTBEAT_INTERVAL` | `30` | Default heartbeat interval in minutes |
| `BEERCAN_HEARTBEAT_HOURS` | `08:00-22:00` | Default heartbeat active hours |
| `BEERCAN_REFLECTION_ENABLED` | `false` | Enable post-bloop reflection (opt-in) |
| `BEERCAN_REFLECTION_MODEL` | — | Model for reflection (defaults to gatekeeper model) |
