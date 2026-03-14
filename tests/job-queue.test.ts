import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { BeerCanDB } from "../src/storage/database.js";
import { JobQueue } from "../src/core/job-queue.js";

function tmpDb(): string {
  return `/tmp/loops-jq-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("JobQueue", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let queue: JobQueue;
  const executed: string[] = [];

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    queue = new JobQueue(db, 2); // max 2 concurrent
    executed.length = 0;

    // Create a test project for FK references
    const now = new Date().toISOString();
    db.createProject({
      id: "test-proj-id",
      name: "Test",
      slug: "test",
      context: {},
      allowedTools: ["*"],
      tokenBudget: { dailyLimit: 100000, perLoopLimit: 20000 },
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

  it("enqueues jobs and tracks stats", () => {
    // No executor set — jobs stay pending
    const id1 = queue.enqueue({ projectSlug: "test", goal: "Task 1" });
    const id2 = queue.enqueue({ projectSlug: "test", goal: "Task 2" });

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();

    const stats = queue.getStats();
    expect(stats.pending).toBe(2);
    expect(stats.running).toBe(0);
  });

  it("lists jobs", () => {
    queue.enqueue({ projectSlug: "test", goal: "First" });
    queue.enqueue({ projectSlug: "test", goal: "Second" });

    const jobs = queue.listJobs();
    expect(jobs).toHaveLength(2);
    const goals = jobs.map((j) => j.goal).sort();
    expect(goals).toEqual(["First", "Second"]);
  });

  it("respects priority ordering", () => {
    queue.enqueue({ projectSlug: "test", goal: "Low priority", priority: 0 });
    queue.enqueue({ projectSlug: "test", goal: "High priority", priority: 10 });
    queue.enqueue({ projectSlug: "test", goal: "Medium priority", priority: 5 });

    // claimNextJob should return highest priority first
    const first = db.claimNextJob();
    expect(first).not.toBeNull();
    expect(first!.goal).toBe("High priority");

    const second = db.claimNextJob();
    expect(second!.goal).toBe("Medium priority");

    const third = db.claimNextJob();
    expect(third!.goal).toBe("Low priority");
  });

  it("claims jobs atomically (no double-claim)", () => {
    queue.enqueue({ projectSlug: "test", goal: "Only one" });

    const first = db.claimNextJob();
    expect(first).not.toBeNull();

    // Second claim should return null — no more pending
    const second = db.claimNextJob();
    expect(second).toBeNull();
  });

  it("processes jobs with executor", async () => {
    const results: string[] = [];

    queue.setExecutor(async (opts) => {
      results.push(opts.goal);
      return { id: "", status: "completed" }; // empty id = no loop_id FK
    });

    queue.enqueue({ projectSlug: "test", goal: "A" });
    queue.enqueue({ projectSlug: "test", goal: "B" });

    // Wait for processing
    await queue.drain();

    expect(results.sort()).toEqual(["A", "B"]);

    const stats = queue.getStats();
    expect(stats.completed).toBe(2);
    expect(stats.pending).toBe(0);
    expect(stats.running).toBe(0);
  });

  it("handles executor failures", async () => {
    queue.setExecutor(async (opts) => {
      if (opts.goal === "fail") throw new Error("Boom");
      return { id: "", status: "completed" };
    });

    queue.enqueue({ projectSlug: "test", goal: "succeed" });
    queue.enqueue({ projectSlug: "test", goal: "fail" });

    await queue.drain();

    const stats = queue.getStats();
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);

    const failed = queue.listJobs("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe("Boom");
  });

  it("respects concurrency limit", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    queue.setExecutor(async (opts) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50)); // Simulate work
      concurrent--;
      return { id: "", status: "completed" };
    });

    // Enqueue 5 jobs with concurrency limit of 2
    for (let i = 0; i < 5; i++) {
      queue.enqueue({ projectSlug: "test", goal: `Job ${i}` });
    }

    await queue.drain();

    expect(maxConcurrent).toBeLessThanOrEqual(2);

    const stats = queue.getStats();
    expect(stats.completed).toBe(5);
  });

  it("filters jobs by status", () => {
    queue.enqueue({ projectSlug: "test", goal: "A" });
    queue.enqueue({ projectSlug: "test", goal: "B" });

    const pending = queue.listJobs("pending");
    expect(pending).toHaveLength(2);

    const running = queue.listJobs("running");
    expect(running).toHaveLength(0);
  });

  it("stores source and sourceId", () => {
    queue.enqueue({
      projectSlug: "test",
      goal: "Cron task",
      source: "cron",
      sourceId: "schedule-123",
    });

    const jobs = queue.listJobs();
    expect(jobs[0].source).toBe("cron");
    expect(jobs[0].sourceId).toBe("schedule-123");
  });
});
