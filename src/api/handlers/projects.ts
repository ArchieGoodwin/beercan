import type http from "http";
import type { BeerCanEngine } from "../../index.js";
import type { WebhookSource } from "../../events/sources/webhook-source.js";
import { json, parseQuery } from "../utils.js";

export function registerProjectHandlers(webhook: WebhookSource, engine: BeerCanEngine): void {
  // GET /api/projects — all projects with bloop summaries
  webhook.registerApiHandler("GET", "/api/projects", (_req: http.IncomingMessage, res: http.ServerResponse) => {
    const projects = engine.listProjects();
    const result = projects.map((p) => {
      const stats = engine.getProjectBloopStats(p.slug);
      return {
        slug: p.slug,
        name: p.name,
        workDir: p.workDir,
        description: p.description,
        bloops: stats ? { completed: stats.completed, failed: stats.failed, running: stats.running, total: stats.total } : { completed: 0, failed: 0, running: 0, total: 0 },
        totalTokens: stats?.totalTokens ?? 0,
        createdAt: p.createdAt,
      };
    });
    json(res, 200, { projects: result });
  });

  // GET /api/projects/:slug — single project detail
  webhook.registerApiHandler("GET", "/api/projects/:slug", (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => {
    const project = engine.getProject(params.slug);
    if (!project) {
      json(res, 404, { error: `Project not found: ${params.slug}` });
      return;
    }

    const stats = engine.getProjectBloopStats(params.slug);
    const recentBloops = engine.getProjectBloops(params.slug).slice(0, 10).map((b) => ({
      id: b.id,
      status: b.status,
      goal: b.goal,
      tokensUsed: b.tokensUsed,
      iterations: b.iterations,
      toolCallCount: b.toolCalls.length,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
    }));

    json(res, 200, {
      project: {
        slug: project.slug,
        name: project.name,
        workDir: project.workDir,
        description: project.description,
        context: project.context,
        tokenBudget: project.tokenBudget,
        createdAt: project.createdAt,
      },
      bloops: stats ? { completed: stats.completed, failed: stats.failed, running: stats.running, total: stats.total } : { completed: 0, failed: 0, running: 0, total: 0 },
      totalTokens: stats?.totalTokens ?? 0,
      recentBloops,
    });
  });

  // GET /api/projects/:slug/bloops — bloops for a project
  webhook.registerApiHandler("GET", "/api/projects/:slug/bloops", (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => {
    const project = engine.getProject(params.slug);
    if (!project) {
      json(res, 404, { error: `Project not found: ${params.slug}` });
      return;
    }

    const query = parseQuery(req);
    const statusFilter = query.get("status") ?? undefined;
    const bloops = engine.getProjectBloops(params.slug, statusFilter).map((b) => ({
      id: b.id,
      status: b.status,
      goal: b.goal,
      tokensUsed: b.tokensUsed,
      iterations: b.iterations,
      toolCallCount: b.toolCalls.length,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
    }));

    json(res, 200, { bloops });
  });
}
