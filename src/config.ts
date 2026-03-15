import { config as loadEnv } from "dotenv";
import { z } from "zod";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

// Load .env from multiple locations (first match wins for each var):
// 1. ~/.beercan/.env (user config from `beercan setup`)
// 2. Project root .env (dev)
// 3. CWD .env
const dataDir = process.env.BEERCAN_DATA_DIR ?? path.join(os.homedir(), ".beercan");
loadEnv({ path: path.join(dataDir, ".env") });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
loadEnv({ path: path.join(projectRoot, ".env") });

loadEnv(); // CWD/.env

const ConfigSchema = z.object({
  anthropicApiKey: z.string().default(""),
  dataDir: z.string().default(path.join(os.homedir(), ".beercan")),
  defaultModel: z.string().default("claude-sonnet-4-6"),
  heavyModel: z.string().default("claude-opus-4-6"),
  gatekeeperModel: z.string().default("claude-haiku-4-5-20251001"),
  maxBloopIterations: z.number().default(50),
  bloopTimeoutMs: z.number().default(600_000),
  maxConcurrent: z.number().default(2),
  defaultTokenBudget: z.number().default(100_000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  logFile: z.string().optional(),
  webhookRateLimit: z.number().default(60),
  webhookMaxBodySize: z.number().default(1_048_576),
  apiKey: z.string().optional(),
  notifyOnComplete: z.boolean().default(true),
  notifyWebhookUrl: z.string().url().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = ConfigSchema.parse({
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      dataDir: process.env.BEERCAN_DATA_DIR,
      defaultModel: process.env.BEERCAN_DEFAULT_MODEL,
      heavyModel: process.env.BEERCAN_HEAVY_MODEL,
      gatekeeperModel: process.env.BEERCAN_GATEKEEPER_MODEL,
      maxBloopIterations: process.env.BEERCAN_MAX_ITERATIONS
        ? parseInt(process.env.BEERCAN_MAX_ITERATIONS)
        : undefined,
      bloopTimeoutMs: process.env.BEERCAN_BLOOP_TIMEOUT_MS
        ? parseInt(process.env.BEERCAN_BLOOP_TIMEOUT_MS)
        : undefined,
      maxConcurrent: process.env.BEERCAN_MAX_CONCURRENT
        ? parseInt(process.env.BEERCAN_MAX_CONCURRENT)
        : undefined,
      defaultTokenBudget: process.env.BEERCAN_TOKEN_BUDGET
        ? parseInt(process.env.BEERCAN_TOKEN_BUDGET)
        : undefined,
      logLevel: process.env.BEERCAN_LOG_LEVEL,
      logFile: process.env.BEERCAN_LOG_FILE,
      webhookRateLimit: process.env.BEERCAN_WEBHOOK_RATE_LIMIT
        ? parseInt(process.env.BEERCAN_WEBHOOK_RATE_LIMIT)
        : undefined,
      webhookMaxBodySize: process.env.BEERCAN_WEBHOOK_MAX_BODY_SIZE
        ? parseInt(process.env.BEERCAN_WEBHOOK_MAX_BODY_SIZE)
        : undefined,
      apiKey: process.env.BEERCAN_API_KEY,
      notifyOnComplete: process.env.BEERCAN_NOTIFY_ON_COMPLETE
        ? process.env.BEERCAN_NOTIFY_ON_COMPLETE !== "false"
        : undefined,
      notifyWebhookUrl: process.env.BEERCAN_NOTIFY_WEBHOOK_URL,
    });
  }
  return _config;
}

/** Reset cached config (for testing). */
export function resetConfig(): void {
  _config = null;
}

export function getProjectDir(projectSlug: string): string {
  return path.join(getConfig().dataDir, "projects", projectSlug);
}
