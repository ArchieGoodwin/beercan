import { EventBus, type BeerCanEvent } from "../event-bus.js";

// ── Polling Source ──────────────────────────────────────────
// Generic interval-based event source.
// Subclass for specific services (email, calendar, API checks).

export interface PollingConfig {
  projectSlug: string;
  /** Unique identifier for this poll */
  name: string;
  /** Polling interval in milliseconds */
  intervalMs: number;
  /** Event type to emit */
  eventType: string;
}

export type PollChecker = () => Promise<Record<string, unknown> | null>;

export class PollingSource {
  private bus: EventBus;
  private timers: NodeJS.Timeout[] = [];
  private polls: Array<{ config: PollingConfig; checker: PollChecker }> = [];

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  /** Register a polling check */
  addPoll(config: PollingConfig, checker: PollChecker): void {
    this.polls.push({ config, checker });
  }

  async start(): Promise<void> {
    for (const { config, checker } of this.polls) {
      // Run immediately on start
      this.runPoll(config, checker);

      // Then schedule recurring
      const timer = setInterval(
        () => this.runPoll(config, checker),
        config.intervalMs
      );
      this.timers.push(timer);

      console.log(
        `[polling] ${config.name}: every ${config.intervalMs / 1000}s for ${config.projectSlug}`
      );
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  private async runPoll(config: PollingConfig, checker: PollChecker): Promise<void> {
    try {
      const result = await checker();
      if (result) {
        const event: BeerCanEvent = {
          type: config.eventType,
          projectSlug: config.projectSlug,
          source: "polling",
          data: { pollName: config.name, ...result },
          timestamp: new Date().toISOString(),
        };
        this.bus.publish(event);
      }
    } catch (err: any) {
      console.warn(`[polling] ${config.name} failed: ${err.message}`);
    }
  }
}
