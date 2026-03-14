import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { BeerCanDB } from "../src/storage/database.js";
import type { Project, Bloop } from "../src/schemas.js";
import { v4 as uuid } from "uuid";

function tmpDb(): string {
  return `/tmp/loops-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function makeProject(overrides?: Partial<Project>): Project {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    name: "Test Project",
    slug: "test-project",
    context: {},
    allowedTools: ["*"],
    tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeBloop(projectId: string, overrides?: Partial<Bloop>): Bloop {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    projectId,
    parentBloopId: null,
    trigger: "manual",
    status: "created",
    goal: "Test goal",
    messages: [],
    result: null,
    toolCalls: [],
    tokensUsed: 0,
    iterations: 0,
    maxIterations: 50,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

describe("BeerCanDB", () => {
  let dbPath: string;
  let db: BeerCanDB;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  describe("migrations", () => {
    it("creates all tables on init", () => {
      const tables = db.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);

      expect(names).toContain("projects");
      expect(names).toContain("loops");
      expect(names).toContain("schedules");
      expect(names).toContain("triggers");
      expect(names).toContain("events_log");
      expect(names).toContain("memory_entries");
      expect(names).toContain("kg_entities");
      expect(names).toContain("kg_edges");
      expect(names).toContain("kg_entity_memories");
      expect(names).toContain("working_memory");
      expect(names).toContain("_migrations");
    });

    it("creates FTS5 virtual table", () => {
      // FTS5 tables show up as type='table' in sqlite_master
      const row = db.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE name = 'memory_entries_fts'")
        .get() as any;
      expect(row).toBeTruthy();
    });

    it("creates sqlite-vec virtual table", () => {
      const row = db.getDb()
        .prepare("SELECT name FROM sqlite_master WHERE name = 'memory_vectors'")
        .get() as any;
      expect(row).toBeTruthy();
    });

    it("is idempotent — opening same DB twice works", () => {
      db.close();
      const db2 = new BeerCanDB(dbPath);
      expect(db2.listProjects()).toEqual([]);
      db2.close();
      // Re-open for afterEach cleanup
      db = new BeerCanDB(dbPath);
    });
  });

  describe("projects", () => {
    it("creates and retrieves a project", () => {
      const project = makeProject();
      db.createProject(project);

      const found = db.getProject(project.id);
      expect(found).not.toBeNull();
      expect(found!.name).toBe("Test Project");
      expect(found!.slug).toBe("test-project");
    });

    it("retrieves by slug", () => {
      const project = makeProject({ slug: "my-slug" });
      db.createProject(project);

      const found = db.getProjectBySlug("my-slug");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(project.id);
    });

    it("returns null for non-existent project", () => {
      expect(db.getProject("nonexistent")).toBeNull();
      expect(db.getProjectBySlug("nonexistent")).toBeNull();
    });

    it("lists projects in reverse chronological order", () => {
      db.createProject(makeProject({ id: uuid(), slug: "a", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" }));
      db.createProject(makeProject({ id: uuid(), slug: "b", createdAt: "2024-01-02T00:00:00.000Z", updatedAt: "2024-01-02T00:00:00.000Z" }));
      const projects = db.listProjects();
      expect(projects).toHaveLength(2);
      expect(projects[0].slug).toBe("b");
      expect(projects[1].slug).toBe("a");
    });
  });

  describe("bloops", () => {
    let project: Project;

    beforeEach(() => {
      project = makeProject();
      db.createProject(project);
    });

    it("creates and retrieves a bloop", () => {
      const bloop = makeBloop(project.id, { goal: "Write a test" });
      db.createBloop(bloop);

      const found = db.getBloop(bloop.id);
      expect(found).not.toBeNull();
      expect(found!.goal).toBe("Write a test");
      expect(found!.status).toBe("created");
    });

    it("updates bloop status and result", () => {
      const bloop = makeBloop(project.id);
      db.createBloop(bloop);

      bloop.status = "completed";
      bloop.result = { summary: "done" };
      bloop.completedAt = new Date().toISOString();
      bloop.updatedAt = new Date().toISOString();
      db.updateBloop(bloop);

      const found = db.getBloop(bloop.id);
      expect(found!.status).toBe("completed");
      expect(found!.result).toEqual({ summary: "done" });
      expect(found!.completedAt).not.toBeNull();
    });

    it("lists bloops by project", () => {
      db.createBloop(makeBloop(project.id, { goal: "goal 1" }));
      db.createBloop(makeBloop(project.id, { goal: "goal 2" }));

      const bloops = db.getProjectBloops(project.id);
      expect(bloops).toHaveLength(2);
    });

    it("filters bloops by status", () => {
      db.createBloop(makeBloop(project.id, { status: "completed" }));
      db.createBloop(makeBloop(project.id, { status: "failed" }));

      const completed = db.getProjectBloops(project.id, "completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe("completed");
    });
  });

  describe("memory entries", () => {
    let project: Project;

    beforeEach(() => {
      project = makeProject();
      db.createProject(project);
    });

    it("creates and retrieves a memory entry", () => {
      const now = new Date().toISOString();
      const entry = {
        id: uuid(),
        projectId: project.id,
        memoryType: "fact" as const,
        title: "Test fact",
        content: "The sky is blue",
        sourceBloopId: null,
        supersededBy: null,
        confidence: 0.9,
        tags: ["test", "color"],
        createdAt: now,
        updatedAt: now,
      };
      db.createMemoryEntry(entry);

      const found = db.getMemoryEntry(entry.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe("Test fact");
      expect(found!.confidence).toBe(0.9);
      expect(found!.tags).toEqual(["test", "color"]);
    });

    it("supersedes a memory entry", () => {
      const now = new Date().toISOString();
      const old = {
        id: uuid(), projectId: project.id, memoryType: "fact" as const,
        title: "Old fact", content: "v1", sourceBloopId: null,
        supersededBy: null, confidence: 1.0, tags: [],
        createdAt: now, updatedAt: now,
      };
      db.createMemoryEntry(old);

      const newEntry = {
        id: uuid(), projectId: project.id, memoryType: "fact" as const,
        title: "Updated fact", content: "v2", sourceBloopId: null,
        supersededBy: null, confidence: 1.0, tags: [],
        createdAt: now, updatedAt: now,
      };
      db.supersedeMemoryEntry(old.id, newEntry);

      const oldFound = db.getMemoryEntry(old.id);
      expect(oldFound!.supersededBy).toBe(newEntry.id);

      // List should only return non-superseded
      const active = db.listMemoryEntries(project.id);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(newEntry.id);
    });

    it("searches with FTS5", () => {
      const now = new Date().toISOString();
      const base = { projectId: project.id, memoryType: "fact" as const, sourceBloopId: null, supersededBy: null, confidence: 1.0, tags: [], createdAt: now, updatedAt: now };

      db.createMemoryEntry({ ...base, id: uuid(), title: "JavaScript patterns", content: "Use async/await for async code" });
      db.createMemoryEntry({ ...base, id: uuid(), title: "Python tips", content: "Use list comprehensions" });
      db.createMemoryEntry({ ...base, id: uuid(), title: "TypeScript guide", content: "Enable strict mode in tsconfig" });

      const results = db.searchMemoryFTS(project.id, "TypeScript");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toBe("TypeScript guide");
    });
  });

  describe("vectors (sqlite-vec)", () => {
    it("stores and queries vectors", () => {
      const v1 = new Float32Array(512);
      v1[0] = 1.0; v1[1] = 0.5;

      const v2 = new Float32Array(512);
      v2[100] = 1.0; v2[200] = 0.5;

      db.storeVector("mem-1", v1);
      db.storeVector("mem-2", v2);

      expect(db.hasVectors()).toBe(true);

      const query = new Float32Array(512);
      query[0] = 0.9; query[1] = 0.4;

      const results = db.queryVectors(query, 2);
      expect(results).toHaveLength(2);
      expect(results[0].memoryId).toBe("mem-1"); // Closest
      expect(results[0].distance).toBeLessThan(results[1].distance);
    });

    it("updates vectors", () => {
      const v1 = new Float32Array(512);
      v1[0] = 1.0;
      db.storeVector("mem-1", v1);

      const v2 = new Float32Array(512);
      v2[200] = 1.0;
      db.updateVector("mem-1", v2);

      const query = new Float32Array(512);
      query[200] = 1.0;

      const results = db.queryVectors(query, 1);
      expect(results[0].memoryId).toBe("mem-1");
      expect(results[0].distance).toBeCloseTo(0, 1);
    });

    it("deletes vectors", () => {
      const v = new Float32Array(512);
      v[0] = 1.0;
      db.storeVector("mem-1", v);
      expect(db.hasVectors()).toBe(true);

      db.deleteVector("mem-1");
      expect(db.hasVectors()).toBe(false);
    });
  });

  describe("knowledge graph", () => {
    let project: Project;

    beforeEach(() => {
      project = makeProject();
      db.createProject(project);
    });

    it("creates entities and edges", () => {
      const now = new Date().toISOString();
      const e1 = { id: uuid(), projectId: project.id, name: "auth", entityType: "concept" as const, description: "Authentication system", properties: {}, sourceBloopId: null, sourceMemoryId: null, createdAt: now, updatedAt: now };
      const e2 = { id: uuid(), projectId: project.id, name: "config.ts", entityType: "file" as const, description: null, properties: {}, sourceBloopId: null, sourceMemoryId: null, createdAt: now, updatedAt: now };

      db.createKGEntity(e1);
      db.createKGEntity(e2);

      const found = db.findKGEntityByName(project.id, "auth");
      expect(found).not.toBeNull();
      expect(found!.entityType).toBe("concept");

      const edge = { id: uuid(), projectId: project.id, sourceId: e1.id, targetId: e2.id, edgeType: "depends_on" as const, weight: 1.0, properties: {}, sourceBloopId: null, createdAt: now };
      db.createKGEdge(edge);

      const edgesFrom = db.getKGEdgesFrom(e1.id);
      expect(edgesFrom).toHaveLength(1);
      expect(edgesFrom[0].targetId).toBe(e2.id);

      const edgesTo = db.getKGEdgesTo(e2.id);
      expect(edgesTo).toHaveLength(1);
    });

    it("searches entities by name", () => {
      const now = new Date().toISOString();
      const base = { projectId: project.id, entityType: "concept" as const, description: null, properties: {}, sourceBloopId: null, sourceMemoryId: null, createdAt: now, updatedAt: now };
      db.createKGEntity({ ...base, id: uuid(), name: "authentication" });
      db.createKGEntity({ ...base, id: uuid(), name: "authorization" });
      db.createKGEntity({ ...base, id: uuid(), name: "database" });

      const results = db.searchKGEntities(project.id, "auth");
      expect(results).toHaveLength(2);
    });

    it("links entities to memories", () => {
      const now = new Date().toISOString();
      const entity = { id: uuid(), projectId: project.id, name: "test", entityType: "concept" as const, description: null, properties: {}, sourceBloopId: null, sourceMemoryId: null, createdAt: now, updatedAt: now };
      db.createKGEntity(entity);

      const memId = uuid();
      db.createMemoryEntry({ id: memId, projectId: project.id, memoryType: "fact", title: "Test", content: "Test content", sourceBloopId: null, supersededBy: null, confidence: 1.0, tags: [], createdAt: now, updatedAt: now });

      db.createKGEntityMemoryLink(entity.id, memId);

      const memIds = db.getKGEntityMemoryIds(entity.id);
      expect(memIds).toEqual([memId]);

      // Idempotent
      db.createKGEntityMemoryLink(entity.id, memId);
      expect(db.getKGEntityMemoryIds(entity.id)).toHaveLength(1);
    });
  });

  describe("working memory", () => {
    let project: Project;
    let bloopId: string;

    beforeEach(() => {
      project = makeProject();
      db.createProject(project);
      const bloop = makeBloop(project.id);
      db.createBloop(bloop);
      bloopId = bloop.id;
    });

    it("sets and gets values", () => {
      db.setWorkingMemory(bloopId, "key1", "value1");
      expect(db.getWorkingMemory(bloopId, "key1")).toBe("value1");
    });

    it("returns undefined for missing keys", () => {
      expect(db.getWorkingMemory(bloopId, "missing")).toBeUndefined();
    });

    it("upserts on conflict", () => {
      db.setWorkingMemory(bloopId, "key", "v1");
      db.setWorkingMemory(bloopId, "key", "v2");
      expect(db.getWorkingMemory(bloopId, "key")).toBe("v2");
    });

    it("lists all entries", () => {
      db.setWorkingMemory(bloopId, "a", "1");
      db.setWorkingMemory(bloopId, "b", "2");
      const items = db.listWorkingMemory(bloopId);
      expect(items).toHaveLength(2);
      expect(items[0].key).toBe("a");
    });

    it("deletes and clears", () => {
      db.setWorkingMemory(bloopId, "a", "1");
      db.setWorkingMemory(bloopId, "b", "2");

      db.deleteWorkingMemory(bloopId, "a");
      expect(db.getWorkingMemory(bloopId, "a")).toBeUndefined();
      expect(db.listWorkingMemory(bloopId)).toHaveLength(1);

      db.clearWorkingMemory(bloopId);
      expect(db.listWorkingMemory(bloopId)).toHaveLength(0);
    });
  });
});
