import { v4 as uuid } from "uuid";
import { z } from "zod";
import { EventBus, type BeerCanEvent } from "./event-bus.js";
import type { BeerCanDB } from "../storage/database.js";

// ── Trigger Schema ──────────────────────────────────────────

export const TriggerSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectSlug: z.string(),
  eventType: z.string(),
  /** Regex pattern to match event type */
  filterPattern: z.string().default(".*"),
  /** JSON filter on event data (simple key-value match) */
  filterData: z.record(z.unknown()).default({}),
  /** Goal template with {{data.field}} interpolation */
  goalTemplate: z.string(),
  team: z.string().default("solo"),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

// ── Types for the engine reference ──────────────────────────

export interface TriggerBloopExecutor {
  runBloop(opts: {
    projectSlug: string;
    goal: string;
    team?: string;
  }): Promise<any>;
}

// ── Trigger Manager ─────────────────────────────────────────
// Matches incoming events against trigger configs and spawns bloops.

export class TriggerManager {
  private bus: EventBus;
  private db: BeerCanDB;
  private executor: TriggerBloopExecutor;
  private triggers: Trigger[] = [];

  constructor(bus: EventBus, db: BeerCanDB, executor: TriggerBloopExecutor) {
    this.bus = bus;
    this.db = db;
    this.executor = executor;
  }

  /** Load triggers from DB and wire up event listeners */
  init(): void {
    this.triggers = this.db.listTriggers();

    // Subscribe to all events
    this.bus.subscribeAll((event) => {
      this.matchAndSpawn(event).catch((err) => {
        console.error(`[triggers] Error processing event: ${err.message}`);
      });
    });

    console.log(`[triggers] Loaded ${this.triggers.length} triggers`);
  }

  /** Add a new trigger */
  addTrigger(opts: {
    projectId: string;
    projectSlug: string;
    eventType: string;
    filterPattern?: string;
    goalTemplate: string;
    team?: string;
  }): Trigger {
    const now = new Date().toISOString();
    const trigger: Trigger = {
      id: uuid(),
      projectId: opts.projectId,
      projectSlug: opts.projectSlug,
      eventType: opts.eventType,
      filterPattern: opts.filterPattern ?? ".*",
      filterData: {},
      goalTemplate: opts.goalTemplate,
      team: opts.team ?? "solo",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    this.db.createTrigger(trigger);
    this.triggers.push(trigger);
    return trigger;
  }

  /** Remove a trigger */
  removeTrigger(triggerId: string): void {
    this.db.deleteTrigger(triggerId);
    this.triggers = this.triggers.filter((t) => t.id !== triggerId);
  }

  /** List all triggers */
  listTriggers(projectSlug?: string): Trigger[] {
    if (projectSlug) {
      return this.triggers.filter((t) => t.projectSlug === projectSlug);
    }
    return [...this.triggers];
  }

  /** Match an event against triggers and spawn bloops */
  private async matchAndSpawn(event: BeerCanEvent): Promise<void> {
    for (const trigger of this.triggers) {
      if (!trigger.enabled) continue;
      if (trigger.projectSlug !== event.projectSlug) continue;

      // Match event type against filter pattern
      try {
        const regex = new RegExp(trigger.filterPattern);
        if (!regex.test(event.type)) continue;
      } catch {
        continue; // Invalid regex, skip
      }

      // Interpolate goal template
      const goal = this.interpolateGoal(trigger.goalTemplate, event);

      console.log(
        `[triggers] Matched: ${trigger.id} → spawning bloop for "${goal}"`
      );

      try {
        // Log the event
        this.db.logEvent({
          id: uuid(),
          projectId: trigger.projectId,
          eventType: event.type,
          eventData: event.data,
          triggerId: trigger.id,
          createdAt: new Date().toISOString(),
        });

        // Spawn the bloop (don't await — fire and forget)
        this.executor.runBloop({
          projectSlug: trigger.projectSlug,
          goal,
          team: trigger.team,
        }).catch((err) => {
          console.error(`[triggers] Bloop failed: ${err.message}`);
        });
      } catch (err: any) {
        console.error(`[triggers] Failed to spawn bloop: ${err.message}`);
      }
    }
  }

  /** Simple {{data.field}} template interpolation */
  private interpolateGoal(template: string, event: BeerCanEvent): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const parts = path.trim().split(".");
      let value: any = event;
      for (const part of parts) {
        value = value?.[part];
      }
      return value !== undefined ? String(value) : `{{${path}}}`;
    });
  }
}
