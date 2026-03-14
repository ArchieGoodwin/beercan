import { EventEmitter } from "events";
import { z } from "zod";

// ── BeerCan Event Schema ────────────────────────────────────

export const BeerCanEventSchema = z.object({
  type: z.string(),
  projectSlug: z.string(),
  source: z.enum(["webhook", "filesystem", "polling", "macos", "api", "internal"]),
  data: z.record(z.unknown()).default({}),
  timestamp: z.string().datetime(),
});
export type BeerCanEvent = z.infer<typeof BeerCanEventSchema>;

// ── Event Bus ───────────────────────────────────────────────
// Central pub/sub hub. All event sources publish here.
// TriggerManager subscribes to match events to triggers.

export class EventBus extends EventEmitter {
  private eventLog: BeerCanEvent[] = [];
  private maxLogSize = 1000;

  /** Publish a typed event */
  publish(event: BeerCanEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog.shift();
    }

    // Emit on specific event type channel
    this.emit(event.type, event);
    // Also emit on wildcard channel for global listeners
    this.emit("*", event);
  }

  /** Subscribe to a specific event type */
  subscribe(eventType: string, handler: (event: BeerCanEvent) => void): void {
    this.on(eventType, handler);
  }

  /** Subscribe to ALL events */
  subscribeAll(handler: (event: BeerCanEvent) => void): void {
    this.on("*", handler);
  }

  /** Get recent events (for debugging/monitoring) */
  getRecentEvents(count = 50): BeerCanEvent[] {
    return this.eventLog.slice(-count);
  }
}
