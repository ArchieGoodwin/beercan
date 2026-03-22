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

  /** Start periodic maintenance. Runs once after a 60s settle delay, then on interval. */
  start(intervalMinutes: number): void {
    // Initial run after startup settle
    setTimeout(() => this.enqueueMaintenance(), 60_000);

    this.interval = setInterval(
      () => this.enqueueMaintenance(),
      intervalMinutes * 60 * 1000,
    );

    console.log(`[maintenance] Started (every ${intervalMinutes}min)`);
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
      "1. Search memory across all projects for duplicate or redundant entries and consolidate them.",
      "2. Check the job queue for stale jobs older than 24 hours and report any found.",
      "3. Review recent bloop failures across all projects and summarize patterns.",
      "4. Check memory entries that may be outdated and flag them for review.",
      "5. If you find cross-project insights worth preserving, store them in memory.",
      "",
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
