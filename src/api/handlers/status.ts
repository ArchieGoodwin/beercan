import type http from "http";
import type { BeerCanEngine } from "../../index.js";
import type { WebhookSource } from "../../events/sources/webhook-source.js";
import { json } from "../utils.js";

export function registerStatusHandlers(webhook: WebhookSource, engine: BeerCanEngine): void {
  webhook.registerApiHandler("GET", "/api/status", (_req: http.IncomingMessage, res: http.ServerResponse) => {
    const bloopStats = engine.getBloopStats();
    const jobStats = engine.getJobQueue().getStats();
    const projects = engine.listProjects();
    const schedules = engine.getScheduler().listSchedules();

    json(res, 200, {
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      projects: { total: projects.length },
      bloops: bloopStats,
      jobs: jobStats,
      schedules: {
        total: schedules.length,
        enabled: schedules.filter((s) => s.enabled).length,
      },
    });
  });
}
