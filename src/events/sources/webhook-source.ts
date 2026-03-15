import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getConfig } from "../../config.js";
import { EventBus, type BeerCanEvent } from "../event-bus.js";

// ── Rate Limiter ──────────────────────────────────────────
class RateLimiter {
  private requests = new Map<string, number[]>();
  private maxRequests: number;
  private windowMs = 60_000;

  constructor(maxRequests: number) {
    this.maxRequests = maxRequests;
  }

  check(ip: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const timestamps = this.requests.get(ip) ?? [];
    const windowStart = now - this.windowMs;
    const recent = timestamps.filter((t) => t > windowStart);

    if (recent.length >= this.maxRequests) {
      const retryAfterMs = recent[0] + this.windowMs - now;
      return { allowed: false, retryAfterMs };
    }

    recent.push(now);
    this.requests.set(ip, recent);
    return { allowed: true };
  }
}

// ── Webhook / API Server ────────────────────────────────────
// Receives external events via HTTP POST.
// Also provides a REST API for management and triggering loops.

export interface WebhookSourceConfig {
  port: number;
}

export class WebhookSource {
  private server: http.Server | null = null;
  private bus: EventBus;
  private port: number;
  private rateLimiter: RateLimiter;
  private apiHandlers: Map<string, (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => void | Promise<void>> = new Map();

  constructor(bus: EventBus, config: WebhookSourceConfig = { port: 3939 }) {
    this.bus = bus;
    this.port = config.port;
    this.rateLimiter = new RateLimiter(getConfig().webhookRateLimit);
  }

  /** Register a handler for REST API routes */
  registerApiHandler(
    method: string,
    path: string,
    handler: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => void | Promise<void>
  ): void {
    this.apiHandlers.set(`${method}:${path}`, handler);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.listen(this.port, () => {
        console.log(`[webhook] HTTP server listening on port ${this.port}`);
        resolve();
      });

      this.server.on("error", (err) => {
        console.error(`[webhook] Server error: ${err.message}`);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const method = req.method?.toUpperCase() ?? "GET";

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Rate limiting
    const clientIp = req.socket.remoteAddress ?? "unknown";
    const rateCheck = this.rateLimiter.check(clientIp);
    if (!rateCheck.allowed) {
      res.setHeader("Retry-After", String(Math.ceil((rateCheck.retryAfterMs ?? 60000) / 1000)));
      this.json(res, 429, { error: "Too many requests" });
      return;
    }

    // API key auth (if configured)
    // GET requests are public (dashboard, status, monitoring)
    // POST/DELETE require auth (task submission, job cancellation)
    const config = getConfig();
    const isMutating = method === "POST" || method === "DELETE" || method === "PUT" || method === "PATCH";
    if (config.apiKey && isMutating) {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (token !== config.apiKey) {
        this.json(res, 401, { error: "Unauthorized — provide Bearer token in Authorization header" });
        return;
      }
    }

    try {
      // Event endpoint: POST /events/:projectSlug
      const eventMatch = url.pathname.match(/^\/events\/([a-z0-9-]+)$/);
      if (eventMatch && method === "POST") {
        await this.handleEvent(req, res, eventMatch[1]);
        return;
      }

      // Health check
      if (url.pathname === "/api/health" && method === "GET") {
        this.json(res, 200, { status: "ok", uptime: process.uptime() });
        return;
      }

      // Try registered API handlers
      for (const [key, handler] of this.apiHandlers) {
        const colonIdx = key.indexOf(":");
        const handlerMethod = key.substring(0, colonIdx);
        const pattern = key.substring(colonIdx + 1);
        if (method !== handlerMethod) continue;

        const params = this.matchRoute(url.pathname, pattern);
        if (params) {
          await handler(req, res, params);
          return;
        }
      }

      // Dashboard — serve at / or /dashboard
      if ((url.pathname === "/" || url.pathname === "/dashboard") && method === "GET") {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const dashboardPath = path.resolve(__dirname, "../../dashboard/index.html");
        // Try src/ first (dev), then fall back to installed location
        const candidates = [dashboardPath, path.resolve(__dirname, "../../../src/dashboard/index.html")];
        for (const p of candidates) {
          if (fs.existsSync(p)) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(fs.readFileSync(p, "utf-8"));
            return;
          }
        }
      }

      // 404
      this.json(res, 404, { error: "Not found" });
    } catch (err: any) {
      this.json(res, 500, { error: err.message });
    }
  }

  private async handleEvent(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    projectSlug: string
  ): Promise<void> {
    const body = await this.readBody(req);
    let data: Record<string, unknown>;

    try {
      data = JSON.parse(body);
    } catch {
      this.json(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const event: BeerCanEvent = {
      type: (data.type as string) ?? "webhook",
      projectSlug,
      source: "webhook",
      data,
      timestamp: new Date().toISOString(),
    };

    this.bus.publish(event);
    this.json(res, 202, { accepted: true, eventType: event.type });
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    const maxSize = getConfig().webhookMaxBodySize;
    return new Promise((resolve, reject) => {
      let body = "";
      let size = 0;
      req.on("data", (chunk: Buffer | string) => {
        size += Buffer.byteLength(chunk);
        if (size > maxSize) {
          req.destroy();
          reject(new Error(`Request body exceeds ${maxSize} bytes`));
          return;
        }
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  private json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  /** Simple route matcher: /api/projects/:slug → { slug: "value" } */
  private matchRoute(pathname: string, pattern: string): Record<string, string> | null {
    const pathParts = pathname.split("/").filter(Boolean);
    const patternParts = pattern.split("/").filter(Boolean);

    if (pathParts.length !== patternParts.length) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = pathParts[i];
      } else if (patternParts[i] !== pathParts[i]) {
        return null;
      }
    }
    return params;
  }
}
