import chalk from "chalk";
import type { BeerCanEngine } from "../index.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { EventManager } from "./index.js";
import { registerStatusApi } from "../api/index.js";
import { createAnthropicClient } from "../client.js";

/**
 * Start the BeerCan daemon: runs scheduler + event system + chat providers.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 */
export async function startDaemon(
  engine: BeerCanEngine,
  scheduler: Scheduler,
  eventManager: EventManager
): Promise<void> {
  // Register Status API routes
  const webhookSource = eventManager.getWebhookSource();
  registerStatusApi(webhookSource, engine);

  // Start scheduler
  scheduler.init();
  scheduler.start();

  // Start event system
  await eventManager.start();

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
  if (chatProviders.length > 0) {
    console.log(chalk.dim(`  Chat providers: ${chatProviders.join(", ")}`));
  }
  console.log(chalk.dim("  Press Ctrl+C to stop\n"));

  // Graceful shutdown
  const shutdown = async () => {
    console.log(chalk.dim("\nShutting down..."));
    if (chatBridge) await chatBridge.stop();
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
