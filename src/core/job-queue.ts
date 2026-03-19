import { v4 as uuid } from "uuid";
import { getLogger } from "./logger.js";
import type { BeerCanDB } from "../storage/database.js";

// ── Job Queue ───────────────────────────────────────────────
// SQLite-backed job queue with concurrency semaphore.
// All bloop execution from scheduler/triggers goes through here.

export interface EnqueueOptions {
  projectSlug: string;
  goal: string;
  team?: string;
  priority?: number;
  source?: "manual" | "cron" | "event";
  sourceId?: string;
  extraContext?: string;
  parentBloopId?: string;
}

export interface Job {
  id: string;
  projectSlug: string;
  goal: string;
  team: string;
  priority: number;
  status: "pending" | "running" | "completed" | "failed" | "timeout" | "cancelled";
  source: string;
  sourceId: string | null;
  extraContext: string | null;
  parentBloopId: string | null;
  bloopId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export class JobQueue {
  private running = new Map<string, Promise<void>>();
  private abortControllers = new Map<string, AbortController>();
  private maxConcurrent: number;
  private db: BeerCanDB;
  private executor: ((opts: { projectSlug: string; goal: string; team: string; extraContext?: string; parentBloopId?: string; signal?: AbortSignal }) => Promise<{ id: string; status: string }>) | null = null;

  constructor(db: BeerCanDB, maxConcurrent: number) {
    this.db = db;
    this.maxConcurrent = maxConcurrent;
  }

  /** Set the bloop executor (called after engine is fully initialized) */
  setExecutor(fn: (opts: { projectSlug: string; goal: string; team: string; extraContext?: string; parentBloopId?: string; signal?: AbortSignal }) => Promise<{ id: string; status: string }>): void {
    this.executor = fn;
  }

  /** Enqueue a new job. Returns job ID. */
  enqueue(opts: EnqueueOptions): string {
    const log = getLogger();
    const id = uuid();
    const now = new Date().toISOString();

    this.db.createJob({
      id,
      projectSlug: opts.projectSlug,
      goal: opts.goal,
      team: opts.team ?? "auto",
      priority: opts.priority ?? 0,
      status: "pending",
      source: opts.source ?? "manual",
      sourceId: opts.sourceId ?? null,
      extraContext: opts.extraContext ?? null,
      parentBloopId: opts.parentBloopId ?? null,
      bloopId: null,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
    });

    log.info("queue", `Job enqueued: ${opts.goal.slice(0, 60)}`, {
      jobId: id, projectSlug: opts.projectSlug, source: opts.source ?? "manual", priority: opts.priority ?? 0,
    });

    // Try to process immediately
    this.processNext();

    return id;
  }

  /** Process the next pending job if under concurrency limit. */
  processNext(): void {
    if (!this.executor) return;
    if (this.running.size >= this.maxConcurrent) return;

    const job = this.db.claimNextJob();
    if (!job) return;

    const log = getLogger();
    log.info("queue", `Job started: ${job.goal.slice(0, 60)}`, { jobId: job.id, running: this.running.size + 1 });

    const promise = this.executeJob(job);
    this.running.set(job.id, promise);

    promise.finally(() => {
      this.running.delete(job.id);
      // Try to process next after completion
      this.processNext();
    });

    // Try to fill more slots
    if (this.running.size < this.maxConcurrent) {
      this.processNext();
    }
  }

  private async executeJob(job: Job): Promise<void> {
    const log = getLogger();
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);

    try {
      const result = await this.executor!({
        projectSlug: job.projectSlug,
        goal: job.goal,
        team: job.team,
        extraContext: job.extraContext ?? undefined,
        parentBloopId: job.parentBloopId ?? undefined,
        signal: controller.signal,
      });

      this.db.updateJob(job.id, {
        status: "completed",
        bloopId: result.id,
        completedAt: new Date().toISOString(),
      });

      log.info("queue", `Job completed: ${job.goal.slice(0, 60)}`, {
        jobId: job.id, bloopId: result.id, bloopStatus: result.status,
      });
    } catch (err: any) {
      this.db.updateJob(job.id, {
        status: "failed",
        error: err.message,
        completedAt: new Date().toISOString(),
      });

      log.error("queue", `Job failed: ${err.message}`, { jobId: job.id });
    } finally {
      this.abortControllers.delete(job.id);
    }
  }

  /** Cancel a pending or running job. */
  cancelJob(jobId: string): { cancelled: boolean; status?: string; reason?: string } {
    const log = getLogger();
    const job = this.db.getJob(jobId);

    if (!job) {
      return { cancelled: false, reason: "Job not found" };
    }

    if (job.status === "completed" || job.status === "failed" || job.status === "timeout" || job.status === "cancelled") {
      return { cancelled: false, status: job.status, reason: `Job already ${job.status}` };
    }

    if (job.status === "pending") {
      this.db.updateJob(jobId, { status: "cancelled", error: "Cancelled by user", completedAt: new Date().toISOString() });
      log.info("queue", `Job cancelled (pending): ${jobId}`);
      return { cancelled: true, status: "cancelled" };
    }

    if (job.status === "running") {
      const controller = this.abortControllers.get(jobId);
      if (controller) {
        controller.abort(new Error("Cancelled by user"));
      }
      this.db.updateJob(jobId, { status: "cancelled", error: "Cancelled by user", completedAt: new Date().toISOString() });
      log.info("queue", `Job cancelled (running): ${jobId}`);
      return { cancelled: true, status: "cancelled" };
    }

    return { cancelled: false, reason: `Unexpected job status: ${job.status}` };
  }

  /** Get queue statistics. */
  getStats(): JobStats {
    return this.db.getJobStats();
  }

  /** List jobs, optionally filtered by status. */
  listJobs(status?: string, limit = 20): Job[] {
    return this.db.listJobs(status, limit);
  }

  /** Wait for all running AND pending jobs to complete. */
  async drain(): Promise<void> {
    const log = getLogger();
    while (true) {
      if (this.running.size > 0) {
        log.info("queue", `Draining ${this.running.size} running jobs...`);
        await Promise.allSettled(Array.from(this.running.values()));
        continue; // Check again — processNext may have started new jobs
      }
      // Check if there are still pending jobs
      const stats = this.getStats();
      if (stats.pending > 0 && this.executor) {
        // Kick processing and wait a tick
        this.processNext();
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      break;
    }
  }
}
