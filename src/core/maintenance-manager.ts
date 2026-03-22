// ── Maintenance Manager ───────────────────────────────────────
// Periodic system maintenance: memory consolidation, stale job
// cleanup, reflection consolidation, cross-project pattern analysis.
// Routes through the _maintenance system project via job queue.

export interface MaintenanceExecutor {
  enqueueBloop(opts: {
    projectSlug: string;
    goal: string;
    source?: "manual" | "cron" | "event";
    sourceId?: string;
    extraContext?: string;
    priority?: number;
  }): string;
}

export class MaintenanceManager {
  private interval: ReturnType<typeof setInterval> | null = null;
  private executor: MaintenanceExecutor;

  constructor(executor: MaintenanceExecutor) {
    this.executor = executor;
  }

  /** Start periodic maintenance on interval (no run on startup). */
  start(intervalMinutes: number): void {
    this.interval = setInterval(
      () => this.enqueueMaintenance(),
      intervalMinutes * 60 * 1000,
    );

    console.log(`[maintenance] Started (every ${intervalMinutes}min)`);
  }

  /** Manually trigger a maintenance run. */
  runNow(): void {
    this.enqueueMaintenance();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private enqueueMaintenance(): void {
    const goal = [
      "System maintenance tasks:",
      "1. Search memory across all projects for duplicate or redundant entries — DELETE duplicates using memory_delete tool.",
      "2. Check the job queue using list_jobs for stale jobs older than 24 hours.",
      "3. Review recent bloop failures across all projects and summarize patterns.",
      "4. Delete outdated or stale memory entries using memory_delete.",
      "5. If you find cross-project insights worth preserving, store them in memory.",
      "",
      "You MUST use memory_delete to clean up duplicates and stale entries — do not just report them.",
      "You have these tools: memory_search, memory_store, memory_update, memory_delete, list_jobs, list_projects, search_cross_project.",
      "Be concise. Only report findings that need attention.",
      "If everything looks healthy and no action is needed, respond with: MAINTENANCE_CLEAN",
    ].join("\n");

    this.executor.enqueueBloop({
      projectSlug: "_maintenance",
      goal,
      source: "cron",
      sourceId: "maintenance",
      priority: -1, // Lower priority than user work
    });
  }
}
