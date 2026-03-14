# Beercan Architecture & Infrastructure

Autonomous agent orchestration system with sandboxed projects, multi-agent pipelines, and a layered memory/RAG system.

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        BeerCanEngine                             │
│                                                                  │
│  ┌───────────┐ ┌──────────┐ ┌────────────┐ ┌────────────────┐  │
│  │Gatekeeper │ │ JobQueue │ │  Scheduler │ │ EventManager   │  │
│  │goal→team  │ │ SQLite+  │ │  cron jobs │ │ webhook/fs/poll│  │
│  │           │ │ semaphore│ │            │ │                │  │
│  └─────┬─────┘ └────┬─────┘ └─────┬──────┘ └───────┬────────┘  │
│        │             │             │                 │           │
│  ┌─────┴─────────────┴─────────────┴─────────────────┴─────────┐│
│  │  LoopRunner          ToolRegistry (13 tools)                 ││
│  │  pipeline exec       MemoryManager (4 layers)                ││
│  └─────────────────────────┬───────────────────────────────────┘│
│                             │                                    │
│  ┌──────────────────────────┴──────────────────────────────────┐│
│  │                    BeerCanDB (SQLite)                        ││
│  │  better-sqlite3 + sqlite-vec + FTS5 | WAL mode              ││
│  │  10 migrations | projects, loops, memory, kg, vectors, jobs ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌──────────────┐  ┌────────┐  ┌────────────────────────────┐  │
│  │  MCPManager  │  │ Logger │  │  Anthropic SDK (Claude API) │  │
│  │  stdio/http  │  │ JSON→  │  │  proxy-aware, multi-model   │  │
│  │              │  │ file   │  │                              │  │
│  └──────────────┘  └────────┘  └────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Three-Tier Model

| Tier | Description | Scope |
|------|-------------|-------|
| **Project** | Sandboxed context with its own tools, token budget, memory, and optional working directory | Persistent |
| **Loop** | Atomic agent task with a goal, conversation, tool calls, and result | Per-execution |
| **Team** | Pipeline of agent roles that process a Loop through phases — preset or dynamically composed by the Gatekeeper | Configuration |

### Agent Roles

Five built-in roles, each with specific capabilities:

| Role | Phase | Tools | Purpose |
|------|-------|-------|---------|
| **Manager** | plan | read_file, list_directory, memory_search, memory_query_graph, memory_scratch | Plans tasks, evaluates outputs, sends APPROVE/REVISE/REJECT |
| **Coder** | primary | read_file, write_file, list_directory, exec_command, memory_search, memory_store, memory_update, memory_link, memory_scratch | Writes code, modifies files, stores knowledge |
| **Reviewer** | review | read_file, list_directory, exec_command, memory_search, memory_query_graph | Reviews for bugs, security, quality |
| **Tester** | validate | read_file, write_file, list_directory, exec_command, memory_search, memory_scratch | Runs tests, validates behavior |
| **Solo** | primary | `*` (all) | General-purpose single agent |

### Team Pipelines

```
solo:        Solo ─────────────────────────────────────── Done
code_review: Coder ──→ Reviewer ──→ Done (or ←─ REVISE)
managed:     Manager ──→ Coder ──→ Manager summary ──→ Done
full_team:   Manager ──→ Coder ──→ Reviewer ──→ Tester ──→ Done
                          ↑          │ REVISE      │ REVISE
                          └──────────┘             │
                          └────────────────────────┘
```

Teams cycle up to `maxCycles` (1-3). Reviewer and Tester phases can REVISE (send back to Coder) or REJECT. Decisions are extracted from `<decision>APPROVE|REVISE|REJECT</decision>` tags in agent output.

### Gatekeeper (Dynamic Team Composition)

When `team` is `"auto"` (the default), a Gatekeeper analyzes the goal before execution and dynamically composes the optimal team. Single fast LLM call (Haiku) with structured output via `tool_choice`.

**What it decides:** complexity, roles, pipeline order, rejection flows, model per role, tools per role, max cycles.

**9 dynamic role templates** (beyond built-in):

| Template | Phase | Purpose |
|----------|-------|---------|
| writer | primary | Prose, documentation, blog posts, reports |
| researcher | plan | Gathers information from files and memory |
| analyst | primary | Data analysis, pattern identification, insights |
| data_processor | primary | Transform, clean, parse, migrate data |
| summarizer | summarize | Condense information into summaries |
| planner | plan | Task breakdown and execution planning |
| editor | review | Review written content for quality |
| devops | primary | Deployment, CI/CD, infrastructure |
| architect | plan | System design, trade-off evaluation |

The gatekeeper can also invent entirely new roles with custom system prompts for unusual tasks.

### Job Queue

SQLite-backed job queue with concurrency semaphore. Scheduler and event triggers route through the queue.

- Max concurrent loops: `BEERCAN_MAX_CONCURRENT` (default 2)
- Priority ordering (higher first, FIFO within same priority)
- Atomic claim via SQLite transaction
- `engine.enqueueLoop()` for queued execution, `engine.runLoop()` for direct
- `drain()` on shutdown waits for all running + pending jobs

### Project Working Directory

Projects can be scoped to a folder:
```bash
beercan init my-api --work-dir /Users/me/projects/my-api
```

When `workDir` is set, every agent's system prompt includes the path and instructions to scope all file operations and exec_command to that directory.

---

## Execution Flow

```
BeerCanEngine.runLoop(projectSlug, goal, team)
  │
  ├─ Resolve project from DB
  ├─ Connect MCP servers (lazy, per-project)
  │
  ├─ If team is "auto" or undefined:
  │    ├─ Gatekeeper.analyze(goal, project, memoryContext)
  │    │    └─ Single LLM call → GatekeeperPlan (Zod validated)
  │    ├─ Convert plan → LoopTeam + AgentRole[]
  │    ├─ Register dynamic roles on runner
  │    └─ Inject plan summary into extraContext
  │
  └─ LoopRunner.run(project, goal, team)
       │
       ├─ Create Loop record in DB (status: running)
       ├─ Set currentLoopContext (for memory tools)
       ├─ WorkingMemory.createScope(loopId)
       ├─ MemoryManager.retrieveContext() ← hybrid search for past context
       │
       ├─ executePipeline()
       │    └─ For each cycle (up to maxCycles):
       │         └─ For each pipeline stage:
       │              ├─ executeAgent(role)
       │              │    ├─ Build system prompt (role + project + workDir + context)
       │              │    ├─ Resolve tools (role ∩ project allowedTools)
       │              │    ├─ Claude API call loop → tool use → feed results back
       │              │    └─ Return { content }
       │              ├─ Accumulate pipelineContext
       │              └─ Extract decision → APPROVE continues, REVISE/REJECT restarts
       │
       ├─ Loop.status = completed, store result
       ├─ MemoryManager.storeLoopResult() → FTS5 + sqlite-vec
       ├─ WorkingMemory.cleanup(loopId)
       └─ Clear currentLoopContext
```

---

## Memory Architecture

Four layers in a single SQLite database (`~/.beercan/orchestrator.db`):

```
┌──────────────────────────────────────────────────────────┐
│                    Agent Memory Tools                     │
│  memory_search  memory_store  memory_update              │
│  memory_link    memory_query_graph  memory_scratch        │
├───────────┬──────────┬──────────────┬────────────────────┤
│  Layer 1  │ Layer 2  │   Layer 3    │     Layer 4        │
│  FTS5     │sqlite-vec│  Knowledge   │  Working Memory    │
│  (BM25)   │  (KNN)   │  Graph       │  (Scratchpad)      │
├───────────┴──────────┴──────────────┤                    │
│         HybridSearch (RRF)          │  Per-loop, cleaned │
│  FTS5 + Vector + Graph → merged     │  after completion  │
└─────────────────────────────────────┴────────────────────┘
```

**Hybrid Search:** Reciprocal Rank Fusion — `RRF_score(d) = Σ 1/(60 + rank + 1)`. FTS5 + sqlite-vec + graph expansion queried in parallel, results merged and deduplicated.

**Supersede model:** Memories updated by creating new version, old gets `superseded_by` pointer. Queries filter `WHERE superseded_by IS NULL`.

---

## Storage

```
~/.beercan/
├── orchestrator.db          # All tables (10 migrations)
│   ├── projects             # Project definitions (with work_dir)
│   ├── loops                # Loop execution records
│   ├── job_queue            # Job queue (pending/running/completed/failed)
│   ├── schedules            # Cron schedules
│   ├── triggers             # Event triggers
│   ├── events_log           # Event audit log
│   ├── memory_entries       # Structured memories
│   ├── memory_entries_fts   # FTS5 index (virtual)
│   ├── kg_entities          # Knowledge graph nodes
│   ├── kg_edges             # Knowledge graph edges
│   ├── kg_entity_memories   # Entity ↔ memory links
│   ├── working_memory       # Per-loop scratchpad
│   ├── memory_vectors       # sqlite-vec embeddings (virtual)
│   └── _migrations          # Migration tracking
├── loops.log                # Structured JSON log
└── projects/
    └── <project-slug>/
        └── mcp.json         # MCP server config
```

---

## Tool System

13 built-in tools:

| Tool | Category | Description |
|------|----------|-------------|
| `read_file` | Filesystem | Read file contents (UTF-8) |
| `write_file` | Filesystem | Write file (creates parent dirs) |
| `list_directory` | Filesystem | List directory tree |
| `exec_command` | Filesystem | Execute shell command (30s timeout) |
| `web_fetch` | Web | Fetch URL content — Cloudflare Browser Rendering API or native fetch |
| `http_request` | Web | Full HTTP request (any method, headers, body) |
| `send_notification` | Notification | Desktop notification (macOS osascript) |
| `memory_search` | Memory | Hybrid search (FTS5 + vector + graph RRF) |
| `memory_store` | Memory | Store new memory |
| `memory_update` | Memory | Supersede existing memory |
| `memory_link` | Memory | Create knowledge graph entities + edges |
| `memory_query_graph` | Memory | Traverse knowledge graph (BFS) |
| `memory_scratch` | Memory | Per-loop working memory scratchpad |

**MCP Tools:** External tools via Model Context Protocol. Per-project `mcp.json` config. Namespaced as `mcp_<server>__<tool>`.

---

## Event System

```
Sources ──→ EventBus ──→ TriggerManager ──→ JobQueue.enqueue()
                              │
   Webhook (:3939)      Pattern match + goal interpolation
   Filesystem watch
   Polling
   macOS native
```

**Daemon mode:** `beercan daemon` starts scheduler + all event sources. Graceful shutdown on SIGTERM/SIGINT with job queue drain.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Claude API key |
| `BEERCAN_DATA_DIR` | `~/.beercan` | Data directory |
| `BEERCAN_DEFAULT_MODEL` | `claude-sonnet-4-6` | Default agent model |
| `BEERCAN_HEAVY_MODEL` | `claude-opus-4-6` | Heavy model for complex roles |
| `BEERCAN_GATEKEEPER_MODEL` | `claude-haiku-4-5-20251001` | Gatekeeper model |
| `BEERCAN_MAX_CONCURRENT` | `2` | Max simultaneous loops |
| `BEERCAN_LOOP_TIMEOUT_MS` | `600000` | Per-loop timeout (10 min) |
| `BEERCAN_MAX_ITERATIONS` | `50` | Max iterations per loop |
| `BEERCAN_TOKEN_BUDGET` | `100000` | Default token budget |
| `BEERCAN_LOG_LEVEL` | `info` | debug, info, warn, error |
| `BEERCAN_LOG_FILE` | `~/.beercan/loops.log` | Structured log file |
| `BEERCAN_WEBHOOK_RATE_LIMIT` | `60` | Webhook requests/min/IP |
| `BEERCAN_WEBHOOK_MAX_BODY_SIZE` | `1048576` | Max webhook body (1MB) |
| `CLOUDFLARE_API_TOKEN` | — | Cloudflare Browser Rendering |
| `CLOUDFLARE_ACCOUNT_ID` | — | Cloudflare Browser Rendering |

Proxy support: auto-detects `HTTP_PROXY`/`HTTPS_PROXY`.

---

## Results & API Access

### Programmatic API

```typescript
// Execute
engine.runLoop({ projectSlug, goal, team })     // Direct execution
engine.enqueueLoop({ projectSlug, goal })        // Via job queue

// Query
engine.getLoop(id)                               // Full loop record
engine.getProjectLoops("my-project")             // All loops
engine.getProjectLoops("my-project", "completed")// Filter by status
engine.getJobQueue().getStats()                  // Queue stats
```

### CLI

```bash
beercan status                          # All projects overview
beercan history my-project              # List past loops
beercan result <loop-id>                # Full result + tool calls
beercan jobs                            # Job queue status
```

---

## Testing

```bash
npm test                    # 104 unit tests (~2s)
npm run test:integration    # 4 API integration tests (~2min)
npm run test:all            # Everything
```

**Unit tests:** database, memory, tools, web tools, job queue, gatekeeper, roles, decision extraction
**Integration tests:** write utility, summarize CSV, web research, cross-loop memory

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| better-sqlite3 | ^12.8.0 | Native SQLite (FTS5, WAL) |
| sqlite-vec | ^0.1.7-alpha.2 | Vector search extension |
| @anthropic-ai/sdk | ^0.39.0 | Claude API client |
| @modelcontextprotocol/sdk | ^1.27.1 | MCP client |
| zod | ^3.24.0 | Schema validation |
| node-cron | ^4.2.1 | Cron scheduling |
| chalk | ^5.4.0 | CLI colors |
| uuid | ^11.1.0 | UUID generation |
| dotenv | ^16.4.0 | Environment variables |
| vitest | ^4.1.0 | Test framework (dev) |

Zero external services required. Everything runs locally — SQLite for storage, TF-IDF for embeddings, Claude API for agent intelligence.
