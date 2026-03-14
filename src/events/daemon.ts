import chalk from "chalk";
import type { BeerCanEngine } from "../index.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { EventManager } from "./index.js";

/**
 * Start the BeerCan daemon: runs scheduler + event system.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 */
export async function startDaemon(
  engine: BeerCanEngine,
  scheduler: Scheduler,
  eventManager: EventManager
): Promise<void> {
  // Start scheduler
  scheduler.init();
  scheduler.start();

  // Start event system
  await eventManager.start();

  console.log(chalk.bold.blue("\n🍺 BeerCan daemon running"));
  console.log(chalk.dim("  Press Ctrl+C to stop\n"));

  // Graceful shutdown
  const shutdown = async () => {
    console.log(chalk.dim("\nShutting down..."));
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
