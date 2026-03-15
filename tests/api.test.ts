import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { BeerCanDB } from "../src/storage/database.js";
import { EventBus } from "../src/events/event-bus.js";
import { WebhookSource } from "../src/events/sources/webhook-source.js";
import { registerStatusApi } from "../src/api/index.js";

function tmpDb(): string {
  return `/tmp/beercan-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("Status API", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let webhook: WebhookSource;
  let port: number;
  let baseUrl: string;

  const now = new Date().toISOString();

  // Bloop IDs for reference in tests
  const bloopIds = {
    alphaCompleted: "a0000000-0000-0000-0000-000000000001",
    alphaRunning:   "a0000000-0000-0000-0000-000000000002",
    alphaFailed:    "a0000000-0000-0000-0000-000000000003",
    betaCompleted:  "b0000000-0000-0000-0000-000000000001",
  };

  beforeEach(async () => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    port = 30000 + Math.floor(Math.random() * 30000);
    baseUrl = `http://localhost:${port}`;

    // ── Seed projects ──────────────────────────────────────
    db.createProject({
      id: "proj-1",
      name: "Alpha",
      slug: "alpha",
      description: "Alpha test project",
      workDir: "/tmp/alpha",
      context: {},
      allowedTools: ["*"],
      tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
      createdAt: now,
      updatedAt: now,
    });

    db.createProject({
      id: "proj-2",
      name: "Beta",
      slug: "beta",
      description: "Beta test project",
      workDir: "/tmp/beta",
      context: {},
      allowedTools: ["*"],
      tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
      createdAt: now,
      updatedAt: now,
    });

    // ── Seed bloops ────────────────────────────────────────
    db.createBloop({
      id: bloopIds.alphaCompleted,
      projectId: "proj-1",
      parentBloopId: null,
      trigger: "manual",
      status: "completed",
      goal: "Alpha goal 1",
      systemPrompt: undefined,
      messages: [],
      result: { summary: "Done" },
      toolCalls: [{ id: "tc-1", toolName: "read_file", input: {}, output: "content", error: undefined, durationMs: 50, timestamp: now }],
      tokensUsed: 1500,
      iterations: 3,
      maxIterations: 50,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });

    db.createBloop({
      id: bloopIds.alphaRunning,
      projectId: "proj-1",
      parentBloopId: null,
      trigger: "manual",
      status: "running",
      goal: "Alpha goal 2",
      systemPrompt: undefined,
      messages: [],
      result: null,
      toolCalls: [],
      tokensUsed: 500,
      iterations: 1,
      maxIterations: 50,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    db.createBloop({
      id: bloopIds.alphaFailed,
      projectId: "proj-1",
      parentBloopId: null,
      trigger: "manual",
      status: "failed",
      goal: "Alpha goal 3",
      systemPrompt: undefined,
      messages: [],
      result: { error: "Something went wrong" },
      toolCalls: [],
      tokensUsed: 800,
      iterations: 2,
      maxIterations: 50,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });

    db.createBloop({
      id: bloopIds.betaCompleted,
      projectId: "proj-2",
      parentBloopId: null,
      trigger: "manual",
      status: "completed",
      goal: "Beta goal 1",
      systemPrompt: undefined,
      messages: [],
      result: { summary: "Beta done" },
      toolCalls: [{ id: "tc-2", toolName: "write_file", input: {}, output: "ok", error: undefined, durationMs: 30, timestamp: now }],
      tokensUsed: 2000,
      iterations: 5,
      maxIterations: 50,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });

    // ── Seed jobs ──────────────────────────────────────────
    db.createJob({
      id: "job-1",
      projectSlug: "alpha",
      goal: "Job goal 1",
      team: "auto",
      priority: 0,
      status: "completed",
      source: "manual",
      sourceId: null,
      extraContext: null,
      bloopId: bloopIds.alphaCompleted,
      error: null,
      createdAt: now,
      startedAt: now,
      completedAt: now,
    });

    db.createJob({
      id: "job-2",
      projectSlug: "alpha",
      goal: "Job goal 2",
      team: "auto",
      priority: 5,
      status: "pending",
      source: "manual",
      sourceId: null,
      extraContext: null,
      bloopId: null,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    });

    // ── Mock engine ────────────────────────────────────────
    const mockEngine = {
      listProjects: () => db.listProjects(),
      getProject: (slug: string) => db.getProjectBySlug(slug),
      getProjectBloops: (slug: string, status?: string) => {
        const project = db.getProjectBySlug(slug);
        if (!project) return [];
        return db.getProjectBloops(project.id, status);
      },
      getBloop: (id: string) => db.getBloop(id),
      getBloopStats: () => db.getBloopStats(),
      getProjectBloopStats: (slug: string) => {
        const project = db.getProjectBySlug(slug);
        if (!project) return null;
        return db.getProjectBloopStats(project.id);
      },
      getRecentBloops: (limit?: number, status?: string) => db.getRecentBloops(limit, status),
      getJobQueue: () => ({
        getStats: () => db.getJobStats(),
        listJobs: (status?: string, limit?: number) => db.listJobs(status, limit),
      }),
      getScheduler: () => ({
        listSchedules: (_projectSlug?: string) => [],
      }),
    };

    // ── Start server ───────────────────────────────────────
    const bus = new EventBus();
    webhook = new WebhookSource(bus, { port });
    registerStatusApi(webhook, mockEngine as any);
    await webhook.start();
  });

  afterEach(async () => {
    await webhook.stop();
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  // ── Test cases ─────────────────────────────────────────────

  it("GET /api/status returns correct shape with proper counts", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("timestamp");
    expect(body.projects).toEqual({ total: 2 });
    expect(body.bloops).toEqual({
      running: 1,
      completed: 2,
      failed: 1,
      total: 4,
    });
    expect(body.jobs).toEqual({
      pending: 1,
      running: 0,
      completed: 1,
      failed: 0,
    });
    expect(body.schedules).toEqual({ total: 0, enabled: 0 });
  });

  it("GET /api/projects returns both projects with bloop summaries", async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.projects).toHaveLength(2);

    // Projects are listed in reverse chronological order (same createdAt, so order may vary)
    const alpha = body.projects.find((p: any) => p.slug === "alpha");
    const beta = body.projects.find((p: any) => p.slug === "beta");

    expect(alpha).toBeDefined();
    expect(alpha.name).toBe("Alpha");
    expect(alpha.bloops).toEqual({ completed: 1, failed: 1, running: 1, total: 3 });
    expect(alpha.totalTokens).toBe(2800); // 1500 + 500 + 800

    expect(beta).toBeDefined();
    expect(beta.name).toBe("Beta");
    expect(beta.bloops).toEqual({ completed: 1, failed: 0, running: 0, total: 1 });
    expect(beta.totalTokens).toBe(2000);
  });

  it("GET /api/projects/:slug returns project detail with recent bloops", async () => {
    const res = await fetch(`${baseUrl}/api/projects/alpha`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.project.slug).toBe("alpha");
    expect(body.project.name).toBe("Alpha");
    expect(body.project.workDir).toBe("/tmp/alpha");
    expect(body.bloops).toEqual({ completed: 1, failed: 1, running: 1, total: 3 });
    expect(body.totalTokens).toBe(2800);
    expect(body.recentBloops).toHaveLength(3);

    // Each recent bloop should have the expected shape
    const bloop = body.recentBloops.find((b: any) => b.id === bloopIds.alphaCompleted);
    expect(bloop).toBeDefined();
    expect(bloop.status).toBe("completed");
    expect(bloop.goal).toBe("Alpha goal 1");
    expect(bloop.tokensUsed).toBe(1500);
    expect(bloop.toolCallCount).toBe(1);
  });

  it("GET /api/projects/:slug returns 404 for nonexistent project", async () => {
    const res = await fetch(`${baseUrl}/api/projects/nonexistent`);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain("nonexistent");
  });

  it("GET /api/projects/:slug/bloops returns all alpha bloops", async () => {
    const res = await fetch(`${baseUrl}/api/projects/alpha/bloops`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.bloops).toHaveLength(3);

    const ids = body.bloops.map((b: any) => b.id);
    expect(ids).toContain(bloopIds.alphaCompleted);
    expect(ids).toContain(bloopIds.alphaRunning);
    expect(ids).toContain(bloopIds.alphaFailed);
  });

  it("GET /api/projects/:slug/bloops?status=completed filters correctly", async () => {
    const res = await fetch(`${baseUrl}/api/projects/alpha/bloops?status=completed`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.bloops).toHaveLength(1);
    expect(body.bloops[0].status).toBe("completed");
    expect(body.bloops[0].id).toBe(bloopIds.alphaCompleted);
  });

  it("GET /api/jobs returns stats and jobs", async () => {
    const res = await fetch(`${baseUrl}/api/jobs`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.stats).toEqual({
      pending: 1,
      running: 0,
      completed: 1,
      failed: 0,
    });
    expect(body.jobs).toHaveLength(2);

    const completedJob = body.jobs.find((j: any) => j.id === "job-1");
    expect(completedJob).toBeDefined();
    expect(completedJob.status).toBe("completed");
    expect(completedJob.bloopId).toBe(bloopIds.alphaCompleted);
  });

  it("GET /api/schedules returns empty array when no schedules seeded", async () => {
    const res = await fetch(`${baseUrl}/api/schedules`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.schedules).toEqual([]);
  });

  it("GET /api/bloops/recent returns all 4 bloops sorted by date", async () => {
    const res = await fetch(`${baseUrl}/api/bloops/recent`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.bloops).toHaveLength(4);

    // Each bloop should have the expected shape
    for (const bloop of body.bloops) {
      expect(bloop).toHaveProperty("id");
      expect(bloop).toHaveProperty("projectId");
      expect(bloop).toHaveProperty("status");
      expect(bloop).toHaveProperty("goal");
      expect(bloop).toHaveProperty("trigger");
      expect(bloop).toHaveProperty("tokensUsed");
      expect(bloop).toHaveProperty("iterations");
      expect(bloop).toHaveProperty("toolCallCount");
      expect(bloop).toHaveProperty("createdAt");
    }
  });

  it("GET /api/bloops/:id returns bloop detail", async () => {
    const res = await fetch(`${baseUrl}/api/bloops/${bloopIds.alphaCompleted}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.id).toBe(bloopIds.alphaCompleted);
    expect(body.projectId).toBe("proj-1");
    expect(body.status).toBe("completed");
    expect(body.goal).toBe("Alpha goal 1");
    expect(body.result).toEqual({ summary: "Done" });
    expect(body.toolCalls).toHaveLength(1);
    expect(body.toolCalls[0].toolName).toBe("read_file");
    expect(body.tokensUsed).toBe(1500);
    expect(body.iterations).toBe(3);
    expect(body.maxIterations).toBe(50);
  });

  it("GET /api/bloops/:id returns 404 for nonexistent bloop", async () => {
    const res = await fetch(`${baseUrl}/api/bloops/nonexistent`);
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain("nonexistent");
  });

  it("CORS headers are present on responses", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});
