import { v4 as uuid } from "uuid";
import path from "path";
import fs from "fs";
import { getConfig, getProjectDir } from "./config.js";
import { BeerCanDB } from "./storage/database.js";
import { ToolRegistry } from "./tools/registry.js";
import { BloopRunner, type RunBloopOptions } from "./core/runner.js";
import { createAnthropicClient } from "./client.js";
import { PRESET_TEAMS, BUILTIN_ROLES, type AgentRole, type BloopTeam } from "./core/roles.js";
import { Gatekeeper, type GatekeeperResult } from "./core/gatekeeper.js";
import { JobQueue } from "./core/job-queue.js";
import { Logger, setGlobalLogger } from "./core/logger.js";
import { MemoryManager } from "./memory/index.js";
import { MCPManager } from "./mcp/index.js";
import { Scheduler } from "./scheduler/index.js";
import { EventManager } from "./events/index.js";
import type { Project, Bloop } from "./schemas.js";
import {
  readFileDefinition, readFileHandler,
  writeFileDefinition, writeFileHandler,
  listDirDefinition, listDirHandler,
  execDefinition, execHandler,
} from "./tools/builtin/filesystem.js";
import { createMemoryTools } from "./tools/builtin/memory.js";
import {
  webFetchDefinition, webFetchHandler,
  httpRequestDefinition, httpRequestHandler,
} from "./tools/builtin/web.js";
import {
  sendNotificationDefinition, sendNotificationHandler,
} from "./tools/builtin/notification.js";

// ── BeerCan Engine ───────────────────────────────────────────

export class BeerCanEngine {
  private config = getConfig();
  private db: BeerCanDB;
  private tools: ToolRegistry;
  private runner!: BloopRunner;
  private gatekeeper!: Gatekeeper;
  private jobQueue!: JobQueue;
  private logger: Logger;
  private memoryManager: MemoryManager;
  private mcpManager: MCPManager;
  private scheduler!: Scheduler;
  private eventManager!: EventManager;

  constructor() {
    // Initialize logger
    const logFile = this.config.logFile ?? path.join(this.config.dataDir, "beercan.log");
    this.logger = new Logger(this.config.logLevel, logFile);
    setGlobalLogger(this.logger);

    // Initialize orchestrator database
    const orchestratorDb = path.join(this.config.dataDir, "orchestrator.db");
    fs.mkdirSync(this.config.dataDir, { recursive: true });

    this.db = new BeerCanDB(orchestratorDb);
    this.tools = new ToolRegistry();
    this.memoryManager = new MemoryManager(this.db);
    this.mcpManager = new MCPManager();
    this.registerBuiltinTools();

    this.logger.info("engine", "BeerCanEngine initialized", { dataDir: this.config.dataDir });
  }

  /** Must be called before using the engine — initializes async resources */
  async init(): Promise<this> {
    const client = await createAnthropicClient();
    this.runner = new BloopRunner(this.db, this.tools, client, this.memoryManager);
    this.gatekeeper = new Gatekeeper(client, this.memoryManager);
    this.jobQueue = new JobQueue(this.db, this.config.maxConcurrent);
    this.jobQueue.setExecutor(async (opts) => {
      const bloop = await this.runBloop(opts);
      return { id: bloop.id, status: bloop.status };
    });
    this.scheduler = new Scheduler(this.db, this);
    this.eventManager = new EventManager(this.db, this);
    this.logger.info("engine", "Async init complete");
    return this;
  }

  private registerBuiltinTools(): void {
    // Filesystem tools
    this.tools.register(readFileDefinition, readFileHandler);
    this.tools.register(writeFileDefinition, writeFileHandler);
    this.tools.register(listDirDefinition, listDirHandler);
    this.tools.register(execDefinition, execHandler);

    // Web tools
    this.tools.register(webFetchDefinition, webFetchHandler);
    this.tools.register(httpRequestDefinition, httpRequestHandler);

    // Notification tool
    this.tools.register(sendNotificationDefinition, sendNotificationHandler);

    // Memory tools — handlers access bloop context via runner getter
    const memoryTools = createMemoryTools(
      this.memoryManager,
      () => this.runner?.getCurrentBloopContext() ?? null,
    );
    for (const { definition, handler } of memoryTools) {
      this.tools.register(definition, handler);
    }
  }

  // ── Project Management ───────────────────────────────────

  createProject(opts: {
    name: string;
    slug: string;
    description?: string;
    workDir?: string;
    context?: Record<string, unknown>;
    allowedTools?: string[];
  }): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: uuid(),
      name: opts.name,
      slug: opts.slug,
      description: opts.description,
      workDir: opts.workDir,
      context: opts.context ?? {},
      allowedTools: opts.allowedTools ?? ["*"],
      tokenBudget: { dailyLimit: 100_000, perBloopLimit: 20_000 },
      createdAt: now,
      updatedAt: now,
    };

    const projectDir = getProjectDir(opts.slug);
    fs.mkdirSync(projectDir, { recursive: true });

    this.db.createProject(project);
    this.logger.info("engine", `Project created: ${opts.slug}`, { projectId: project.id });
    return project;
  }

  getProject(slug: string): Project | null {
    return this.db.getProjectBySlug(slug);
  }

  listProjects(): Project[] {
    return this.db.listProjects();
  }

  // ── Bloop Queries ───────────────────────────────────────────

  getBloop(id: string): Bloop | null {
    return this.db.getBloop(id);
  }

  getProjectBloops(projectSlug: string, status?: string): Bloop[] {
    const project = this.db.getProjectBySlug(projectSlug);
    if (!project) return [];
    return this.db.getProjectBloops(project.id, status);
  }

  // ── Bloop Execution ───────────────────────────────────────

  /** Enqueue a bloop for execution via the job queue (concurrency-limited). */
  enqueueBloop(opts: {
    projectSlug: string;
    goal: string;
    team?: string;
    priority?: number;
    source?: "manual" | "cron" | "event";
    sourceId?: string;
    extraContext?: string;
  }): string {
    return this.jobQueue.enqueue(opts);
  }

  /** Execute a bloop directly (bypasses job queue). Used for CLI and direct API calls. */
  async runBloop(opts: {
    projectSlug: string;
    goal: string;
    team?: string | BloopTeam;
    extraContext?: string;
    onEvent?: RunBloopOptions["onEvent"];
  }) {
    const project = this.db.getProjectBySlug(opts.projectSlug);
    if (!project) {
      throw new Error(`Project not found: ${opts.projectSlug}`);
    }

    await this.mcpManager.connectAll(opts.projectSlug, this.tools);

    let team: BloopTeam;
    let gatekeeperResult: GatekeeperResult | null = null;

    if (opts.team === "auto" || opts.team === undefined) {
      opts.onEvent?.({ type: "phase_start", phase: "gatekeeper", roleId: "gatekeeper" });

      const memoryContext = await this.memoryManager.retrieveContext(opts.projectSlug, opts.goal, 3);

      gatekeeperResult = await this.gatekeeper.analyze({
        goal: opts.goal,
        project,
        memoryContext: memoryContext || undefined,
      });

      team = gatekeeperResult.team;
      this.runner.registerRoles(gatekeeperResult.dynamicRoles);

      const planSummary = `Gatekeeper Plan [${gatekeeperResult.plan.complexity}]: ${gatekeeperResult.plan.reasoning}\n` +
        `Roles: ${gatekeeperResult.plan.roles.map((r) => `${r.name} (${r.phase})`).join(" → ")}\n` +
        `Cycles: ${gatekeeperResult.plan.maxCycles} | Tokens used: ${gatekeeperResult.tokensUsed}`;

      opts.onEvent?.({ type: "agent_message", role: "gatekeeper", content: planSummary });

      const planContext = `--- Execution Plan (Gatekeeper) ---\nComplexity: ${gatekeeperResult.plan.complexity}\n` +
        `Team: ${gatekeeperResult.plan.roles.map((r) => `${r.name} (${r.phase})`).join(" → ")}\n` +
        `Strategy: ${gatekeeperResult.plan.reasoning}\nMax Cycles: ${gatekeeperResult.plan.maxCycles}`;

      opts = { ...opts, extraContext: planContext + "\n" + (opts.extraContext ?? "") };

    } else if (typeof opts.team === "string") {
      team = PRESET_TEAMS[opts.team] ?? PRESET_TEAMS.solo;
    } else {
      team = opts.team;
    }

    this.logger.info("engine", `Bloop starting: ${opts.goal.slice(0, 80)}`, {
      projectSlug: opts.projectSlug, team: typeof opts.team === "string" ? opts.team : "custom",
    });

    try {
      return await this.runner.run({
        project,
        goal: opts.goal,
        team,
        extraContext: opts.extraContext,
        onEvent: opts.onEvent,
      });
    } finally {
      if (gatekeeperResult) {
        for (const role of gatekeeperResult.dynamicRoles) {
          this.runner.unregisterRole(role.id);
        }
      }
    }
  }

  // ── Subsystem Access ──────────────────────────────────────

  registerRole(role: AgentRole): void {
    this.runner.registerRole(role);
  }

  get toolRegistry(): ToolRegistry {
    return this.tools;
  }

  getGatekeeper(): Gatekeeper {
    return this.gatekeeper;
  }

  getJobQueue(): JobQueue {
    return this.jobQueue;
  }

  getScheduler(): Scheduler {
    return this.scheduler;
  }

  getEventManager(): EventManager {
    return this.eventManager;
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }

  getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  getDB(): BeerCanDB {
    return this.db;
  }

  async close(): Promise<void> {
    this.logger.info("engine", "Shutting down...");
    if (this.jobQueue) await this.jobQueue.drain();
    await this.mcpManager.disconnectAll();
    this.db.close();
    this.logger.close();
  }
}

// ── Public API ───────────────────────────────────────────────
export { PRESET_TEAMS, BUILTIN_ROLES } from "./core/roles.js";
export { ROLE_TEMPLATES } from "./core/role-templates.js";
export { Gatekeeper } from "./core/gatekeeper.js";
export { JobQueue } from "./core/job-queue.js";
export { Logger, getLogger } from "./core/logger.js";
export { ToolRegistry } from "./tools/registry.js";
export { MemoryManager, SqliteVecStore, KnowledgeGraph, WorkingMemory, HybridSearch } from "./memory/index.js";
export { MCPManager } from "./mcp/index.js";
export { Scheduler } from "./scheduler/index.js";
export { EventManager } from "./events/index.js";
export type { BloopEvent } from "./core/runner.js";
export type { AgentRole, BloopTeam } from "./core/roles.js";
export type { GatekeeperPlan, GatekeeperResult } from "./core/gatekeeper.js";
export type { Job, JobStats } from "./core/job-queue.js";
export type { ToolDefinition, Bloop, Project } from "./schemas.js";
export type { MemoryEntry, MemoryType, KGEntity, KGEdge, EntityType, EdgeType, HybridSearchResult } from "./memory/index.js";
