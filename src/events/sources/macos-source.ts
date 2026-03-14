import { execSync } from "child_process";
import os from "os";
import { EventBus, type BeerCanEvent } from "../event-bus.js";

// ── macOS Native Event Source ───────────────────────────────
// Uses osascript (AppleScript) to poll Calendar, Reminders, etc.
// Gracefully no-ops on non-macOS platforms.

export interface MacOSSourceConfig {
  projectSlug: string;
  /** Poll interval in milliseconds (default: 60000 = 1 min) */
  intervalMs?: number;
  /** Which macOS services to watch */
  services: Array<"calendar" | "reminders">;
}

export class MacOSNativeSource {
  private bus: EventBus;
  private configs: MacOSSourceConfig[] = [];
  private timers: NodeJS.Timeout[] = [];
  private lastChecked = new Map<string, string>(); // service → last check timestamp
  private isMacOS: boolean;

  constructor(bus: EventBus) {
    this.bus = bus;
    this.isMacOS = os.platform() === "darwin";
  }

  addConfig(config: MacOSSourceConfig): void {
    this.configs.push(config);
  }

  async start(): Promise<void> {
    if (!this.isMacOS) {
      console.log("[macos] Not on macOS, skipping native event source");
      return;
    }

    for (const config of this.configs) {
      const interval = config.intervalMs ?? 60_000;

      for (const service of config.services) {
        // Initialize last check time
        this.lastChecked.set(
          `${config.projectSlug}:${service}`,
          new Date().toISOString()
        );

        const timer = setInterval(
          () => this.checkService(config.projectSlug, service),
          interval
        );
        this.timers.push(timer);

        console.log(
          `[macos] Watching ${service} for ${config.projectSlug} (every ${interval / 1000}s)`
        );
      }
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  private checkService(projectSlug: string, service: string): void {
    try {
      switch (service) {
        case "calendar":
          this.checkCalendar(projectSlug);
          break;
        case "reminders":
          this.checkReminders(projectSlug);
          break;
      }
    } catch (err: any) {
      console.warn(`[macos] ${service} check failed: ${err.message}`);
    }
  }

  private checkCalendar(projectSlug: string): void {
    const key = `${projectSlug}:calendar`;
    const script = `
      tell application "Calendar"
        set today to current date
        set tomorrow to today + 1 * days
        set upcomingEvents to {}
        repeat with cal in calendars
          set evts to (every event of cal whose start date >= today and start date < tomorrow)
          repeat with e in evts
            set end of upcomingEvents to {summary of e, start date of e as text}
          end repeat
        end repeat
        return upcomingEvents as text
      end tell
    `;

    try {
      const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        timeout: 10_000,
      }).trim();

      if (result && result !== this.lastChecked.get(key + ":data")) {
        this.lastChecked.set(key + ":data", result);

        const event: BeerCanEvent = {
          type: "macos.calendar.update",
          projectSlug,
          source: "macos",
          data: { events: result, service: "calendar" },
          timestamp: new Date().toISOString(),
        };
        this.bus.publish(event);
      }
    } catch {
      // Calendar might not be accessible, that's fine
    }
  }

  private checkReminders(projectSlug: string): void {
    const key = `${projectSlug}:reminders`;
    const script = `
      tell application "Reminders"
        set incompleteTasks to {}
        repeat with r in (every reminder whose completed is false)
          set end of incompleteTasks to name of r
        end repeat
        return incompleteTasks as text
      end tell
    `;

    try {
      const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        timeout: 10_000,
      }).trim();

      if (result && result !== this.lastChecked.get(key + ":data")) {
        this.lastChecked.set(key + ":data", result);

        const event: BeerCanEvent = {
          type: "macos.reminders.update",
          projectSlug,
          source: "macos",
          data: { reminders: result, service: "reminders" },
          timestamp: new Date().toISOString(),
        };
        this.bus.publish(event);
      }
    } catch {
      // Reminders might not be accessible
    }
  }
}
