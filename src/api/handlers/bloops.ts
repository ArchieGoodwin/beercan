import type http from "http";
import { z } from "zod";
import type { BeerCanEngine } from "../../index.js";
import type { WebhookSource } from "../../events/sources/webhook-source.js";
import { json, parseQuery, readJsonBody } from "../utils.js";

const CreateBloopSchema = z.object({
  projectSlug: z.string().min(1),
  goal: z.string().min(1),
  team: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  extraContext: z.string().optional(),
});

export function registerBloopHandlers(webhook: WebhookSource, engine: BeerCanEngine): void {
  // POST /api/bloops — enqueue a new bloop
  webhook.registerApiHandler("POST", "/api/bloops", async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const body = await readJsonBody(req);
      const input = CreateBloopSchema.parse(body);

      const project = engine.getProject(input.projectSlug);
      if (!project) {
        json(res, 404, { error: `Project not found: ${input.projectSlug}` });
        return;
      }

      const jobId = engine.enqueueBloop({
        projectSlug: input.projectSlug,
        goal: input.goal,
        team: input.team,
        priority: input.priority,
        source: "manual",
        extraContext: input.extraContext,
      });

      json(res, 202, { jobId, accepted: true });
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        json(res, 400, { error: "Validation failed", details: err.errors });
      } else {
        json(res, 400, { error: err.message });
      }
    }
  });

  // GET /api/bloops/recent — recent bloops across all projects
  // IMPORTANT: Register before /api/bloops/:id to avoid route conflict
  webhook.registerApiHandler("GET", "/api/bloops/recent", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const query = parseQuery(req);
    const limit = parseInt(query.get("limit") ?? "20", 10);
    const statusFilter = query.get("status") ?? undefined;

    const bloops = engine.getRecentBloops(limit, statusFilter).map((b) => ({
      id: b.id,
      projectId: b.projectId,
      status: b.status,
      goal: b.goal,
      trigger: b.trigger,
      tokensUsed: b.tokensUsed,
      iterations: b.iterations,
      toolCallCount: b.toolCalls.length,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
    }));

    json(res, 200, { bloops });
  });

  // GET /api/bloops/:id — single bloop detail
  webhook.registerApiHandler("GET", "/api/bloops/:id", (_req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => {
    let bloop = engine.getBloop(params.id);

    // Try partial ID match
    if (!bloop) {
      for (const p of engine.listProjects({ includeSystem: true })) {
        const pBloops = engine.getProjectBloops(p.slug);
        const match = pBloops.find((b) => b.id.startsWith(params.id));
        if (match) { bloop = match; break; }
      }
    }

    if (!bloop) {
      json(res, 404, { error: `Bloop not found: ${params.id}` });
      return;
    }

    json(res, 200, {
      id: bloop.id,
      projectId: bloop.projectId,
      parentBloopId: bloop.parentBloopId,
      status: bloop.status,
      goal: bloop.goal,
      trigger: bloop.trigger,
      result: bloop.result,
      toolCalls: bloop.toolCalls,
      tokensUsed: bloop.tokensUsed,
      iterations: bloop.iterations,
      maxIterations: bloop.maxIterations,
      createdAt: bloop.createdAt,
      updatedAt: bloop.updatedAt,
      completedAt: bloop.completedAt,
    });
  });
}
