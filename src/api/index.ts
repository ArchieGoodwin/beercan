import type { WebhookSource } from "../events/sources/webhook-source.js";
import type { BeerCanEngine } from "../index.js";
import { registerStatusHandlers } from "./handlers/status.js";
import { registerProjectHandlers } from "./handlers/projects.js";
import { registerJobHandlers } from "./handlers/jobs.js";
import { registerScheduleHandlers } from "./handlers/schedules.js";
import { registerBloopHandlers } from "./handlers/bloops.js";

/**
 * Register all Status API routes on the webhook HTTP server.
 * Call this before starting the server.
 */
export function registerStatusApi(webhookSource: WebhookSource, engine: BeerCanEngine): void {
  registerStatusHandlers(webhookSource, engine);
  registerProjectHandlers(webhookSource, engine);
  registerJobHandlers(webhookSource, engine);
  registerScheduleHandlers(webhookSource, engine);
  registerBloopHandlers(webhookSource, engine);
}
