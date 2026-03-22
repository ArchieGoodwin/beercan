import chalk from "chalk";
import type { BeerCanEngine } from "../index.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { EventManager } from "./index.js";
import { registerStatusApi } from "../api/index.js";
import { createAnthropicClient } from "../client.js";
import { HeartbeatManager } from "../core/heartbeat.js";
import { MaintenanceManager } from "../core/maintenance-manager.js";
import { CalendarManager } from "../core/calendar-manager.js";
import { getConfig } from "../config.js";

/**
 * Start the BeerCan daemon: runs scheduler + event system + chat providers.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 */
export async function startDaemon(
  engine: BeerCanEngine,
  scheduler: Scheduler,
  eventManager: EventManager
): Promise<void> {
  const config = getConfig();

  // Register Status API routes
  const webhookSource = eventManager.getWebhookSource();
  registerStatusApi(webhookSource, engine);

  // Start scheduler
  scheduler.init();
  scheduler.start();

  // Start event system
  await eventManager.start();

  // Start heartbeat system (routes through _heartbeat project)
  const heartbeat = new HeartbeatManager(
    engine.getDB(),
    { enqueueBloop: (opts) => engine.enqueueBloop(opts) },
    eventManager.getEventBus(),
  );
  heartbeat.init();

  // Start maintenance system (routes through _maintenance project)
  const maintenance = new MaintenanceManager(
    { enqueueBloop: (opts) => engine.enqueueBloop(opts) },
  );
  if (config.maintenanceEnabled) {
    maintenance.start(config.maintenanceIntervalMinutes);
  }

  // Start calendar system (routes through _calendar project, macOS only)
  const calendar = new CalendarManager(
    { enqueueBloop: (opts) => engine.enqueueBloop(opts) },
  );
  if (process.platform === "darwin" && config.calendarEnabled) {
    calendar.start({
      checkIntervalMinutes: config.calendarCheckIntervalMinutes,
      morningBriefCron: config.calendarMorningBriefCron,
    });
  }

  // Start chat providers (if configured)
  let chatBridge: any = null;
  const chatProviders: string[] = [];

  if (process.env.BEERCAN_TELEGRAM_TOKEN || process.env.BEERCAN_SLACK_TOKEN) {
    try {
      const { ChatBridge } = await import("../chat/index.js");
      const client = await createAnthropicClient();
      chatBridge = new ChatBridge(engine, client);

      if (process.env.BEERCAN_TELEGRAM_TOKEN) {
        const { TelegramProvider } = await import("../chat/providers/telegram.js");
        chatBridge.addProvider(new TelegramProvider(process.env.BEERCAN_TELEGRAM_TOKEN));
        chatProviders.push("telegram");
      }

      if (process.env.BEERCAN_SLACK_TOKEN && process.env.BEERCAN_SLACK_SIGNING_SECRET) {
        const { SlackProvider } = await import("../chat/providers/slack.js");
        chatBridge.addProvider(new SlackProvider(
          process.env.BEERCAN_SLACK_TOKEN,
          process.env.BEERCAN_SLACK_SIGNING_SECRET,
          process.env.BEERCAN_SLACK_APP_TOKEN
        ));
        chatProviders.push("slack");
      }

      // Subscribe to bloop events for automatic result delivery
      chatBridge.subscribeToBloopEvents(eventManager.getEventBus());

      await chatBridge.start();
    } catch (err: any) {
      console.error(chalk.yellow(`[chat] Failed to start chat providers: ${err.message}`));
    }
  }

  console.log(chalk.bold.blue("\n🍺 BeerCan daemon running"));
  const systems: string[] = [];
  if (config.maintenanceEnabled) systems.push("maintenance");
  if (process.platform === "darwin" && config.calendarEnabled) systems.push("calendar");
  if (systems.length > 0) {
    console.log(chalk.dim(`  System projects: heartbeat, triggers, ${systems.join(", ")}`));
  }
  if (chatProviders.length > 0) {
    console.log(chalk.dim(`  Chat providers: ${chatProviders.join(", ")}`));
  }
  console.log(chalk.dim("  Press Ctrl+C to stop\n"));

  // Graceful shutdown
  const shutdown = async () => {
    console.log(chalk.dim("\nShutting down..."));
    if (chatBridge) await chatBridge.stop();
    calendar.stop();
    maintenance.stop();
    heartbeat.stop();
    scheduler.stop();
    await eventManager.stop();
    engine.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep process alive
  await new Promise(() => {
    // Never resolves — daemon runs until killed
  });
}
