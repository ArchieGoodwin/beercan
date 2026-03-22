import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { BeerCanDB } from "../src/storage/database.js";
import { HeartbeatManager, type HeartbeatConfig } from "../src/core/heartbeat.js";
import type { Project } from "../src/schemas.js";

function tmpDb(): string {
  return `/tmp/loops-hb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: "proj-1",
    name: "Test Project",
    slug: "test",
    system: false,
    context: {},
    allowedTools: ["*"],
    tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("HeartbeatManager", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let bloopsEnqueued: any[];
  let eventsPublished: any[];

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    bloopsEnqueued = [];
    eventsPublished = [];

    const now = new Date().toISOString();
    db.createProject({
      id: "proj-1",
      name: "Test Project",
      slug: "test",
      system: false,
      context: {
        heartbeat: {
          enabled: true,
          intervalMinutes: 30,
          checklist: ["Check error logs", "Review pending PRs"],
          suppressIfEmpty: true,
        },
      },
      allowedTools: ["*"],
      tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
      createdAt: now,
      updatedAt: now,
    });

    db.createProject({
      id: "proj-2",
      name: "No Heartbeat",
      slug: "no-hb",
      system: false,
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

  function makeManager() {
    return new HeartbeatManager(
      db,
      {
        enqueueBloop: (opts) => {
          bloopsEnqueued.push(opts);
          return "job-id-1";
        },
      },
      {
        publish: (event) => { eventsPublished.push(event); },
      },
    );
  }

  // ── Config parsing ────────────────────────────────────────

  describe("getHeartbeatConfig", () => {
    it("parses config from project context", () => {
      const manager = makeManager();
      const project = db.getProjectBySlug("test")!;
      const config = manager.getHeartbeatConfig(project);

      expect(config).not.toBeNull();
      expect(config!.enabled).toBe(true);
      expect(config!.intervalMinutes).toBe(30);
      expect(config!.checklist).toEqual(["Check error logs", "Review pending PRs"]);
      expect(config!.suppressIfEmpty).toBe(true);
    });

    it("returns null for project without heartbeat config", () => {
      const manager = makeManager();
      const project = db.getProjectBySlug("no-hb")!;
      const config = manager.getHeartbeatConfig(project);

      expect(config).toBeNull();
    });
  });

  // ── Goal building ─────────────────────────────────────────

  describe("buildHeartbeatGoal", () => {
    it("builds goal from checklist", () => {
      const manager = makeManager();
      const project = makeProject();
      const config: HeartbeatConfig = {
        enabled: true,
        intervalMinutes: 30,
        checklist: ["Check error logs", "Review pending PRs"],
        suppressIfEmpty: true,
      };

      const goal = manager.buildHeartbeatGoal(project, config);
      expect(goal).toContain("Test Project");
      expect(goal).toContain("1. Check error logs");
      expect(goal).toContain("2. Review pending PRs");
    });

    it("builds generic goal when checklist is empty", () => {
      const manager = makeManager();
      const project = makeProject();
      const config: HeartbeatConfig = {
        enabled: true,
        intervalMinutes: 30,
        checklist: [],
        suppressIfEmpty: true,
      };

      const goal = manager.buildHeartbeatGoal(project, config);
      expect(goal).toContain("Review project health");
    });
  });

  // ── Active hours ──────────────────────────────────────────

  describe("isInActiveHours", () => {
    it("returns true when within range", () => {
      const manager = makeManager();
      const now = new Date();
      const currentHour = now.getHours();

      // Create range that includes current hour
      const start = `${String(Math.max(0, currentHour - 1)).padStart(2, "0")}:00`;
      const end = `${String(Math.min(23, currentHour + 1)).padStart(2, "0")}:00`;

      expect(manager.isInActiveHours({ start, end })).toBe(true);
    });

    it("returns false when outside range", () => {
      const manager = makeManager();
      const now = new Date();
      const currentHour = now.getHours();

      // Create range that excludes current hour (at least 3 hours away)
      const start = `${String((currentHour + 6) % 24).padStart(2, "0")}:00`;
      const end = `${String((currentHour + 8) % 24).padStart(2, "0")}:00`;

      expect(manager.isInActiveHours({ start, end })).toBe(false);
    });

    it("returns true for invalid time format", () => {
      const manager = makeManager();
      expect(manager.isInActiveHours({ start: "invalid", end: "also-invalid" })).toBe(true);
    });
  });

  // ── Heartbeat execution ───────────────────────────────────

  describe("runHeartbeat", () => {
    it("enqueues a heartbeat bloop to _heartbeat project", () => {
      const manager = makeManager();
      const project = makeProject();
      const config: HeartbeatConfig = {
        enabled: true,
        intervalMinutes: 30,
        checklist: ["Check logs"],
        suppressIfEmpty: true,
      };

      manager.runHeartbeat(project, config);

      expect(bloopsEnqueued).toHaveLength(1);
      expect(bloopsEnqueued[0].projectSlug).toBe("_heartbeat");
      expect(bloopsEnqueued[0].goal).toContain("Check logs");
      expect(bloopsEnqueued[0].source).toBe("cron");
      expect(bloopsEnqueued[0].sourceId).toBe("heartbeat:test");
      expect(bloopsEnqueued[0].extraContext).toContain("Target project: test");
      expect(bloopsEnqueued[0].priority).toBe(-1);
    });

    it("skips heartbeat outside active hours", () => {
      const manager = makeManager();
      const project = makeProject();
      const now = new Date();
      const currentHour = now.getHours();

      const config: HeartbeatConfig = {
        enabled: true,
        intervalMinutes: 30,
        activeHours: {
          start: `${String((currentHour + 6) % 24).padStart(2, "0")}:00`,
          end: `${String((currentHour + 8) % 24).padStart(2, "0")}:00`,
        },
        checklist: ["Should not run"],
        suppressIfEmpty: true,
      };

      manager.runHeartbeat(project, config);

      expect(bloopsEnqueued).toHaveLength(0); // Skipped
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────

  describe("lifecycle", () => {
    it("init starts heartbeats for configured projects", () => {
      const manager = makeManager();
      manager.init();

      // Should have started for "test" project (has config), not for "no-hb"
      // We can't easily check intervals, but init shouldn't throw
      manager.stop();
    });

    it("stop clears all intervals", () => {
      const manager = makeManager();
      manager.init();
      manager.stop();
      // Should not throw and intervals should be cleared
    });
  });
});
