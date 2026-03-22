import cron from "node-cron";
import type { ScheduledTask } from "node-cron";

// ── Calendar Manager ──────────────────────────────────────────
// Schedule-aware automation: morning briefs, upcoming event checks,
// meeting prep suggestions. macOS only (uses EventKit calendar tools).
// Routes through the _calendar system project via job queue.

export interface CalendarExecutor {
  enqueueBloop(opts: {
    projectSlug: string;
    goal: string;
    source?: "manual" | "cron" | "event";
    sourceId?: string;
    extraContext?: string;
    priority?: number;
  }): string;
}

export interface CalendarManagerConfig {
  checkIntervalMinutes: number;
  morningBriefCron: string;
}

export class CalendarManager {
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private morningTask: ScheduledTask | null = null;
  private executor: CalendarExecutor;

  constructor(executor: CalendarExecutor) {
    this.executor = executor;
  }

  start(config: CalendarManagerConfig): void {
    if (process.platform !== "darwin") {
      console.log("[calendar] Skipped — macOS only");
      return;
    }

    // Periodic upcoming event check
    this.checkInterval = setInterval(
      () => this.enqueueUpcomingCheck(),
      config.checkIntervalMinutes * 60 * 1000,
    );

    // Morning brief via cron
    if (cron.validate(config.morningBriefCron)) {
      this.morningTask = cron.schedule(config.morningBriefCron, () => {
        this.enqueueMorningBrief();
      });
    }

    // Initial upcoming check after 2min settle
    setTimeout(() => this.enqueueUpcomingCheck(), 120_000);

    console.log(
      `[calendar] Started (check every ${config.checkIntervalMinutes}min, brief: ${config.morningBriefCron})`,
    );
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.morningTask) {
      this.morningTask.stop();
      this.morningTask = null;
    }
  }

  private enqueueUpcomingCheck(): void {
    this.executor.enqueueBloop({
      projectSlug: "_calendar",
      goal: [
        "Check calendar for events in the next 2 hours.",
        "If any events are approaching soon (within 30 minutes), send a notification with event details.",
        "For meetings with notes containing video call links (Zoom, Meet, Teams), include the link.",
        "If meetings have agendas or attendees, suggest brief preparation tasks.",
        "If no events are approaching, respond with: CALENDAR_CLEAR",
      ].join("\n"),
      source: "cron",
      sourceId: "calendar-check",
      priority: -1,
    });
  }

  private enqueueMorningBrief(): void {
    this.executor.enqueueBloop({
      projectSlug: "_calendar",
      goal: [
        "Generate a morning calendar brief for today.",
        "1. List all events for today, organized chronologically.",
        "2. Highlight meetings that need preparation (attendees, agendas).",
        "3. Note any conflicts or back-to-back meetings.",
        "4. Identify free time blocks for focused work.",
        "5. Check if any recurring meetings are missing compared to the usual pattern.",
        "Send a notification with the brief summary.",
      ].join("\n"),
      source: "cron",
      sourceId: "calendar-morning-brief",
      priority: -1,
    });
  }
}
