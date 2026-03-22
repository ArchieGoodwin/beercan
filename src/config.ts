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
  // Phase 1: Self-spawning limits
  maxChildrenPerBloop: z.number().default(5),
  maxSpawnDepth: z.number().default(3),
  // Phase 2: Self-scheduling limits
  maxSchedulesPerProject: z.number().default(20),
  maxTriggersPerProject: z.number().default(20),
  minCronIntervalMinutes: z.number().default(5),
  // Phase 3: Heartbeat
  heartbeatDefaultInterval: z.number().default(30),
  heartbeatActiveHours: z.string().default("08:00-22:00"),
  heartbeatMinInterval: z.number().default(5),
  // Phase 4: Reflection
  reflectionEnabled: z.boolean().default(true),
  reflectionModel: z.string().optional(),
  // System projects
  maintenanceEnabled: z.boolean().default(true),
  maintenanceIntervalMinutes: z.number().default(360),
  calendarEnabled: z.boolean().default(false),
  calendarCheckIntervalMinutes: z.number().default(60),
  calendarMorningBriefCron: z.string().default("0 8 * * *"),
  // Encryption
  encryptionEnabled: z.boolean().default(false),
  encryptionMode: z.enum(["passphrase", "keyfile"]).default("passphrase"),
  encryptionKeyfile: z.string().optional(),
  encryptionPassphrase: z.string().optional(),  // For daemon mode (avoids interactive prompt)
  logSanitize: z.boolean().optional(),           // Force log sanitization on/off
  // WebSocket TLS
  wsTlsCert: z.string().optional(),
  wsTlsKey: z.string().optional(),
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
      maxChildrenPerBloop: process.env.BEERCAN_MAX_CHILDREN_PER_BLOOP
        ? parseInt(process.env.BEERCAN_MAX_CHILDREN_PER_BLOOP)
        : undefined,
      maxSpawnDepth: process.env.BEERCAN_MAX_SPAWN_DEPTH
        ? parseInt(process.env.BEERCAN_MAX_SPAWN_DEPTH)
        : undefined,
      maxSchedulesPerProject: process.env.BEERCAN_MAX_SCHEDULES_PER_PROJECT
        ? parseInt(process.env.BEERCAN_MAX_SCHEDULES_PER_PROJECT)
        : undefined,
      maxTriggersPerProject: process.env.BEERCAN_MAX_TRIGGERS_PER_PROJECT
        ? parseInt(process.env.BEERCAN_MAX_TRIGGERS_PER_PROJECT)
        : undefined,
      minCronIntervalMinutes: process.env.BEERCAN_MIN_CRON_INTERVAL
        ? parseInt(process.env.BEERCAN_MIN_CRON_INTERVAL)
        : undefined,
      heartbeatDefaultInterval: process.env.BEERCAN_HEARTBEAT_INTERVAL
        ? parseInt(process.env.BEERCAN_HEARTBEAT_INTERVAL)
        : undefined,
      heartbeatActiveHours: process.env.BEERCAN_HEARTBEAT_HOURS,
      heartbeatMinInterval: process.env.BEERCAN_HEARTBEAT_MIN_INTERVAL
        ? parseInt(process.env.BEERCAN_HEARTBEAT_MIN_INTERVAL)
        : undefined,
      maintenanceEnabled: process.env.BEERCAN_MAINTENANCE_ENABLED
        ? process.env.BEERCAN_MAINTENANCE_ENABLED !== "false"
        : undefined,
      maintenanceIntervalMinutes: process.env.BEERCAN_MAINTENANCE_INTERVAL
        ? parseInt(process.env.BEERCAN_MAINTENANCE_INTERVAL)
        : undefined,
      calendarEnabled: process.env.BEERCAN_CALENDAR_ENABLED
        ? process.env.BEERCAN_CALENDAR_ENABLED === "true"
        : undefined,
      calendarCheckIntervalMinutes: process.env.BEERCAN_CALENDAR_CHECK_INTERVAL
        ? parseInt(process.env.BEERCAN_CALENDAR_CHECK_INTERVAL)
        : undefined,
      calendarMorningBriefCron: process.env.BEERCAN_CALENDAR_MORNING_BRIEF_CRON,
      reflectionEnabled: process.env.BEERCAN_REFLECTION_ENABLED
        ? process.env.BEERCAN_REFLECTION_ENABLED === "true"
        : undefined,
      reflectionModel: process.env.BEERCAN_REFLECTION_MODEL,
      encryptionEnabled: process.env.BEERCAN_ENCRYPTION_ENABLED
        ? process.env.BEERCAN_ENCRYPTION_ENABLED === "true"
        : undefined,
      encryptionMode: process.env.BEERCAN_ENCRYPTION_MODE,
      encryptionKeyfile: process.env.BEERCAN_ENCRYPTION_KEYFILE,
      encryptionPassphrase: process.env.BEERCAN_ENCRYPTION_PASSPHRASE,
      logSanitize: process.env.BEERCAN_LOG_SANITIZE
        ? process.env.BEERCAN_LOG_SANITIZE === "true"
        : undefined,
      wsTlsCert: process.env.BEERCAN_WS_TLS_CERT,
      wsTlsKey: process.env.BEERCAN_WS_TLS_KEY,
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
