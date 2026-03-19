import { getConfig } from "../config.js";
import type { BeerCanDB } from "../storage/database.js";
import type { Project } from "../schemas.js";

// ── Heartbeat Config ────────────────────────────────────────

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  activeHours?: { start: string; end: string };
  checklist: string[];
  suppressIfEmpty: boolean;
}

// ── Heartbeat Manager ───────────────────────────────────────

export interface HeartbeatExecutor {
  runBloop(opts: {
    projectSlug: string;
    goal: string;
    team?: string;
    extraContext?: string;
  }): Promise<any>;
}

export interface HeartbeatEventPublisher {
  publish(event: {
    type: string;
    projectSlug: string;
    source: string;
    data: Record<string, unknown>;
    timestamp: string;
  }): void;
}

export class HeartbeatManager {
  private db: BeerCanDB;
  private executor: HeartbeatExecutor;
  private publisher: HeartbeatEventPublisher | null;
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private running = false;

  constructor(
    db: BeerCanDB,
    executor: HeartbeatExecutor,
    publisher?: HeartbeatEventPublisher,
  ) {
    this.db = db;
    this.executor = executor;
    this.publisher = publisher ?? null;
  }

  /** Load all projects and start heartbeats for those with config */
  init(): void {
    this.running = true;
    const projects = this.db.listProjects();
    let started = 0;

    for (const project of projects) {
      const config = this.getHeartbeatConfig(project);
      if (config?.enabled) {
        this.startProject(project.slug, config);
        started++;
      }
    }

    if (started > 0) {
      console.log(`[heartbeat] Started ${started} project heartbeats`);
    }
  }

  /** Stop all heartbeat intervals */
  stop(): void {
    this.running = false;
    for (const [slug, interval] of this.intervals) {
      clearInterval(interval);
      this.intervals.delete(slug);
    }
    console.log("[heartbeat] Stopped all heartbeats");
  }

  /** Start heartbeat for a single project */
  startProject(slug: string, config?: HeartbeatConfig): void {
    if (this.intervals.has(slug)) return; // Already running

    const project = this.db.getProjectBySlug(slug);
    if (!project) return;

    const hbConfig = config ?? this.getHeartbeatConfig(project);
    if (!hbConfig?.enabled) return;

    const globalConfig = getConfig();
    const intervalMs = Math.max(hbConfig.intervalMinutes, globalConfig.heartbeatMinInterval) * 60 * 1000;

    const interval = setInterval(() => {
      this.runHeartbeat(project, hbConfig).catch((err) => {
        console.error(`[heartbeat] Error for ${slug}: ${err.message}`);
      });
    }, intervalMs);

    this.intervals.set(slug, interval);
  }

  /** Stop heartbeat for a single project */
  stopProject(slug: string): void {
    const interval = this.intervals.get(slug);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(slug);
    }
  }

  /** Run a single heartbeat check */
  async runHeartbeat(project: Project, config: HeartbeatConfig): Promise<void> {
    // Check active hours
    if (config.activeHours && !this.isInActiveHours(config.activeHours)) {
      return;
    }

    // Build goal from checklist
    const goal = this.buildHeartbeatGoal(project, config);

    const extraContext = [
      "This is an automated heartbeat check. Be concise.",
      "If you find nothing noteworthy and everything looks fine, respond exactly with: HEARTBEAT_EMPTY",
      "If you find something worth reporting, provide a brief summary of your findings.",
    ].join("\n");

    try {
      const bloop = await this.executor.runBloop({
        projectSlug: project.slug,
        goal,
        team: "solo",
        extraContext,
      });

      // Check if result indicates nothing noteworthy
      const resultStr = bloop.result
        ? typeof bloop.result === "string"
          ? bloop.result
          : JSON.stringify(bloop.result)
        : "";

      const isEmpty = resultStr.includes("HEARTBEAT_EMPTY");

      if (isEmpty && config.suppressIfEmpty) {
        // Silent — don't notify
        return;
      }

      // Publish heartbeat result event
      if (this.publisher) {
        this.publisher.publish({
          type: "heartbeat:result",
          projectSlug: project.slug,
          source: "heartbeat",
          data: {
            bloopId: bloop.id,
            goal,
            result: resultStr.slice(0, 2000),
            empty: isEmpty,
            tokensUsed: bloop.tokensUsed,
          },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      console.error(`[heartbeat] Failed for ${project.slug}: ${err.message}`);
    }
  }

  /** Get the heartbeat config from a project's context */
  getHeartbeatConfig(project: Project): HeartbeatConfig | null {
    const ctx = project.context?.heartbeat;
    if (!ctx || typeof ctx !== "object") return null;

    const config = getConfig();
    const hb = ctx as Record<string, unknown>;

    return {
      enabled: hb.enabled === true,
      intervalMinutes: typeof hb.intervalMinutes === "number"
        ? hb.intervalMinutes
        : config.heartbeatDefaultInterval,
      activeHours: hb.activeHours && typeof hb.activeHours === "object"
        ? hb.activeHours as { start: string; end: string }
        : this.parseActiveHours(config.heartbeatActiveHours),
      checklist: Array.isArray(hb.checklist) ? hb.checklist as string[] : [],
      suppressIfEmpty: hb.suppressIfEmpty !== false, // default true
    };
  }

  // ── Internal ──────────────────────────────────────────────

  buildHeartbeatGoal(project: Project, config: HeartbeatConfig): string {
    if (config.checklist.length === 0) {
      return `Heartbeat check for ${project.name}: Review project health, check for any issues or pending work.`;
    }

    const items = config.checklist
      .map((item, i) => `${i + 1}. ${item}`)
      .join("; ");

    return `Heartbeat check for ${project.name}: ${items}`;
  }

  isInActiveHours(hours: { start: string; end: string }): boolean {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const startMinutes = this.parseTimeToMinutes(hours.start);
    const endMinutes = this.parseTimeToMinutes(hours.end);

    if (startMinutes === null || endMinutes === null) return true; // Invalid → allow

    if (startMinutes <= endMinutes) {
      // Normal range: e.g., 08:00 - 22:00
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } else {
      // Overnight range: e.g., 22:00 - 06:00
      return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
  }

  private parseTimeToMinutes(time: string): number | null {
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  private parseActiveHours(str: string): { start: string; end: string } | undefined {
    const parts = str.split("-");
    if (parts.length !== 2) return undefined;
    return { start: parts[0].trim(), end: parts[1].trim() };
  }
}
