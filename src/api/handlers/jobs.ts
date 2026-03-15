import type http from "http";
import type { BeerCanEngine } from "../../index.js";
import type { WebhookSource } from "../../events/sources/webhook-source.js";
import { json, parseQuery } from "../utils.js";

export function registerJobHandlers(webhook: WebhookSource, engine: BeerCanEngine): void {
  webhook.registerApiHandler("GET", "/api/jobs", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const query = parseQuery(req);
    const statusFilter = query.get("status") ?? undefined;
    const limit = parseInt(query.get("limit") ?? "20", 10);

    const stats = engine.getJobQueue().getStats();
    const jobs = engine.getJobQueue().listJobs(statusFilter, limit).map((j) => ({
      id: j.id,
      projectSlug: j.projectSlug,
      goal: j.goal,
      team: j.team,
      status: j.status,
      source: j.source,
      bloopId: j.bloopId,
      error: j.error,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
    }));

    json(res, 200, { stats, jobs });
  });

  // DELETE /api/jobs/:id — cancel a job
  webhook.registerApiHandler("DELETE", "/api/jobs/:id", (_req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => {
    const result = engine.getJobQueue().cancelJob(params.id);
    if (result.cancelled) {
      json(res, 200, { cancelled: true, jobId: params.id, status: result.status });
    } else {
      json(res, 409, { cancelled: false, jobId: params.id, reason: result.reason, status: result.status });
    }
  });
}
