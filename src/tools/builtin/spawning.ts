import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";
import type { BloopContext } from "./memory.js";
import type { BeerCanDB } from "../../storage/database.js";
import type { MemoryManager } from "../../memory/index.js";
import { getConfig } from "../../config.js";

// ── Spawning & Cross-Project Tool Factory ───────────────────

interface SpawningDeps {
  enqueueBloop: (opts: {
    projectSlug: string;
    goal: string;
    team?: string;
    priority?: number;
    parentBloopId?: string;
    source?: "manual" | "cron" | "event";
    extraContext?: string;
  }) => string;
  listProjects: () => Array<{
    name: string;
    slug: string;
    description?: string;
    workDir?: string;
    context: Record<string, unknown>;
  }>;
  getProject: (slug: string) => { context: Record<string, unknown> } | null;
  getBloop: (id: string) => any | null;
}

export function createSpawningTools(
  deps: SpawningDeps,
  getBloopContext: () => BloopContext | null,
  db: BeerCanDB,
  memory: MemoryManager,
): Array<{ definition: ToolDefinition; handler: ToolHandler }> {
  return [
    { definition: spawnBloopDef, handler: createSpawnBloopHandler(deps, getBloopContext, db) },
    { definition: getBloopResultDef, handler: createGetBloopResultHandler(db) },
    { definition: listChildBloopsDef, handler: createListChildBloopsHandler(getBloopContext, db) },
    { definition: listProjectsDef, handler: createListProjectsHandler(deps) },
    { definition: searchCrossProjectDef, handler: createSearchCrossProjectHandler(deps, getBloopContext, memory) },
    { definition: searchPreviousAttemptsDef, handler: createSearchPreviousAttemptsHandler(getBloopContext, memory) },
    { definition: listJobsDef, handler: createListJobsHandler(db) },
  ];
}

// ── spawn_bloop ─────────────────────────────────────────────

const spawnBloopDef: ToolDefinition = {
  name: "spawn_bloop",
  description:
    "Spawn a child bloop (sub-task) that runs asynchronously via the job queue. " +
    "Optionally specify a different project_slug to delegate work to another project.",
  inputSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "Goal for the child bloop" },
      team: { type: "string", description: "Team preset: auto, solo, code_review, managed, full_team (default: auto)" },
      priority: { type: "number", description: "Priority (higher = sooner, default 0)" },
      extra_context: { type: "string", description: "Additional context to pass to the child" },
      project_slug: { type: "string", description: "Optional: spawn in a different project (cross-project delegation)" },
    },
    required: ["goal"],
  },
};

function createSpawnBloopHandler(
  deps: SpawningDeps,
  getCtx: () => BloopContext | null,
  db: BeerCanDB,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const config = getConfig();
    const targetSlug = (input.project_slug as string) ?? ctx.projectSlug;

    // Cross-project access check
    if (targetSlug !== ctx.projectSlug) {
      const targetProject = deps.getProject(targetSlug);
      if (!targetProject) throw new Error(`Project not found: ${targetSlug}`);
      if (targetProject.context.allowCrossProjectAccess === false) {
        throw new Error(`Project "${targetSlug}" does not allow cross-project access`);
      }
    }

    // Safety: max children per bloop
    const childCount = db.countChildBloops(ctx.bloopId);
    const maxChildren = config.maxChildrenPerBloop;
    if (childCount >= maxChildren) {
      throw new Error(`Max children reached (${maxChildren}). Cannot spawn more child bloops.`);
    }

    // Safety: max spawn depth (prevent infinite recursion)
    const depth = db.getBloopAncestorDepth(ctx.bloopId);
    const maxDepth = config.maxSpawnDepth;
    if (depth >= maxDepth) {
      throw new Error(`Max spawn depth reached (${maxDepth}). Cannot spawn deeper child bloops.`);
    }

    const jobId = deps.enqueueBloop({
      projectSlug: targetSlug,
      goal: input.goal as string,
      team: input.team as string | undefined,
      priority: input.priority as number | undefined,
      parentBloopId: ctx.bloopId,
      source: "manual",
      extraContext: input.extra_context as string | undefined,
    });

    return `Child bloop enqueued. Job ID: ${jobId}. Use get_bloop_result to check on it later.`;
  };
}

// ── get_bloop_result ────────────────────────────────────────

const getBloopResultDef: ToolDefinition = {
  name: "get_bloop_result",
  description:
    "Get the status and result of a bloop by ID. Supports partial ID matching.",
  inputSchema: {
    type: "object",
    properties: {
      bloop_id: { type: "string", description: "Bloop ID (full or partial)" },
    },
    required: ["bloop_id"],
  },
};

function createGetBloopResultHandler(db: BeerCanDB): ToolHandler {
  return async (input) => {
    const id = input.bloop_id as string;
    let bloop = db.getBloop(id);

    // Try partial match if not found
    if (!bloop) {
      bloop = db.getBloopByPartialId(id);
    }

    if (!bloop) return `Bloop not found: ${id}`;

    const lines = [
      `Bloop: ${bloop.id}`,
      `Status: ${bloop.status}`,
      `Goal: ${bloop.goal}`,
      `Tokens: ${bloop.tokensUsed}`,
      `Iterations: ${bloop.iterations}`,
      `Created: ${bloop.createdAt}`,
    ];

    if (bloop.completedAt) lines.push(`Completed: ${bloop.completedAt}`);

    if (bloop.result) {
      const summary = typeof bloop.result === "string"
        ? bloop.result
        : JSON.stringify(bloop.result).slice(0, 2000);
      lines.push(`\nResult:\n${summary}`);
    }

    return lines.join("\n");
  };
}

// ── list_child_bloops ───────────────────────────────────────

const listChildBloopsDef: ToolDefinition = {
  name: "list_child_bloops",
  description:
    "List child bloops spawned by the current bloop.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Optional: filter by status (running, completed, failed)" },
    },
    required: [],
  },
};

function createListChildBloopsHandler(
  getCtx: () => BloopContext | null,
  db: BeerCanDB,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const children = db.getChildBloops(ctx.bloopId);
    const status = input.status as string | undefined;

    const filtered = status ? children.filter((b) => b.status === status) : children;

    if (filtered.length === 0) return "No child bloops found.";

    const lines = filtered.map((b, i) =>
      `${i + 1}. [${b.status}] ${b.goal.slice(0, 100)} (ID: ${b.id.slice(0, 8)}..., tokens: ${b.tokensUsed})`
    );

    return `Child bloops (${filtered.length}):\n${lines.join("\n")}`;
  };
}

// ── list_projects ───────────────────────────────────────────

const listProjectsDef: ToolDefinition = {
  name: "list_projects",
  description:
    "List all available projects. Useful for discovering what projects exist before cross-project operations.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

function createListProjectsHandler(deps: SpawningDeps): ToolHandler {
  return async () => {
    const projects = deps.listProjects();
    if (projects.length === 0) return "No projects found.";

    const lines = projects.map((p) => {
      const parts = [`- ${p.name} (slug: ${p.slug})`];
      if (p.description) parts.push(`  Description: ${p.description}`);
      if (p.workDir) parts.push(`  Work dir: ${p.workDir}`);
      return parts.join("\n");
    });

    return `Projects (${projects.length}):\n${lines.join("\n")}`;
  };
}

// ── search_cross_project ────────────────────────────────────

const searchCrossProjectDef: ToolDefinition = {
  name: "search_cross_project",
  description:
    "Search memories across projects. If project_slug is given, searches that project. " +
    "If omitted, searches ALL projects globally. Respects cross-project access settings.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      project_slug: { type: "string", description: "Optional: search a specific project (omit for global)" },
      limit: { type: "number", description: "Max results (default 10)" },
    },
    required: ["query"],
  },
};

function createSearchCrossProjectHandler(
  deps: SpawningDeps,
  getCtx: () => BloopContext | null,
  memory: MemoryManager,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const query = input.query as string;
    const targetSlug = input.project_slug as string | undefined;
    const limit = (input.limit as number) ?? 10;

    // If targeting specific project, check access
    if (targetSlug && targetSlug !== ctx.projectSlug) {
      const targetProject = deps.getProject(targetSlug);
      if (!targetProject) throw new Error(`Project not found: ${targetSlug}`);
      if (targetProject.context.allowCrossProjectAccess === false) {
        throw new Error(`Project "${targetSlug}" does not allow cross-project access`);
      }
      // Search specific project
      const results = await memory.search(targetSlug, query, { limit });
      return formatSearchResults(results, targetSlug);
    }

    // Global search (no project filter)
    const results = await memory.searchGlobal(query, { limit });
    return formatSearchResults(results, "all projects");
  };
}

// ── search_previous_attempts ────────────────────────────────

const searchPreviousAttemptsDef: ToolDefinition = {
  name: "search_previous_attempts",
  description:
    "Search ALL projects for past bloop results with similar goals. " +
    "Helps learn from previous attempts before starting a new task.",
  inputSchema: {
    type: "object",
    properties: {
      goal_description: { type: "string", description: "Description of the goal to search for" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["goal_description"],
  },
};

function createSearchPreviousAttemptsHandler(
  getCtx: () => BloopContext | null,
  memory: MemoryManager,
): ToolHandler {
  return async (input) => {
    const query = input.goal_description as string;
    const limit = (input.limit as number) ?? 5;

    const results = await memory.searchGlobal(query, {
      memoryType: "loop_result",
      limit,
    });

    if (results.length === 0) return "No previous attempts found for similar goals.";

    const lines = results.map((r, i) => {
      const project = r.entry.projectId;
      return `${i + 1}. [${r.entry.memoryType}] (project: ${project}, score: ${r.score.toFixed(4)})\n   Goal: ${r.entry.title}\n   Result: ${r.entry.content.slice(0, 500)}`;
    });

    return `Previous attempts (${results.length}):\n\n${lines.join("\n\n")}`;
  };
}

// ── list_jobs ───────────────────────────────────────────────

const listJobsDef: ToolDefinition = {
  name: "list_jobs",
  description:
    "List jobs from the job queue with status, age, and project info. " +
    "Use for monitoring queue health, finding stale jobs, and inspecting failures.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pending", "running", "completed", "failed"],
        description: "Filter by job status (optional, returns all if omitted)",
      },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    required: [],
  },
};

function createListJobsHandler(db: BeerCanDB): ToolHandler {
  return async (input) => {
    const status = input.status as string | undefined;
    const limit = (input.limit as number) ?? 20;

    const jobs = db.listJobs(status, limit);
    if (jobs.length === 0) return `No jobs found${status ? ` with status "${status}"` : ""}.`;

    const lines = jobs.map((j: any) => {
      const age = Date.now() - new Date(j.createdAt).getTime();
      const ageStr = age > 86400000
        ? `${Math.floor(age / 86400000)}d ago`
        : age > 3600000
        ? `${Math.floor(age / 3600000)}h ago`
        : `${Math.floor(age / 60000)}m ago`;
      return `- [${j.status}] ${j.projectSlug}: ${(j.goal || "").slice(0, 80)} (${ageStr}, priority: ${j.priority})`;
    });

    return `Jobs (${jobs.length}):\n${lines.join("\n")}`;
  };
}

// ── Helpers ─────────────────────────────────────────────────

function formatSearchResults(
  results: Array<{ entry: any; score: number; sources: Array<{ type: string; rank: number }> }>,
  scope: string,
): string {
  if (results.length === 0) return `No memories found in ${scope}.`;

  const lines = results.map((r, i) => {
    const sources = r.sources.map((s) => s.type).join("+");
    return `${i + 1}. [${r.entry.memoryType}] (${sources}, score: ${r.score.toFixed(4)}, project: ${r.entry.projectId})\n   ${r.entry.title}\n   ${r.entry.content.slice(0, 400)}`;
  });

  return `Found ${results.length} memories in ${scope}:\n\n${lines.join("\n\n")}`;
}
