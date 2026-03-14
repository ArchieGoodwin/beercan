import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import type { BeerCanDB } from "../storage/database.js";

// ── Schedule Schema ─────────────────────────────────────────

export const ScheduleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectSlug: z.string(),
  cronExpression: z.string(),
  goal: z.string(),
  team: z.string().default("solo"),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  lastRunAt: z.string().nullable().default(null),
  nextRunAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

// ── Types for the engine reference ──────────────────────────

export interface BloopExecutor {
  runBloop(opts: {
    projectSlug: string;
    goal: string;
    team?: string;
    onEvent?: (event: any) => void;
  }): Promise<any>;
}

// ── Scheduler ───────────────────────────────────────────────

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private db: BeerCanDB;
  private executor: BloopExecutor;
  private running = false;

  constructor(db: BeerCanDB, executor: BloopExecutor) {
    this.db = db;
    this.executor = executor;
  }

  /** Load all enabled schedules from DB and create cron tasks */
  init(): void {
    const schedules = this.db.listSchedules();
    for (const schedule of schedules) {
      if (schedule.enabled) {
        this.createTask(schedule);
      }
    }
  }

  /** Start all cron tasks */
  start(): void {
    this.running = true;
    for (const task of this.tasks.values()) {
      task.start();
    }
    console.log(`[scheduler] Started ${this.tasks.size} scheduled tasks`);
  }

  /** Stop all cron tasks */
  stop(): void {
    this.running = false;
    for (const task of this.tasks.values()) {
      task.stop();
    }
    console.log("[scheduler] Stopped all tasks");
  }

  /** Add a new schedule */
  addSchedule(opts: {
    projectId: string;
    projectSlug: string;
    cronExpression: string;
    goal: string;
    team?: string;
    description?: string;
  }): Schedule {
    if (!cron.validate(opts.cronExpression)) {
      throw new Error(`Invalid cron expression: ${opts.cronExpression}`);
    }

    const now = new Date().toISOString();
    const schedule: Schedule = {
      id: uuid(),
      projectId: opts.projectId,
      projectSlug: opts.projectSlug,
      cronExpression: opts.cronExpression,
      goal: opts.goal,
      team: opts.team ?? "solo",
      description: opts.description,
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.createSchedule(schedule);

    if (this.running) {
      this.createTask(schedule);
    }

    return schedule;
  }

  /** Remove a schedule */
  removeSchedule(scheduleId: string): void {
    const task = this.tasks.get(scheduleId);
    if (task) {
      task.stop();
      this.tasks.delete(scheduleId);
    }
    this.db.deleteSchedule(scheduleId);
  }

  /** List all schedules */
  listSchedules(projectSlug?: string): Schedule[] {
    return this.db.listSchedules(projectSlug);
  }

  /** Manually trigger a schedule */
  async executeSchedule(scheduleId: string): Promise<void> {
    const schedule = this.db.getSchedule(scheduleId);
    if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);
    await this.runScheduledBloop(schedule);
  }

  // ── Internal ──────────────────────────────────────────────

  private createTask(schedule: Schedule): void {
    // Use createTask to avoid auto-starting; we manage start/stop ourselves
    const task = cron.createTask(
      schedule.cronExpression,
      async () => {
        await this.runScheduledBloop(schedule);
      }
    );

    this.tasks.set(schedule.id, task);

    if (this.running) {
      task.start();
    }
  }

  private async runScheduledBloop(schedule: Schedule): Promise<void> {
    console.log(`[scheduler] Triggering: ${schedule.goal} (${schedule.projectSlug})`);

    try {
      await this.executor.runBloop({
        projectSlug: schedule.projectSlug,
        goal: schedule.goal,
        team: schedule.team,
      });

      // Update last run time
      this.db.updateScheduleRun(schedule.id, new Date().toISOString());
    } catch (err: any) {
      console.error(`[scheduler] Failed: ${err.message}`);
    }
  }
}
