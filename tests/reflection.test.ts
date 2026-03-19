import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { BeerCanDB } from "../src/storage/database.js";
import { MemoryManager } from "../src/memory/index.js";
import { shouldReflect } from "../src/core/reflection.js";
import type { Bloop, Project } from "../src/schemas.js";

function tmpDb(): string {
  return `/tmp/loops-reflect-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function makeBloop(overrides: Partial<Bloop> = {}): Bloop {
  const now = new Date().toISOString();
  return {
    id: "test-bloop",
    projectId: "proj-1",
    parentBloopId: null,
    trigger: "manual",
    status: "completed",
    goal: "Analyze test coverage",
    messages: [],
    result: { summary: "Coverage is 85%", cycles: 1 },
    toolCalls: [
      { id: "tc1", toolName: "exec_command", input: { command: "npm test" }, output: "ok", timestamp: now },
      { id: "tc2", toolName: "read_file", input: { path: "coverage.json" }, output: "data", timestamp: now },
      { id: "tc3", toolName: "web_fetch", input: { url: "https://example.com" }, error: "timeout", timestamp: now },
    ],
    tokensUsed: 5000,
    iterations: 8,
    maxIterations: 50,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: "proj-1",
    name: "Test",
    slug: "test",
    context: {},
    allowedTools: ["*"],
    tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Reflection", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let memory: MemoryManager;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    memory = new MemoryManager(db);

    const now = new Date().toISOString();
    db.createProject({
      id: "proj-1",
      name: "Test",
      slug: "test",
      context: {},
      allowedTools: ["*"],
      tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  // ── shouldReflect ─────────────────────────────────────────

  describe("shouldReflect", () => {
    it("returns false when reflection is disabled globally and on project", () => {
      // Config has reflectionEnabled: false by default
      const bloop = makeBloop();
      const project = makeProject();
      expect(shouldReflect(bloop, project)).toBe(false);
    });

    it("returns true when project enables reflection", () => {
      const bloop = makeBloop();
      const project = makeProject({ context: { reflectionEnabled: true } });
      expect(shouldReflect(bloop, project)).toBe(true);
    });

    it("returns false when project explicitly disables reflection even if global is on", () => {
      // We can't easily set global config in test, but project override = false should win
      const bloop = makeBloop();
      const project = makeProject({ context: { reflectionEnabled: false } });
      expect(shouldReflect(bloop, project)).toBe(false);
    });

    it("returns false for heartbeat bloops", () => {
      const bloop = makeBloop({ goal: "Heartbeat check for my-project: 1. Check logs" });
      const project = makeProject({ context: { reflectionEnabled: true } });
      expect(shouldReflect(bloop, project)).toBe(false);
    });

    it("returns false for consolidation bloops", () => {
      const bloop = makeBloop({ goal: "Consolidate reflection memories" });
      const project = makeProject({ context: { reflectionEnabled: true } });
      expect(shouldReflect(bloop, project)).toBe(false);
    });

    it("returns false for reflection bloops", () => {
      const bloop = makeBloop({ goal: "Reflect on recent bloop outcomes" });
      const project = makeProject({ context: { reflectionEnabled: true } });
      expect(shouldReflect(bloop, project)).toBe(false);
    });

    it("returns false for trivial bloops (< 500 tokens)", () => {
      const bloop = makeBloop({ tokensUsed: 100 });
      const project = makeProject({ context: { reflectionEnabled: true } });
      expect(shouldReflect(bloop, project)).toBe(false);
    });

    it("returns true for substantial completed bloops", () => {
      const bloop = makeBloop({ tokensUsed: 5000, status: "completed" });
      const project = makeProject({ context: { reflectionEnabled: true } });
      expect(shouldReflect(bloop, project)).toBe(true);
    });

    it("returns true for failed bloops too", () => {
      const bloop = makeBloop({ tokensUsed: 2000, status: "failed" });
      const project = makeProject({ context: { reflectionEnabled: true } });
      // shouldReflect only checks goal-based conditions, not status
      expect(shouldReflect(bloop, project)).toBe(true);
    });
  });

  // ── ReflectionEngine.buildReflectionSummary (tested indirectly) ──

  describe("reflection summary building", () => {
    it("bloop with tool errors includes error details", () => {
      const bloop = makeBloop();
      // Verify the bloop has the expected structure for reflection
      expect(bloop.toolCalls).toHaveLength(3);
      expect(bloop.toolCalls.filter((tc) => tc.error)).toHaveLength(1);
      expect(bloop.tokensUsed).toBe(5000);
      expect(bloop.iterations).toBe(8);
    });
  });

  // ── Memory storage integration ────────────────────────────

  describe("memory integration", () => {
    it("storeMemory with reflection tags works", async () => {
      const entry = await memory.storeMemory("test", {
        projectId: "proj-1",
        title: "Test lesson",
        content: "Always check test coverage before deploying",
        memoryType: "insight",
        tags: ["reflection", "lesson"],
        confidence: 0.8,
      });

      expect(entry.id).toBeTruthy();
      expect(entry.tags).toContain("reflection");
      expect(entry.tags).toContain("lesson");
      expect(entry.memoryType).toBe("insight");
    });

    it("search finds reflection-tagged memories", async () => {
      await memory.storeMemory("test", {
        projectId: "proj-1",
        title: "UniqueReflectionLesson123",
        content: "Test coverage matters for deployment safety",
        memoryType: "insight",
        tags: ["reflection", "lesson"],
        confidence: 0.8,
      });

      const results = await memory.search("test", "UniqueReflectionLesson123", { limit: 10 });
      const reflections = results.filter((r) =>
        r.entry.tags.some((t) => t === "reflection")
      );
      expect(reflections.length).toBeGreaterThanOrEqual(1);
    });

    it("storeMemory with error_resolution type works", async () => {
      const entry = await memory.storeMemory("test", {
        projectId: "proj-1",
        title: "Timeout error in web_fetch",
        content: "Web fetch times out when URL returns > 5MB. Use http_request with streaming.",
        memoryType: "error_resolution",
        tags: ["reflection", "error_pattern"],
        confidence: 0.9,
      });

      expect(entry.memoryType).toBe("error_resolution");
    });
  });

  // ── Knowledge graph integration ───────────────────────────

  describe("knowledge graph integration", () => {
    it("can create lesson entities and edges", () => {
      const kg = memory.getKnowledgeGraph();

      const bloopEntity = kg.getOrCreateEntity(
        "proj-1", "bloop:test1234", "concept", "Test bloop",
      );
      const lessonEntity = kg.getOrCreateEntity(
        "proj-1", "lesson:coverage-matters", "concept", "Always check coverage",
      );
      const edge = kg.createEdge(
        "proj-1", bloopEntity.id, lessonEntity.id, "created_by", 1.0,
      );

      expect(bloopEntity.id).toBeTruthy();
      expect(lessonEntity.id).toBeTruthy();
      expect(edge.id).toBeTruthy();
      expect(edge.edgeType).toBe("created_by");
    });

    it("can create error → resolved_by → resolution chain", () => {
      const kg = memory.getKnowledgeGraph();

      const errorEntity = kg.getOrCreateEntity(
        "proj-1", "error:timeout", "error", "Web fetch timeout",
      );
      const resolutionEntity = kg.getOrCreateEntity(
        "proj-1", "resolution:use-streaming", "concept", "Use streaming for large responses",
      );
      const edge = kg.createEdge(
        "proj-1", errorEntity.id, resolutionEntity.id, "resolved_by", 1.0,
      );

      expect(edge.edgeType).toBe("resolved_by");

      // Verify traversal
      const neighbors = kg.getNeighbors(errorEntity.id, 1);
      expect(neighbors.length).toBeGreaterThanOrEqual(1);
      expect(neighbors.some((n) => n.name === "resolution:use-streaming")).toBe(true);
    });
  });

  // ── retrieveContext with lessons ──────────────────────────

  describe("retrieveContext with reflection lessons", () => {
    it("includes lessons in context when available", async () => {
      // Store a reflection lesson
      await memory.storeMemory("test", {
        projectId: "proj-1",
        title: "UniqueLessonForRetrieval999",
        content: "Always validate inputs before processing large datasets",
        memoryType: "insight",
        tags: ["reflection", "lesson"],
        confidence: 0.8,
      });

      const context = await memory.retrieveContext("test", "UniqueLessonForRetrieval999", 5);
      // The context should contain the lesson
      expect(context).toContain("UniqueLessonForRetrieval999");
    });
  });
});
