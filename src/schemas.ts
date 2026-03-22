import { z } from "zod";

// ── Bloop Status ──────────────────────────────────────────────
export const BloopStatus = z.enum([
  "created",
  "running",
  "waiting",   // waiting for child bloops or external event
  "completed",
  "failed",
  "timeout",
]);
export type BloopStatus = z.infer<typeof BloopStatus>;

// ── Bloop Trigger ─────────────────────────────────────────────
export const BloopTrigger = z.enum([
  "manual",
  "cron",
  "event",
  "child_of",
]);
export type BloopTrigger = z.infer<typeof BloopTrigger>;

// ── Tool Call (audit log entry) ──────────────────────────────
export const ToolCallRecord = z.object({
  id: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
  timestamp: z.string().datetime(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

// ── Message in Bloop conversation ─────────────────────────────
export const BloopMessage = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  toolCalls: z.array(ToolCallRecord).optional(),
  timestamp: z.string().datetime(),
});
export type BloopMessage = z.infer<typeof BloopMessage>;

// ── Bloop ─────────────────────────────────────────────────────
export const BloopSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  parentBloopId: z.string().uuid().nullable().default(null),
  trigger: BloopTrigger.default("manual"),
  status: BloopStatus.default("created"),
  goal: z.string(),
  systemPrompt: z.string().optional(),
  messages: z.array(BloopMessage).default([]),
  result: z.unknown().nullable().default(null),
  toolCalls: z.array(ToolCallRecord).default([]),
  tokensUsed: z.number().default(0),
  iterations: z.number().default(0),
  maxIterations: z.number().default(50),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().default(null),
});
export type Bloop = z.infer<typeof BloopSchema>;

// ── Project ──────────────────────────────────────────────────
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().optional(),
  /** Working directory for agent file/exec operations. If set, agents operate in this folder. */
  workDir: z.string().optional(),
  /** System projects are auto-created and hidden from default listings. */
  system: z.boolean().default(false),
  context: z.record(z.unknown()).default({}),
  allowedTools: z.array(z.string()).default(["*"]),
  tokenBudget: z.object({
    dailyLimit: z.number().default(100_000),
    perBloopLimit: z.number().default(20_000),
  }).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ── Tool Definition ──────────────────────────────────────────
export const ToolDefinition = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinition>;
