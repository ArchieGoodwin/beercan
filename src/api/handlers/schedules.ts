import type http from "http";
import type { BeerCanEngine } from "../../index.js";
import type { WebhookSource } from "../../events/sources/webhook-source.js";
import { json, parseQuery } from "../utils.js";

export function registerScheduleHandlers(webhook: WebhookSource, engine: BeerCanEngine): void {
  webhook.registerApiHandler("GET", "/api/schedules", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const query = parseQuery(req);
    const projectFilter = query.get("project") ?? undefined;

    const schedules = engine.getScheduler().listSchedules(projectFilter).map((s) => ({
      id: s.id,
      projectSlug: s.projectSlug,
      cronExpression: s.cronExpression,
      goal: s.goal,
      team: s.team,
      enabled: s.enabled,
      lastRunAt: s.lastRunAt,
      createdAt: s.createdAt,
    }));

    json(res, 200, { schedules });
  });
}
