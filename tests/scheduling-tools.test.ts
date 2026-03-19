import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { BeerCanDB } from "../src/storage/database.js";
import { createSchedulingTools, isCronTooFrequent } from "../src/tools/builtin/scheduling.js";
import type { BloopContext } from "../src/tools/builtin/memory.js";

function tmpDb(): string {
  return `/tmp/loops-sched-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("Scheduling Tools", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let bloopCtx: BloopContext;
  let schedulesAdded: any[];
  let schedulesRemoved: string[];
  let triggersAdded: any[];
  let triggersRemoved: string[];
  let scheduleList: any[];
  let triggerList: any[];

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    schedulesAdded = [];
    schedulesRemoved = [];
    triggersAdded = [];
    triggersRemoved = [];
    scheduleList = [];
    triggerList = [];

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

    bloopCtx = { bloopId: "bloop-1", projectId: "proj-1", projectSlug: "test" };
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  function makeTools(ctx: BloopContext | null = bloopCtx) {
    return createSchedulingTools(
      {
        getScheduler: () => ({
          addSchedule: (opts: any) => { schedulesAdded.push(opts); return { id: "sched-1" }; },
          removeSchedule: (id: string) => { schedulesRemoved.push(id); },
          listSchedules: () => scheduleList,
        }),
        getEventManager: () => ({
          getTriggerManager: () => ({
            addTrigger: (opts: any) => { triggersAdded.push(opts); return { id: "trig-1" }; },
            removeTrigger: (id: string) => { triggersRemoved.push(id); },
            listTriggers: () => triggerList,
          }),
        }),
      },
      () => ctx,
    );
  }

  function getHandler(name: string, ctx?: BloopContext | null) {
    const tools = makeTools(ctx);
    const tool = tools.find((t) => t.definition.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.handler;
  }

  // ── isCronTooFrequent ────────────────────────────────────

  describe("isCronTooFrequent", () => {
    it("rejects every-minute cron", () => {
      expect(isCronTooFrequent("* * * * *", 5)).toBe(true);
    });

    it("rejects */2 when min is 5", () => {
      expect(isCronTooFrequent("*/2 * * * *", 5)).toBe(true);
    });

    it("accepts */5 when min is 5", () => {
      expect(isCronTooFrequent("*/5 * * * *", 5)).toBe(false);
    });

    it("accepts */30 when min is 5", () => {
      expect(isCronTooFrequent("*/30 * * * *", 5)).toBe(false);
    });

    it("accepts daily cron", () => {
      expect(isCronTooFrequent("0 9 * * *", 5)).toBe(false);
    });

    it("rejects comma-separated minutes too close", () => {
      expect(isCronTooFrequent("0,2,4 * * * *", 5)).toBe(true);
    });

    it("accepts comma-separated minutes far enough apart", () => {
      expect(isCronTooFrequent("0,15,30,45 * * * *", 5)).toBe(false);
    });

    it("rejects range without step", () => {
      expect(isCronTooFrequent("0-30 * * * *", 5)).toBe(true);
    });
  });

  // ── create_schedule ──────────────────────────────────────

  it("creates a valid schedule", async () => {
    const handler = getHandler("create_schedule");
    const result = await handler({
      cron_expression: "0 9 * * 1-5",
      goal: "Daily standup check",
      description: "Check PRs every morning",
    });

    expect(result).toContain("sched-1");
    expect(schedulesAdded).toHaveLength(1);
    expect(schedulesAdded[0]).toMatchObject({
      projectId: "proj-1",
      projectSlug: "test",
      cronExpression: "0 9 * * 1-5",
      goal: "Daily standup check",
    });
  });

  it("rejects invalid cron expression", async () => {
    const handler = getHandler("create_schedule");
    await expect(
      handler({ cron_expression: "invalid cron", goal: "Test" })
    ).rejects.toThrow("Invalid cron expression");
  });

  it("rejects too-frequent cron", async () => {
    const handler = getHandler("create_schedule");
    await expect(
      handler({ cron_expression: "*/2 * * * *", goal: "Too fast" })
    ).rejects.toThrow("too frequently");
  });

  it("rejects when max schedules reached", async () => {
    // Fill up schedules
    for (let i = 0; i < 20; i++) {
      scheduleList.push({ id: `s-${i}`, cronExpression: "0 9 * * *", goal: `G${i}`, team: "solo", enabled: true, lastRunAt: null });
    }

    const handler = getHandler("create_schedule");
    await expect(
      handler({ cron_expression: "0 9 * * *", goal: "One too many" })
    ).rejects.toThrow("Max schedules reached");
  });

  // ── create_trigger ───────────────────────────────────────

  it("creates a valid trigger", async () => {
    const handler = getHandler("create_trigger");
    const result = await handler({
      event_type: "bloop:completed",
      goal_template: "Analyze result of {{data.bloopId}}",
    });

    expect(result).toContain("trig-1");
    expect(triggersAdded).toHaveLength(1);
    expect(triggersAdded[0]).toMatchObject({
      projectId: "proj-1",
      eventType: "bloop:completed",
      goalTemplate: "Analyze result of {{data.bloopId}}",
    });
  });

  it("rejects invalid regex pattern", async () => {
    const handler = getHandler("create_trigger");
    await expect(
      handler({ event_type: "test", filter_pattern: "[invalid", goal_template: "Test" })
    ).rejects.toThrow("Invalid regex pattern");
  });

  it("rejects when max triggers reached", async () => {
    for (let i = 0; i < 20; i++) {
      triggerList.push({ id: `t-${i}`, projectSlug: "test", eventType: "test", filterPattern: ".*", goalTemplate: "G", team: "solo", enabled: true });
    }

    const handler = getHandler("create_trigger");
    await expect(
      handler({ event_type: "test", goal_template: "One too many" })
    ).rejects.toThrow("Max triggers reached");
  });

  // ── list_schedules ───────────────────────────────────────

  it("lists schedules", async () => {
    scheduleList.push({
      id: "s-1", cronExpression: "0 9 * * *", goal: "Morning check",
      team: "solo", enabled: true, lastRunAt: null, description: "PR review",
    });

    const handler = getHandler("list_schedules");
    const result = await handler({});

    expect(result).toContain("Morning check");
    expect(result).toContain("0 9 * * *");
    expect(result).toContain("PR review");
  });

  it("returns empty message when no schedules", async () => {
    const handler = getHandler("list_schedules");
    const result = await handler({});
    expect(result).toContain("No schedules found");
  });

  // ── list_triggers ────────────────────────────────────────

  it("lists triggers", async () => {
    triggerList.push({
      id: "t-1", projectSlug: "test", eventType: "bloop:completed",
      filterPattern: ".*", goalTemplate: "Check {{data.bloopId}}", team: "solo", enabled: true,
    });

    const handler = getHandler("list_triggers");
    const result = await handler({});

    expect(result).toContain("bloop:completed");
    expect(result).toContain("Check {{data.bloopId}}");
  });

  // ── remove_schedule ──────────────────────────────────────

  it("removes a schedule", async () => {
    scheduleList.push({ id: "s-del", cronExpression: "0 9 * * *", goal: "X", team: "solo", enabled: true, lastRunAt: null });

    const handler = getHandler("remove_schedule");
    const result = await handler({ schedule_id: "s-del" });

    expect(result).toContain("removed");
    expect(schedulesRemoved).toEqual(["s-del"]);
  });

  it("rejects removing schedule from other project", async () => {
    // scheduleList is empty for "test" project
    const handler = getHandler("remove_schedule");
    await expect(
      handler({ schedule_id: "unknown-id" })
    ).rejects.toThrow("Schedule not found in project");
  });

  // ── remove_trigger ───────────────────────────────────────

  it("removes a trigger", async () => {
    triggerList.push({ id: "t-del", projectSlug: "test", eventType: "test", filterPattern: ".*", goalTemplate: "X", team: "solo", enabled: true });

    const handler = getHandler("remove_trigger");
    const result = await handler({ trigger_id: "t-del" });

    expect(result).toContain("removed");
    expect(triggersRemoved).toEqual(["t-del"]);
  });

  it("rejects removing trigger from other project", async () => {
    const handler = getHandler("remove_trigger");
    await expect(
      handler({ trigger_id: "unknown-id" })
    ).rejects.toThrow("Trigger not found in project");
  });

  // ── no context ───────────────────────────────────────────

  it("throws when no bloop context", async () => {
    const handler = getHandler("create_schedule", null);
    await expect(
      handler({ cron_expression: "0 9 * * *", goal: "Test" })
    ).rejects.toThrow("No active bloop context");
  });
});
