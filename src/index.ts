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
import { SkillManager } from "./skills/index.js";
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
  private skillManager: SkillManager;

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
    this.skillManager = new SkillManager(this.config.dataDir);
    this.skillManager.load();
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
      const bloop = await this.runBloop({ ...opts, signal: opts.signal });
      return { id: bloop.id, status: bloop.status };
    });
    this.scheduler = new Scheduler(this.db, this);
    this.eventManager = new EventManager(this.db, this);

    // Recover stale jobs/bloops from previous crash
    const recovered = this.db.recoverStaleJobs();
    if (recovered.jobs > 0 || recovered.bloops > 0) {
      this.logger.warn("engine", `Recovered stale records on startup`, {
        jobs: recovered.jobs,
        bloops: recovered.bloops,
      });
    }

    // Load custom tools from plugin directories
    await this.loadPluginTools();

    this.logger.info("engine", "Async init complete");
    return this;
  }

  /** Load custom tools from ~/.beercan/tools/ and per-project tools/ directories. */
  private async loadPluginTools(): Promise<void> {
    const globalToolsDir = path.join(this.config.dataDir, "tools");
    await this.loadToolsFromDir(globalToolsDir);
  }

  private async loadToolsFromDir(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
    for (const file of files) {
      try {
        const fullPath = path.resolve(dir, file);
        const mod = await import(`file://${fullPath}`);
        if (mod.definition && mod.handler) {
          this.tools.register(mod.definition, mod.handler);
          this.logger.info("engine", `Loaded custom tool: ${mod.definition.name}`, { file });
        } else if (mod.default?.definition && mod.default?.handler) {
          this.tools.register(mod.default.definition, mod.default.handler);
          this.logger.info("engine", `Loaded custom tool: ${mod.default.definition.name}`, { file });
        } else if (Array.isArray(mod.tools)) {
          for (const tool of mod.tools) {
            this.tools.register(tool.definition, tool.handler);
            this.logger.info("engine", `Loaded custom tool: ${tool.definition.name}`, { file });
          }
        } else {
          this.logger.warn("engine", `Skipped ${file}: no definition/handler exports found`);
        }
      } catch (err: any) {
        this.logger.error("engine", `Failed to load tool plugin: ${file}`, { error: err.message });
      }
    }
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
    signal?: AbortSignal;
  }) {
    const project = this.db.getProjectBySlug(opts.projectSlug);
    if (!project) {
      throw new Error(`Project not found: ${opts.projectSlug}`);
    }

    await this.mcpManager.connectAll(opts.projectSlug, this.tools);

    // Inject skill context if any skills match the goal
    const skillContext = this.skillManager.buildSkillContext(opts.goal);
    if (skillContext) {
      opts = { ...opts, extraContext: (opts.extraContext ?? "") + "\n" + skillContext };
    }

    let team: BloopTeam;
    let gatekeeperResult: GatekeeperResult | null = null;

    if (opts.team === "auto" || opts.team === undefined) {
      opts.onEvent?.({ type: "phase_start", phase: "gatekeeper", roleId: "gatekeeper" });

      const memoryContext = await this.memoryManager.retrieveContext(opts.projectSlug, opts.goal, 3);

      gatekeeperResult = await this.gatekeeper.analyze({
        goal: opts.goal,
        project,
        memoryContext: memoryContext || undefined,
        availableTools: this.tools.listToolNames(),
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
      const bloop = await this.runner.run({
        project,
        goal: opts.goal,
        team,
        extraContext: opts.extraContext,
        onEvent: opts.onEvent,
        signal: opts.signal,
      });

      // Auto-notify on completion/failure
      this.notifyBloopResult(bloop, opts.projectSlug);

      return bloop;
    } finally {
      if (gatekeeperResult) {
        for (const role of gatekeeperResult.dynamicRoles) {
          this.runner.unregisterRole(role.id);
        }
      }
    }
  }

  // ── Notifications ──────────────────────────────────────

  private notifyBloopResult(bloop: Bloop, projectSlug: string): void {
    const config = getConfig();

    // Publish lifecycle event to EventBus
    if (this.eventManager) {
      const bus = this.eventManager.getEventBus();
      bus.publish({
        type: bloop.status === "completed" ? "bloop:completed" : "bloop:failed",
        projectSlug,
        source: "internal",
        data: { bloopId: bloop.id, goal: bloop.goal, status: bloop.status, tokensUsed: bloop.tokensUsed },
        timestamp: new Date().toISOString(),
      });
    }

    // Desktop notification
    if (config.notifyOnComplete) {
      const title = bloop.status === "completed" ? "Bloop Completed" : "Bloop Failed";
      const message = `${bloop.goal.slice(0, 100)} [${bloop.tokensUsed} tokens]`;
      sendNotificationHandler({ title, message }).catch(() => {});
    }

    // Webhook callback
    if (config.notifyWebhookUrl) {
      fetch(config.notifyWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: bloop.status === "completed" ? "bloop:completed" : "bloop:failed",
          bloopId: bloop.id,
          projectSlug,
          goal: bloop.goal,
          status: bloop.status,
          result: bloop.result,
          tokensUsed: bloop.tokensUsed,
        }),
      }).catch(() => {});
    }
  }

  // ── Aggregate Queries ───────────────────────────────────

  getBloopStats() {
    return this.db.getBloopStats();
  }

  getProjectBloopStats(projectSlug: string) {
    const project = this.db.getProjectBySlug(projectSlug);
    if (!project) return null;
    return this.db.getProjectBloopStats(project.id);
  }

  getRecentBloops(limit = 20, status?: string) {
    return this.db.getRecentBloops(limit, status);
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

  getSkillManager(): SkillManager {
    return this.skillManager;
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
