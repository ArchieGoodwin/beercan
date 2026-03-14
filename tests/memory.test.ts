import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { v4 as uuid } from "uuid";
import { BeerCanDB } from "../src/storage/database.js";
import { MemoryManager } from "../src/memory/index.js";
import { KnowledgeGraph } from "../src/memory/knowledge-graph.js";
import { WorkingMemory } from "../src/memory/working-memory.js";
import { LocalEmbedder } from "../src/memory/embeddings.js";
import { SqliteVecStore } from "../src/memory/sqlite-vec-store.js";
import type { Project, Loop } from "../src/schemas.js";

function tmpDb(): string {
  return `/tmp/loops-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function makeProject(db: BeerCanDB): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: uuid(), name: "Test", slug: "test-mem",
    context: {}, allowedTools: ["*"],
    tokenBudget: { dailyLimit: 100000, perLoopLimit: 20000 },
    createdAt: now, updatedAt: now,
  };
  db.createProject(project);
  return project;
}

describe("LocalEmbedder", () => {
  const embedder = new LocalEmbedder();

  it("produces 512-dim vectors", async () => {
    const vec = await embedder.embed("hello world");
    expect(vec).toHaveLength(512);
  });

  it("produces normalized vectors (L2 norm ≈ 1)", async () => {
    const vec = await embedder.embed("test input for normalization");
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 2);
  });

  it("produces similar vectors for similar text", async () => {
    const v1 = await embedder.embed("TypeScript is a programming language");
    const v2 = await embedder.embed("TypeScript programming language features");
    const v3 = await embedder.embed("cooking recipes for dinner");

    const sim12 = cosine(v1, v2);
    const sim13 = cosine(v1, v3);
    expect(sim12).toBeGreaterThan(sim13);
  });

  it("is deterministic", async () => {
    const v1 = await embedder.embed("same input");
    const v2 = await embedder.embed("same input");
    expect(v1).toEqual(v2);
  });
});

describe("SqliteVecStore", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let store: SqliteVecStore;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    store = new SqliteVecStore(db, new LocalEmbedder());
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  it("stores and queries by text similarity", async () => {
    await store.store("mem-1", "TypeScript strict mode configuration");
    await store.store("mem-2", "Python data analysis with pandas");
    await store.store("mem-3", "TypeScript ESM module setup");

    const results = await store.query("TypeScript modules", 3);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // TypeScript-related should be closer
    const tsResults = results.filter((r) => r.memoryId === "mem-1" || r.memoryId === "mem-3");
    const pyResult = results.find((r) => r.memoryId === "mem-2");
    if (pyResult && tsResults.length > 0) {
      expect(tsResults[0].distance).toBeLessThan(pyResult.distance);
    }
  });

  it("returns empty for no items", async () => {
    expect(store.hasItems()).toBe(false);
    const results = await store.query("anything");
    expect(results).toEqual([]);
  });
});

describe("KnowledgeGraph", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let kg: KnowledgeGraph;
  let project: Project;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    kg = new KnowledgeGraph(db);
    project = makeProject(db);
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  it("getOrCreateEntity is idempotent", () => {
    const e1 = kg.getOrCreateEntity(project.id, "auth", "concept", "Auth system");
    const e2 = kg.getOrCreateEntity(project.id, "auth", "concept");
    expect(e1.id).toBe(e2.id);
  });

  it("updates description on getOrCreate if entity had none", () => {
    const e1 = kg.getOrCreateEntity(project.id, "auth", "concept");
    expect(e1.description).toBeNull();

    const e2 = kg.getOrCreateEntity(project.id, "auth", "concept", "Authentication");
    expect(e2.description).toBe("Authentication");
  });

  it("creates edges between entities", () => {
    const e1 = kg.getOrCreateEntity(project.id, "auth", "concept");
    const e2 = kg.getOrCreateEntity(project.id, "config.ts", "file");
    kg.createEdge(project.id, e1.id, e2.id, "depends_on");

    const edges = kg.getEdgesFrom(e1.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].edgeType).toBe("depends_on");
  });

  it("traverses neighbors with BFS", () => {
    const a = kg.getOrCreateEntity(project.id, "A", "concept");
    const b = kg.getOrCreateEntity(project.id, "B", "concept");
    const c = kg.getOrCreateEntity(project.id, "C", "concept");
    const d = kg.getOrCreateEntity(project.id, "D", "concept");

    kg.createEdge(project.id, a.id, b.id, "relates_to");
    kg.createEdge(project.id, b.id, c.id, "relates_to");
    kg.createEdge(project.id, c.id, d.id, "relates_to");

    // Depth 1 from A: should find B
    const depth1 = kg.getNeighbors(a.id, 1);
    expect(depth1.map((e) => e.name)).toEqual(["B"]);

    // Depth 2 from A: should find B, C
    const depth2 = kg.getNeighbors(a.id, 2);
    expect(depth2.map((e) => e.name).sort()).toEqual(["B", "C"]);

    // Depth 3 from A: should find B, C, D
    const depth3 = kg.getNeighbors(a.id, 3);
    expect(depth3.map((e) => e.name).sort()).toEqual(["B", "C", "D"]);
  });

  it("filters edges by type in traversal", () => {
    const a = kg.getOrCreateEntity(project.id, "A", "concept");
    const b = kg.getOrCreateEntity(project.id, "B", "concept");
    const c = kg.getOrCreateEntity(project.id, "C", "concept");

    kg.createEdge(project.id, a.id, b.id, "depends_on");
    kg.createEdge(project.id, a.id, c.id, "relates_to");

    const depsOnly = kg.getNeighbors(a.id, 1, ["depends_on"]);
    expect(depsOnly.map((e) => e.name)).toEqual(["B"]);
  });

  it("links entities to memories", () => {
    const entity = kg.getOrCreateEntity(project.id, "auth", "concept");
    const now = new Date().toISOString();
    const memId = uuid();
    db.createMemoryEntry({
      id: memId, projectId: project.id, memoryType: "fact",
      title: "Auth fact", content: "JWT tokens",
      sourceLoopId: null, supersededBy: null, confidence: 1.0, tags: [],
      createdAt: now, updatedAt: now,
    });

    kg.linkEntityToMemory(entity.id, memId);
    const memories = kg.getMemoriesForEntity(entity.id);
    expect(memories).toHaveLength(1);
    expect(memories[0].title).toBe("Auth fact");
  });
});

describe("WorkingMemory", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let wm: WorkingMemory;
  let loopId: string;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    wm = new WorkingMemory(db);

    const project = makeProject(db);
    const now = new Date().toISOString();
    loopId = uuid();
    db.createLoop({
      id: loopId, projectId: project.id, parentLoopId: null,
      trigger: "manual", status: "running", goal: "test",
      messages: [], result: null, toolCalls: [],
      tokensUsed: 0, iterations: 0, maxIterations: 50,
      createdAt: now, updatedAt: now, completedAt: null,
    });
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  it("scope lifecycle: create, read/write, cleanup", () => {
    wm.createScope(loopId);

    wm.set(loopId, "plan", "Step 1: Read files");
    wm.set(loopId, "status", "in-progress");

    expect(wm.get(loopId, "plan")).toBe("Step 1: Read files");
    expect(wm.get(loopId, "missing")).toBeUndefined();

    const items = wm.list(loopId);
    expect(items).toHaveLength(2);

    wm.cleanup(loopId);

    // After cleanup, data is gone
    expect(wm.get(loopId, "plan")).toBeUndefined();
    expect(wm.list(loopId)).toHaveLength(0);
  });

  it("works without createScope (lazy init)", () => {
    wm.set(loopId, "key", "value");
    expect(wm.get(loopId, "key")).toBe("value");
  });
});

describe("MemoryManager", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let mm: MemoryManager;
  let project: Project;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    mm = new MemoryManager(db);
    project = makeProject(db);
  });

  afterEach(() => {
    db.close();
    cleanup(dbPath);
  });

  it("stores and searches memories", async () => {
    await mm.storeMemory("test-mem", {
      projectId: project.id,
      title: "Auth decision",
      content: "We decided to use JWT tokens for authentication",
      memoryType: "decision",
      tags: ["auth", "jwt"],
    });

    await mm.storeMemory("test-mem", {
      projectId: project.id,
      title: "Database choice",
      content: "SQLite chosen for zero-dependency storage",
      memoryType: "decision",
      tags: ["database"],
    });

    const results = await mm.search("test-mem", "authentication JWT", { projectId: project.id });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Auth-related memory should appear
    const authResult = results.find((r) => r.entry.title === "Auth decision");
    expect(authResult).toBeTruthy();
  });

  it("supersedes memories on update", async () => {
    const entry = await mm.storeMemory("test-mem", {
      projectId: project.id,
      title: "Config pattern",
      content: "Use dotenv for config",
      memoryType: "fact",
    });

    const updated = await mm.updateMemory("test-mem", entry.id, {
      content: "Use Zod-validated dotenv for config",
    });

    expect(updated).not.toBeNull();
    expect(updated!.id).not.toBe(entry.id);

    // Old entry should be superseded
    const oldEntry = db.getMemoryEntry(entry.id);
    expect(oldEntry!.supersededBy).toBe(updated!.id);

    // Only active (non-superseded) entries returned
    const active = db.listMemoryEntries(project.id);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(updated!.id);
  });

  it("stores loop results", async () => {
    const now = new Date().toISOString();
    const loop: Loop = {
      id: uuid(), projectId: project.id, parentLoopId: null,
      trigger: "manual", status: "completed", goal: "Add user auth",
      messages: [], result: "Implemented JWT-based authentication with refresh tokens",
      toolCalls: [], tokensUsed: 5000, iterations: 8, maxIterations: 50,
      createdAt: now, updatedAt: now, completedAt: now,
    };
    db.createLoop(loop);

    await mm.storeLoopResult(loop, "test-mem");

    // Should be searchable
    const entries = db.listMemoryEntries(project.id, "loop_result");
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("Add user auth");
  });

  it("retrieves context for new goals", async () => {
    await mm.storeMemory("test-mem", {
      projectId: project.id,
      title: "API endpoint conventions",
      content: "All endpoints use /api/v1/ prefix with Zod validation",
      memoryType: "fact",
    });

    const context = await mm.retrieveContext("test-mem", "Create a new API endpoint");
    expect(context).toContain("API endpoint conventions");
  });
});

// ── Helpers ──────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function cleanup(dbPath: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
