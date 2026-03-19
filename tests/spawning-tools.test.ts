import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { BeerCanDB } from "../src/storage/database.js";
import { MemoryManager } from "../src/memory/index.js";
import { createSpawningTools } from "../src/tools/builtin/spawning.js";
import type { BloopContext } from "../src/tools/builtin/memory.js";

function tmpDb(): string {
  return `/tmp/loops-spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("Spawning Tools", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let memory: MemoryManager;
  let enqueuedCalls: any[];
  let bloopCtx: BloopContext;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    memory = new MemoryManager(db);
    enqueuedCalls = [];

    const now = new Date().toISOString();
    db.createProject({
      id: "proj-1",
      name: "Test Project",
      slug: "test",
      context: {},
      allowedTools: ["*"],
      tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
      createdAt: now,
      updatedAt: now,
    });

    db.createProject({
      id: "proj-2",
      name: "Other Project",
      slug: "other",
      context: {},
      allowedTools: ["*"],
      tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
      createdAt: now,
      updatedAt: now,
    });

    db.createProject({
      id: "proj-private",
      name: "Private Project",
      slug: "private",
      context: { allowCrossProjectAccess: false },
      allowedTools: ["*"],
      tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
      createdAt: now,
      updatedAt: now,
    });

    // Create a root bloop
    db.createBloop({
      id: "bloop-root",
      projectId: "proj-1",
      parentBloopId: null,
      trigger: "manual",
      status: "running",
      goal: "Root task",
      messages: [],
      result: null,
      toolCalls: [],
      tokensUsed: 0,
      iterations: 0,
      maxIterations: 50,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    bloopCtx = { bloopId: "bloop-root", projectId: "proj-1", projectSlug: "test" };
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  function makeTools(ctx: BloopContext | null = bloopCtx) {
    return createSpawningTools(
      {
        enqueueBloop: (opts) => { enqueuedCalls.push(opts); return "job-123"; },
        listProjects: () => db.listProjects(),
        getProject: (slug) => db.getProjectBySlug(slug),
        getBloop: (id) => db.getBloop(id),
      },
      () => ctx,
      db,
      memory,
    );
  }

  function getHandler(name: string, ctx?: BloopContext | null) {
    const tools = makeTools(ctx);
    const tool = tools.find((t) => t.definition.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.handler;
  }

  // ── spawn_bloop ─────────────────────────────────────────

  it("spawn_bloop enqueues a child bloop", async () => {
    const handler = getHandler("spawn_bloop");
    const result = await handler({ goal: "Analyze logs" });

    expect(result).toContain("job-123");
    expect(enqueuedCalls).toHaveLength(1);
    expect(enqueuedCalls[0]).toMatchObject({
      projectSlug: "test",
      goal: "Analyze logs",
      parentBloopId: "bloop-root",
    });
  });

  it("spawn_bloop allows cross-project delegation", async () => {
    const handler = getHandler("spawn_bloop");
    await handler({ goal: "Help me", project_slug: "other" });

    expect(enqueuedCalls[0].projectSlug).toBe("other");
    expect(enqueuedCalls[0].parentBloopId).toBe("bloop-root");
  });

  it("spawn_bloop rejects cross-project when access denied", async () => {
    const handler = getHandler("spawn_bloop");
    await expect(
      handler({ goal: "Hack", project_slug: "private" })
    ).rejects.toThrow("does not allow cross-project access");
  });

  it("spawn_bloop enforces max children limit", async () => {
    const now = new Date().toISOString();
    // Create 5 child bloops
    for (let i = 0; i < 5; i++) {
      db.createBloop({
        id: `child-${i}`,
        projectId: "proj-1",
        parentBloopId: "bloop-root",
        trigger: "child_of",
        status: "completed",
        goal: `Child ${i}`,
        messages: [],
        result: null,
        toolCalls: [],
        tokensUsed: 0,
        iterations: 0,
        maxIterations: 50,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      });
    }

    const handler = getHandler("spawn_bloop");
    await expect(
      handler({ goal: "One more" })
    ).rejects.toThrow("Max children reached");
  });

  it("spawn_bloop enforces max depth limit", async () => {
    const now = new Date().toISOString();
    // Create a chain: root -> child1 -> child2 -> child3 (depth 3)
    db.createBloop({
      id: "child-1", projectId: "proj-1", parentBloopId: "bloop-root",
      trigger: "child_of", status: "running", goal: "Depth 1",
      messages: [], result: null, toolCalls: [], tokensUsed: 0,
      iterations: 0, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: null,
    });
    db.createBloop({
      id: "child-2", projectId: "proj-1", parentBloopId: "child-1",
      trigger: "child_of", status: "running", goal: "Depth 2",
      messages: [], result: null, toolCalls: [], tokensUsed: 0,
      iterations: 0, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: null,
    });
    db.createBloop({
      id: "child-3", projectId: "proj-1", parentBloopId: "child-2",
      trigger: "child_of", status: "running", goal: "Depth 3",
      messages: [], result: null, toolCalls: [], tokensUsed: 0,
      iterations: 0, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: null,
    });

    // Try to spawn from depth-3 bloop
    const deepCtx: BloopContext = { bloopId: "child-3", projectId: "proj-1", projectSlug: "test" };
    const handler = getHandler("spawn_bloop", deepCtx);
    await expect(
      handler({ goal: "Too deep" })
    ).rejects.toThrow("Max spawn depth reached");
  });

  // ── get_bloop_result ────────────────────────────────────

  it("get_bloop_result returns bloop info", async () => {
    const handler = getHandler("get_bloop_result");
    const result = await handler({ bloop_id: "bloop-root" });

    expect(result).toContain("bloop-root");
    expect(result).toContain("running");
    expect(result).toContain("Root task");
  });

  it("get_bloop_result supports partial ID", async () => {
    const handler = getHandler("get_bloop_result");
    const result = await handler({ bloop_id: "bloop-r" });

    expect(result).toContain("bloop-root");
  });

  it("get_bloop_result returns not found for unknown ID", async () => {
    const handler = getHandler("get_bloop_result");
    const result = await handler({ bloop_id: "nonexistent" });

    expect(result).toContain("not found");
  });

  // ── list_child_bloops ──────────────────────────────────

  it("list_child_bloops returns children", async () => {
    const now = new Date().toISOString();
    db.createBloop({
      id: "child-a", projectId: "proj-1", parentBloopId: "bloop-root",
      trigger: "child_of", status: "completed", goal: "Task A",
      messages: [], result: null, toolCalls: [], tokensUsed: 100,
      iterations: 5, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: now,
    });

    const handler = getHandler("list_child_bloops");
    const result = await handler({});

    expect(result).toContain("Task A");
    expect(result).toContain("completed");
  });

  it("list_child_bloops filters by status", async () => {
    const now = new Date().toISOString();
    db.createBloop({
      id: "child-ok", projectId: "proj-1", parentBloopId: "bloop-root",
      trigger: "child_of", status: "completed", goal: "Done",
      messages: [], result: null, toolCalls: [], tokensUsed: 0,
      iterations: 0, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: now,
    });
    db.createBloop({
      id: "child-fail", projectId: "proj-1", parentBloopId: "bloop-root",
      trigger: "child_of", status: "failed", goal: "Failed",
      messages: [], result: null, toolCalls: [], tokensUsed: 0,
      iterations: 0, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: now,
    });

    const handler = getHandler("list_child_bloops");
    const result = await handler({ status: "completed" });

    expect(result).toContain("Done");
    expect(result).not.toContain("Failed");
  });

  // ── list_projects ──────────────────────────────────────

  it("list_projects returns all projects", async () => {
    const handler = getHandler("list_projects");
    const result = await handler({});

    expect(result).toContain("Test Project");
    expect(result).toContain("Other Project");
    expect(result).toContain("Private Project");
    expect(result).toContain("slug: test");
  });

  // ── search_cross_project ──────────────────────────────

  it("search_cross_project rejects access to private project", async () => {
    const handler = getHandler("search_cross_project");
    await expect(
      handler({ query: "test", project_slug: "private" })
    ).rejects.toThrow("does not allow cross-project access");
  });

  // ── Database helpers ──────────────────────────────────

  it("getChildBloops returns children from DB", () => {
    const now = new Date().toISOString();
    db.createBloop({
      id: "child-x", projectId: "proj-1", parentBloopId: "bloop-root",
      trigger: "child_of", status: "completed", goal: "X",
      messages: [], result: null, toolCalls: [], tokensUsed: 0,
      iterations: 0, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: now,
    });

    const children = db.getChildBloops("bloop-root");
    expect(children).toHaveLength(1);
    expect(children[0].id).toBe("child-x");
  });

  it("countChildBloops returns correct count", () => {
    expect(db.countChildBloops("bloop-root")).toBe(0);

    const now = new Date().toISOString();
    db.createBloop({
      id: "child-c", projectId: "proj-1", parentBloopId: "bloop-root",
      trigger: "child_of", status: "completed", goal: "C",
      messages: [], result: null, toolCalls: [], tokensUsed: 0,
      iterations: 0, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: now,
    });

    expect(db.countChildBloops("bloop-root")).toBe(1);
  });

  it("getBloopAncestorDepth calculates depth correctly", () => {
    expect(db.getBloopAncestorDepth("bloop-root")).toBe(0);

    const now = new Date().toISOString();
    db.createBloop({
      id: "d1", projectId: "proj-1", parentBloopId: "bloop-root",
      trigger: "child_of", status: "running", goal: "D1",
      messages: [], result: null, toolCalls: [], tokensUsed: 0,
      iterations: 0, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: null,
    });
    db.createBloop({
      id: "d2", projectId: "proj-1", parentBloopId: "d1",
      trigger: "child_of", status: "running", goal: "D2",
      messages: [], result: null, toolCalls: [], tokensUsed: 0,
      iterations: 0, maxIterations: 50, createdAt: now, updatedAt: now, completedAt: null,
    });

    expect(db.getBloopAncestorDepth("d1")).toBe(1);
    expect(db.getBloopAncestorDepth("d2")).toBe(2);
  });

  it("getBloopByPartialId finds bloop by prefix", () => {
    const bloop = db.getBloopByPartialId("bloop-r");
    expect(bloop).not.toBeNull();
    expect(bloop!.id).toBe("bloop-root");
  });

  it("updateProject persists context changes", () => {
    const project = db.getProjectBySlug("test")!;
    project.context = { heartbeat: { enabled: true } };
    project.updatedAt = new Date().toISOString();
    db.updateProject(project);

    const updated = db.getProjectBySlug("test")!;
    expect(updated.context).toEqual({ heartbeat: { enabled: true } });
  });

  it("searchMemoryFTSGlobal searches across all projects", async () => {
    // Store memories in different projects
    const now = new Date().toISOString();
    await memory.storeMemory("test", {
      projectId: "proj-1",
      title: "UniqueAlphaTest",
      content: "Test memory in project 1",
      memoryType: "fact",
    });
    await memory.storeMemory("other", {
      projectId: "proj-2",
      title: "UniqueAlphaTest",
      content: "Test memory in project 2",
      memoryType: "fact",
    });

    const results = db.searchMemoryFTSGlobal("UniqueAlphaTest", 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });
});
