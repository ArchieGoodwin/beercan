# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Beercan is an autonomous agent system with sandboxed projects and multi-agent pipelines. It orchestrates Claude-powered agents through configurable team pipelines (solo, code_review, managed, full_team) or dynamically via a Gatekeeper that analyzes goals and composes the right team automatically.

## Commands

```bash
npm run build              # TypeScript compilation (tsc)
npm run dev                # Watch mode with tsx
npm run beercan -- <cmd>   # Run CLI commands (tsx src/cli.ts)
npm start                  # Run compiled output (node dist/index.ts)
npm test                   # Unit tests (104 tests, vitest)
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

**Scheduling & events:**
- `schedule:add/list/remove` — cron-based bloop scheduling
- `trigger:add/list/remove` — event-based triggers
- `mcp:add/list` — MCP server management per project
- `daemon` — run scheduler + event system

## Architecture

**Three-tier model:** Projects (sandboxed contexts with optional working directory) contain Bloops (atomic agent tasks) executed by Teams (role pipelines).

**Execution flow:** `BeerCanEngine.runBloop()` → Gatekeeper analyzes goal (if team is "auto") → composes dynamic team + roles → creates Bloop record → initializes working memory → retrieves hybrid memory context → `BloopRunner.executePipeline()` → cycles through team stages → agents use tools (filesystem, web, memory, notification) → handles APPROVE/REVISE/REJECT decisions → stores result in DB + memory → cleans up.

**Key source files:**
- `src/index.ts` — `BeerCanEngine`, main public API (runBloop, enqueueBloop, getBloop, getProjectBloops)
- `src/core/gatekeeper.ts` — `Gatekeeper`, pre-flight goal analysis, dynamic team composition
- `src/core/job-queue.ts` — `JobQueue`, SQLite-backed job queue with concurrency semaphore
- `src/core/logger.ts` — `Logger`, structured JSON logging to stdout + file
- `src/core/role-templates.ts` — 9 dynamic role templates (writer, researcher, analyst, data_processor, summarizer, planner, editor, devops, architect)
- `src/core/runner.ts` — `BloopRunner`, pipeline execution with multi-agent orchestration
- `src/core/roles.ts` — 5 built-in agent role definitions, team presets, pipeline configs
- `src/schemas.ts` — core domain types as Zod schemas (Bloop, Project with workDir, ToolCallRecord)
- `src/config.ts` — environment config with Zod validation
- `src/cli.ts` — CLI with run/history/result/status/jobs commands
- `src/storage/database.ts` — `BeerCanDB`, SQLite via better-sqlite3 + sqlite-vec, WAL mode, 10 migrations
- `src/tools/registry.ts` — tool registration and dispatch
- `src/tools/builtin/filesystem.ts` — tools: read_file, write_file, list_directory, exec_command
- `src/tools/builtin/web.ts` — tools: web_fetch (Cloudflare Browser Rendering + native fallback), http_request
- `src/tools/builtin/notification.ts` — tool: send_notification (macOS osascript + console fallback)
- `src/tools/builtin/memory.ts` — 6 memory tools for agents
- `src/memory/` — layered memory system (see Memory Architecture below)
- `src/mcp/` — Model Context Protocol integration (stdio transport, per-project config)
- `src/events/` — event system with webhook, filesystem, polling, and macOS sources
- `src/scheduler/` — cron-based bloop scheduling via node-cron

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
- **Role sources:** 5 built-in + 9 templates + fully custom roles with LLM-generated prompts.
- **Config:** `BEERCAN_GATEKEEPER_MODEL` env var (default: `claude-haiku-4-5-20251001`).

## Job Queue

SQLite-backed job queue with concurrency semaphore. Scheduler and event triggers route through the queue instead of fire-and-forget.

- **Concurrency:** `BEERCAN_MAX_CONCURRENT` (default 2) — max simultaneous bloop executions
- **Priority:** higher priority jobs execute first, FIFO within same priority
- **Direct vs queued:** `engine.runBloop()` executes directly (CLI), `engine.enqueueBloop()` goes through queue (scheduler/triggers)
- **Graceful shutdown:** `drain()` waits for all running + pending jobs

## Tool System

13 built-in tools registered at engine construction:

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

**Cloudflare Browser Rendering:** Set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` env vars to enable. Fetches clean markdown from JS-rendered pages via their crawl endpoint.

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
npm test                    # 104 unit tests (~2s)
npm run test:integration    # 4 API integration tests (~2min, needs ANTHROPIC_API_KEY)
npm run test:all            # Everything
```

- **Unit tests** (`tests/`): database, memory, tools, web tools, job queue, gatekeeper, roles, decision extraction
- **Integration tests** (`tests/integration.test.ts`): write utility, summarize CSV, web research, cross-bloop memory

## Code Conventions

- **ESM only** — `"type": "module"`. All imports use `.js` extensions.
- **Strict TypeScript** — `strict: true`, target ES2022.
- **Zod for validation** — domain types as Zod schemas, inferred with `z.infer<>`.
- **Tool pattern** — `ToolDefinition` + `ToolHandler`. Memory tools use factory pattern with closures.
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
