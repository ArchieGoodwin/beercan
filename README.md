# Beercan

Autonomous agent system — smarter than you, and it knows it.

Sandboxed projects, multi-agent pipelines, 4-layer memory system, dynamic team composition via Gatekeeper, SQLite-backed job queue, and 13 built-in tools including web fetch (Cloudflare Browser Rendering) and desktop notifications.

## Quick Start

```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY

npm install
npm run build

# Create a project
beercan init my-project --work-dir ~/projects/my-project

# Run a task (gatekeeper auto-picks the right team)
beercan run my-project "Create a hello world Express server"

# Run with specific team
beercan run my-project code_review "Add input validation to the API"
beercan run my-project full_team "Refactor auth system"

# View results
beercan history my-project
beercan result <bloop-id>
beercan status
beercan jobs
```

## Teams

| Team | Pipeline | Use Case |
|------|----------|----------|
| `auto` (default) | Gatekeeper picks | Any task — coding, writing, analysis, research |
| `solo` | Solo agent | Simple tasks, research, file ops |
| `code_review` | Coder → Reviewer | Code with quality checks |
| `managed` | Manager → Coder → Manager | Planned execution with summary |
| `full_team` | Manager → Coder → Reviewer → Tester | Production-quality code |

## Tools

13 built-in + MCP for external integrations:

- **Filesystem:** read_file, write_file, list_directory, exec_command
- **Web:** web_fetch (Cloudflare Browser Rendering + native), http_request
- **Notification:** send_notification (macOS desktop)
- **Memory:** memory_search, memory_store, memory_update, memory_link, memory_query_graph, memory_scratch

## Memory System

4-layer hybrid RAG: FTS5 (BM25) + sqlite-vec (KNN) + Knowledge Graph (BFS) + Working Memory. Unified via Reciprocal Rank Fusion.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full details.
See [docs/TASK_FLOW.md](docs/TASK_FLOW.md) for execution flow.

## Daemon Mode

```bash
beercan daemon
```

Runs scheduler + event system. Webhook server on port 3939. Graceful shutdown with job queue drain.

## License

MIT
