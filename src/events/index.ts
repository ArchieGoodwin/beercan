import { EventBus } from "./event-bus.js";
import { WebhookSource } from "./sources/webhook-source.js";
import { FilesystemSource } from "./sources/filesystem-source.js";
import { PollingSource } from "./sources/polling-source.js";
import { MacOSNativeSource } from "./sources/macos-source.js";
import { TriggerManager, type TriggerBloopExecutor } from "./trigger-manager.js";
import type { BeerCanDB } from "../storage/database.js";

// ── Event Manager ───────────────────────────────────────────
// Orchestrates: EventBus + all EventSources + TriggerManager

export interface EventManagerConfig {
  webhookPort?: number;
}

export class EventManager {
  private bus: EventBus;
  private webhook: WebhookSource;
  private filesystem: FilesystemSource;
  private polling: PollingSource;
  private macos: MacOSNativeSource;
  private triggers: TriggerManager;

  constructor(db: BeerCanDB, executor: TriggerBloopExecutor, config: EventManagerConfig = {}) {
    this.bus = new EventBus();
    this.webhook = new WebhookSource(this.bus, { port: config.webhookPort ?? 3939 });
    this.filesystem = new FilesystemSource(this.bus);
    this.polling = new PollingSource(this.bus);
    this.macos = new MacOSNativeSource(this.bus);
    this.triggers = new TriggerManager(this.bus, db, executor);
  }

  /** Start all event sources and trigger processing */
  async start(): Promise<void> {
    // Load triggers from DB
    this.triggers.init();

    // Start all sources
    await this.webhook.start();
    await this.filesystem.start();
    await this.polling.start();
    await this.macos.start();

    console.log("[events] Event system started");
  }

  /** Stop everything gracefully */
  async stop(): Promise<void> {
    await this.webhook.stop();
    await this.filesystem.stop();
    await this.polling.stop();
    await this.macos.stop();
    console.log("[events] Event system stopped");
  }

  /** Access the event bus for custom subscriptions */
  getEventBus(): EventBus { return this.bus; }

  /** Access the trigger manager for CRUD */
  getTriggerManager(): TriggerManager { return this.triggers; }

  /** Access sources for configuration */
  getWebhookSource(): WebhookSource { return this.webhook; }
  getFilesystemSource(): FilesystemSource { return this.filesystem; }
  getPollingSource(): PollingSource { return this.polling; }
  getMacOSSource(): MacOSNativeSource { return this.macos; }
}

export { EventBus, BeerCanEventSchema } from "./event-bus.js";
export type { BeerCanEvent } from "./event-bus.js";
export { TriggerManager, TriggerSchema } from "./trigger-manager.js";
export type { Trigger } from "./trigger-manager.js";
export { WebhookSource } from "./sources/webhook-source.js";
export { FilesystemSource } from "./sources/filesystem-source.js";
export { PollingSource } from "./sources/polling-source.js";
export { MacOSNativeSource } from "./sources/macos-source.js";
