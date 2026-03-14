# Task Execution Flow

How a task goes from a user command to a completed result with agent collaboration, tool use, and memory persistence.

---

## 1. Entry Points

A loop can be triggered three ways:

| Entry | How | Code Path |
|-------|-----|-----------|
| **CLI** | `beercan run <project> [team] <goal>` | `cli.ts` → `engine.runLoop()` |
| **Scheduler** | Cron expression fires | `Scheduler.executeSchedule()` → `engine.runLoop()` |
| **Event** | Webhook/filesystem/polling trigger matches | `TriggerManager.matchAndSpawn()` → `engine.runLoop()` |
| **API** | TypeScript import | `engine.runLoop({ projectSlug, goal, team })` |

All four converge at `BeerCanEngine.runLoop()`.

---

## 2. Loop Lifecycle

```
                         ┌──────────────────────────────────────┐
                         │         User / Scheduler / Event      │
                         │    "Add input validation to the API"  │
                         └──────────────────┬───────────────────┘
                                            │
                         ┌──────────────────▼───────────────────┐
                         │       BeerCanEngine.runLoop()           │
                         │                                       │
                         │  1. Resolve project from DB by slug   │
                         │  2. Connect MCP servers (lazy)        │
                         │  3. If team="auto": Gatekeeper call   │
                         │     → analyze goal → compose team     │
                         │     → register dynamic roles          │
                         │     → inject plan into extraContext   │
                         │     Else: resolve preset team         │
                         └──────────────────┬───────────────────┘
                                            │
                         ┌──────────────────▼───────────────────┐
                         │         LoopRunner.run()              │
                         │                                       │
                         │  4. Create Loop record (status:running)│
                         │  5. Set currentLoopContext             │
                         │  6. WorkingMemory.createScope()       │
                         │  7. Retrieve past context (hybrid     │
                         │     search: FTS5+vector+graph)        │
                         │  8. Inject context + workDir info     │
                         └──────────────────┬───────────────────┘
                                            │
                         ┌──────────────────▼───────────────────┐
                         │        executePipeline()              │
                         │     (see Section 3 below)             │
                         └──────────────────┬───────────────────┘
                                            │
                                     ┌──────┴──────┐
                                     │             │
                              success ▼          error ▼
                         ┌──────────────┐  ┌──────────────┐
                         │status:       │  │status: failed │
                         │  completed   │  │result: {error}│
                         │result: {...} │  └──────┬───────┘
                         └──────┬───────┘         │
                                │                  │
                         ┌──────▼───────┐         │
                         │Store in      │         │
                         │memory_entries│         │
                         │+ FTS5 index  │         │
                         │+ sqlite-vec  │         │
                         └──────┬───────┘         │
                                │                  │
                         ┌──────▼──────────────────▼──────────┐
                         │  finally:                           │
                         │    WorkingMemory.cleanup(loopId)    │
                         │    currentLoopContext = null         │
                         └─────────────────────────────────────┘
```

---

## 3. Pipeline Execution

The pipeline runs the team's stages in order, cycling on rejection.

### Example: `full_team` Pipeline

```
Cycle 1 of 3
├── Stage 1: Manager (plan)
│   └── executeAgent() → plans the approach
│       output appended to pipelineContext
│
├── Stage 2: Coder (primary)
│   └── executeAgent() → writes code, uses tools
│       output appended to pipelineContext
│
├── Stage 3: Reviewer (review)    canReject: true, rejectTo: "primary"
│   └── executeAgent() → reviews code
│       ├── <decision>APPROVE</decision>  → continue to next stage
│       ├── <decision>REVISE</decision>   → restart cycle (back to Coder)
│       └── <decision>REJECT</decision>   → restart cycle (reset context)
│
├── Stage 4: Tester (validate)    canReject: true, rejectTo: "primary"
│   └── executeAgent() → runs tests
│       ├── APPROVE → pipeline complete ✓
│       ├── REVISE  → restart cycle (back to Coder with feedback)
│       └── REJECT  → restart cycle (Coder gets rejection reason)
│
│ If REVISE/REJECT → Cycle 2 of 3 (same stages, updated context)
│ If all stages APPROVE → return result
│ If maxCycles exhausted → return with warning
```

### Pipeline Context Accumulation

Each agent's output is appended to a running `pipelineContext` string:

```
--- Manager (plan) ---
I'll break this into 3 tasks: ...

--- Coder (primary) ---
I've implemented the validation middleware in src/middleware/validate.ts ...

--- Reviewer (review) ---
Overall: NEEDS_CHANGES. The validation is missing ...
<decision>REVISE</decision>

REVISION REQUESTED by Reviewer: The validation is missing ...
```

On **REVISE**, the context carries forward so the Coder sees the feedback.
On **REJECT**, the context resets to: `REJECTED by Reviewer: {reason}\n\nOriginal goal: {goal}`.

### Decision Extraction

Decisions are parsed from agent output using regex:

```
/<decision>(APPROVE|REVISE|REJECT)<\/decision>/
```

The reason is extracted from text after the tag, or the last paragraph before it.

---

## 4. Single Agent Execution

Each pipeline stage runs one agent through a tool-calling conversation loop.

```
 executeAgent(loop, project, role, pipelineContext, options)
 │
 ├── Build system prompt
 │   ├── Role's systemPrompt (instructions for this agent)
 │   ├── Project context (JSON if any)
 │   ├── Extra context (memory results, user-provided)
 │   └── System info (project name, role name, goal)
 │
 ├── Resolve tools
 │   └── role.allowedTools ∩ project.allowedTools
 │       (wildcard "*" means all available)
 │
 ├── Initial message
 │   └── "Goal: {goal}\n\nContext from previous phases:\n{pipelineContext}"
 │
 └── Conversation loop (up to role.maxIterations)
      │
      ├──→ Claude API call
      │    ├── model: role.model ?? config.defaultModel
      │    ├── max_tokens: 4096
      │    ├── system: systemPrompt
      │    ├── tools: anthropicTools (JSON Schema format)
      │    └── messages: conversation history
      │
      ├── Track token usage
      │   └── loop.tokensUsed += input_tokens + output_tokens
      │
      ├── Process response blocks
      │   │
      │   ├── TextBlock → finalContent
      │   │   ├── Emit "agent_message" event
      │   │   └── Store in loop.messages as "[RoleName] {text}"
      │   │
      │   └── ToolUseBlock → execute tool
      │       ├── Emit "tool_call" event
      │       ├── tools.execute(name, input) → { output?, error? }
      │       ├── Record in loop.toolCalls with timing
      │       ├── Emit "tool_result" event
      │       └── Collect tool_result for next API call
      │
      ├── If tool calls happened:
      │   ├── Append assistant + tool_results to messages
      │   ├── Save loop progress to DB
      │   └── Continue loop (next iteration)
      │
      └── If no tool calls (end_turn):
          └── Return { content: finalContent }
```

### Tool Execution Detail

When an agent calls a tool:

```
Agent: "I need to read the config file"
  │
  ├── tool_use block: { name: "read_file", input: { path: "src/config.ts" } }
  │
  ├── ToolRegistry.execute("read_file", { path: "src/config.ts" })
  │   ├── Look up handler in Map
  │   ├── Call handler(input) → returns string
  │   └── Catch errors → { error: message }
  │
  ├── Record ToolCallRecord:
  │   { id, toolName, input, output, error, durationMs, timestamp }
  │
  └── Feed result back to agent as tool_result message
```

For **memory tools**, the handler accesses the current loop context via closure:

```
Agent: "I should remember this pattern"
  │
  ├── tool_use: memory_store { title: "Auth pattern", content: "...", memory_type: "decision" }
  │
  ├── Handler (closure over MemoryManager + getLoopContext):
  │   ├── getLoopContext() → { loopId, projectId, projectSlug }
  │   ├── MemoryManager.storeMemory(projectSlug, { ... sourceLoopId: loopId })
  │   │   ├── Insert into memory_entries table
  │   │   ├── Mirror to memory_entries_fts (FTS5)
  │   │   └── Embed + store in memory_vectors (sqlite-vec)
  │   └── Return "Memory stored with ID: abc-123"
  │
  └── Agent receives confirmation, continues reasoning
```

---

## 5. Memory During Execution

### Before Execution: Context Retrieval

```
MemoryManager.retrieveContext(projectSlug, goal, count=5)
  │
  ├── HybridSearch.search(query=goal, projectId, limit=5)
  │   │
  │   ├── FTS5: searchMemoryFTS(projectId, goal)
  │   │   └── SELECT ... FROM memory_entries_fts MATCH ? ORDER BY rank
  │   │
  │   ├── sqlite-vec: SqliteVecStore.query(goal, topK=10)
  │   │   ├── LocalEmbedder.embed(goal) → Float32Array[512]
  │   │   └── SELECT memory_id, distance FROM memory_vectors WHERE embedding MATCH ?
  │   │
  │   ├── Graph: search entities matching goal → collect linked memory IDs
  │   │   ├── kg.searchEntities(projectId, goal) → LIKE match on name/description
  │   │   ├── For each entity: get linked memory IDs
  │   │   └── For each neighbor (1 hop): get linked memory IDs
  │   │
  │   └── RRF merge: score = Σ 1/(60 + rank + 1) per source
  │
  └── Format as context string:
      "--- Relevant Memories ---
       1. [decision] Auth uses JWT tokens
          The system authenticates via...
       2. [loop_result] Added config validation
          Implemented Zod schema for..."
```

This context is injected into every agent's system prompt via `extraContext`.

### During Execution: Agent Memory Tools

Agents can actively use memory during their phase:

```
Coder agent reasoning:
  │
  ├── "Let me check if there's prior work on validation"
  │   └── memory_search { query: "input validation" }
  │       → "Found 3 memories: [decision] Use Zod for validation..."
  │
  ├── "I'll record this architectural decision"
  │   └── memory_store { title: "Validation middleware pattern",
  │                       content: "Using Zod schemas...",
  │                       memory_type: "decision" }
  │       → "Memory stored with ID: xyz-789"
  │
  ├── "Let me link this to the config system"
  │   └── memory_link { source: { name: "validation", type: "concept" },
  │                      target: { name: "config.ts", type: "file" },
  │                      relationship: "depends_on" }
  │       → "Linked: validation --[depends_on]--> config.ts"
  │
  ├── "I'll save intermediate progress for the tester"
  │   └── memory_scratch { action: "set", key: "test_command", value: "npm run test" }
  │       → "OK"

Tester agent (later phase):
  │
  ├── "What should I test?"
  │   └── memory_scratch { action: "get", key: "test_command" }
  │       → "npm run test"
  │
  └── exec_command { command: "npm run test" }
```

### After Execution: Result Persistence

```
MemoryManager.storeLoopResult(loop, projectSlug)
  │
  ├── Create MemoryEntry:
  │   { id: uuid, projectId, memoryType: "loop_result",
  │     title: loop.goal, content: result summary,
  │     sourceLoopId: loop.id }
  │
  ├── Insert into memory_entries
  │   └── Mirror to memory_entries_fts (FTS5 indexed)
  │
  └── SqliteVecStore.store(memoryId, "goal\nsummary")
      ├── LocalEmbedder.embed(text) → number[512]
      └── INSERT INTO memory_vectors (memory_id, embedding)
```

---

## 6. Real-Time Events

The `onEvent` callback fires at each stage, enabling CLI output and monitoring:

```
Timeline of events for a full_team run:

  cycle         │ { type: "cycle", cycle: 1, maxCycles: 3 }
  phase_start   │ { type: "phase_start", phase: "plan", roleId: "manager" }
  agent_message │ { type: "agent_message", role: "manager", content: "I'll break..." }
  tool_call     │ { type: "tool_call", tool: "read_file", input: { path: "..." } }
  tool_result   │ { type: "tool_result", tool: "read_file", output: "import..." }
  agent_message │ { type: "agent_message", role: "manager", content: "Plan: ..." }
  phase_start   │ { type: "phase_start", phase: "primary", roleId: "coder" }
  tool_call     │ { type: "tool_call", tool: "write_file", input: {...} }
  tool_result   │ { type: "tool_result", tool: "write_file", output: "Written..." }
  tool_call     │ { type: "tool_call", tool: "memory_store", input: {...} }
  tool_result   │ { type: "tool_result", tool: "memory_store", output: "Memory..." }
  agent_message │ { type: "agent_message", role: "coder", content: "Done. I..." }
  phase_start   │ { type: "phase_start", phase: "review", roleId: "reviewer" }
  tool_call     │ { type: "tool_call", tool: "read_file", input: {...} }
  agent_message │ { type: "agent_message", role: "reviewer", content: "..." }
  decision      │ { type: "decision", decision: "APPROVE", reason: "..." }
  phase_start   │ { type: "phase_start", phase: "validate", roleId: "tester" }
  tool_call     │ { type: "tool_call", tool: "exec_command", input: {...} }
  tool_result   │ { type: "tool_result", tool: "exec_command", output: "..." }
  decision      │ { type: "decision", decision: "APPROVE", reason: "..." }
  complete      │ { type: "complete", result: { summary: "...", cycles: 1 } }
```

The CLI formats these with chalk colors:
- Pipeline cycles → cyan header bars
- Phase starts → yellow with role ID
- Agent messages → magenta `[role]` prefix (first 10 lines)
- Tool calls → blue gear icon with truncated input
- Tool results → dim with truncated output
- Decisions → green (APPROVE), yellow (REVISE), red (REJECT)
- Complete → green checkmark
- Error → red X

---

## 7. Revision Cycle Example

When a reviewer or tester rejects work:

```
Cycle 1/3
│
├── Manager: "Plan: 1. Create middleware, 2. Add routes, 3. Test"
├── Coder: writes validation.ts, updates routes
├── Reviewer: reads code
│   └── "Missing error handling for invalid JSON body"
│       <decision>REVISE</decision>
│
│   pipelineContext now includes:
│   "REVISION REQUESTED by Reviewer: Missing error handling..."
│
Cycle 2/3  (shouldRestart = true → new cycle)
│
├── Manager: (runs again with full context including revision feedback)
├── Coder: (sees rejection reason, fixes error handling)
│   └── Uses memory_search to find patterns for error handling
│   └── Fixes the issue, runs exec_command to verify
├── Reviewer: reads updated code
│   └── <decision>APPROVE</decision>
├── Tester: runs tests
│   └── <decision>APPROVE</decision>
│
└── Pipeline complete (2 cycles used)
```

---

## 8. Loop Record (What Gets Persisted)

After execution, the Loop record in SQLite contains:

```typescript
{
  id: "550e8400-e29b-...",
  projectId: "project-uuid",
  parentLoopId: null,             // or parent loop UUID
  trigger: "manual",              // manual | cron | event | child_of
  status: "completed",            // created | running | waiting | completed | failed | timeout
  goal: "Add input validation to the API",
  systemPrompt: undefined,
  messages: [                     // Full conversation history
    { role: "assistant", content: "[Manager] I'll break this into...", timestamp: "..." },
    { role: "assistant", content: "[Coder] I've implemented...", timestamp: "..." },
    { role: "assistant", content: "[Reviewer] Looks good...", timestamp: "..." },
  ],
  result: {                       // Pipeline output
    summary: "--- Manager (plan) ---\n...\n--- Coder (primary) ---\n...",
    cycles: 1
  },
  toolCalls: [                    // Full audit log
    { id: "toolu_01...", toolName: "read_file", input: { path: "..." },
      output: "...", durationMs: 12, timestamp: "..." },
    { id: "toolu_02...", toolName: "write_file", input: { path: "...", content: "..." },
      output: "Written 450 chars", durationMs: 5, timestamp: "..." },
    { id: "toolu_03...", toolName: "memory_store", input: { title: "...", ... },
      output: "Memory stored with ID: ...", durationMs: 8, timestamp: "..." },
  ],
  tokensUsed: 15420,
  iterations: 12,                 // Total API calls across all agents
  maxIterations: 50,
  createdAt: "2026-03-14T...",
  updatedAt: "2026-03-14T...",
  completedAt: "2026-03-14T..."
}
```

Additionally, the loop's result is stored in the memory system (FTS5 + vector) for future loops to discover.

---

## 9. Error Handling

| Failure Point | Behavior |
|--------------|----------|
| Unknown project slug | `runLoop()` throws before creating Loop |
| Unknown role in pipeline | `executePipeline()` throws, Loop marked failed |
| Claude API error | `run()` catches, Loop marked failed with error message |
| Tool execution error | Caught by ToolRegistry, returned as `{ error }` to agent |
| Agent exceeds maxIterations | Agent phase exits, returns last content |
| Pipeline exceeds maxCycles | Returns result with `warning: "Max pipeline cycles reached"` |
| Memory store fails | Caught, warning logged, loop execution continues |
| Working memory | Cleaned up in `finally` block regardless of success/failure |
| Loop context | Cleared in `finally` block regardless of success/failure |

Tool errors don't crash the loop — the error is returned to the agent as a tool_result, and the agent can decide how to proceed.

---

## 10. Trigger-Based Execution

### Cron Schedule

```
┌─────────────┐     ┌───────────┐     ┌──────────────┐
│  node-cron   │────▶│ Scheduler │────▶│ engine.      │
│  fires at    │     │ .execute  │     │  runLoop()   │
│  "0 9 * * *" │     │ Schedule()│     │              │
└─────────────┘     └───────────┘     └──────────────┘
```

### Event Trigger

```
┌─────────────┐     ┌───────────┐     ┌──────────────┐     ┌─────────────┐
│ Webhook POST │────▶│ EventBus  │────▶│ TriggerMgr   │────▶│ engine.     │
│ :3939/events │     │ .publish()│     │ .matchAndSpawn│     │  runLoop()  │
│ /my-project  │     │           │     │              │     │             │
└─────────────┘     └───────────┘     │ Match event   │     │ goal =      │
                                       │ type regex    │     │ interpolated│
                                       │ interpolate   │     │ template    │
                                       │ goal template │     └─────────────┘
                                       └──────────────┘

Goal template interpolation:
  "Process incoming: {{data.message}}"  +  event.data = { message: "deploy v2" }
  → "Process incoming: deploy v2"
```

Both paths end at the same `engine.runLoop()` → same full execution flow.

---

## 11. Accessing Results After Execution

### CLI

```bash
# See all past loops for a project
$ beercan history my-project
completed  550e8400  Add input validation to the API    15,420 tokens  12 iter  2026-03-14T10:30:00
failed     7a3b9c12  Deploy to staging                   8,200 tokens   5 iter  2026-03-14T09:15:00

# Filter by status
$ beercan history my-project --status completed

# Get full details for a loop (partial ID match works)
$ beercan result 550e84
Loop Details
  ID:         550e8400-e29b-...
  Status:     completed
  Goal:       Add input validation to the API
  Tokens:     15,420
  Iterations: 12
  Created:    2026-03-14T10:30:00.000Z
  Completed:  2026-03-14T10:32:15.000Z
  Tool Calls: 8

Tool Calls:
  OK  read_file 12ms
  OK  write_file 5ms
  OK  exec_command 1200ms
  OK  memory_store 8ms

Result:
{ "summary": "--- Manager (plan) ---\n...", "cycles": 1 }

# Overview of all projects
$ beercan status
My API (my-api)  dir: /Users/me/projects/my-api
  5 completed 1 failed 0 running  24,500 total tokens
```

### Programmatic API

```typescript
// Get a specific loop
const loop = engine.getLoop("550e8400-e29b-...");
console.log(loop.status);          // "completed"
console.log(loop.result);          // { summary: "...", cycles: 1 }
console.log(loop.toolCalls);       // [{ toolName: "write_file", ... }, ...]
console.log(loop.tokensUsed);      // 15420

// List all loops for a project
const loops = engine.getProjectLoops("my-project");
const failed = engine.getProjectLoops("my-project", "failed");

// Loop result is also in the memory system for future discovery
const context = await engine.getMemoryManager().retrieveContext("my-project", "validation");
// Returns relevant memories including past loop results
```

### What's stored per loop

| Field | Content |
|-------|---------|
| `result` | Pipeline output: `{ summary, cycles, warning? }` |
| `messages[]` | Full conversation: `[{ role, content, timestamp }]` per agent |
| `toolCalls[]` | Audit log: `[{ toolName, input, output, error, durationMs }]` |
| `tokensUsed` | Total input + output tokens across all agents |
| `iterations` | Total API calls across all agents |
| `status` | created, running, completed, failed, timeout |

### Automatic memory persistence

Every completed loop is automatically stored in the memory system:
1. `memory_entries` table — title=goal, content=result summary (FTS5 searchable)
2. `memory_vectors` — TF-IDF embedding of goal+summary (KNN searchable)

Future loops see these via `retrieveContext()` → hybrid search finds relevant past results.
