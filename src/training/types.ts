import { z } from "zod";

// ── Scenario Difficulty ───────────────────────────────────────

export const ScenarioDifficulty = z.enum([
  "novice",
  "apprentice",
  "journeyman",
  "expert",
]);
export type ScenarioDifficulty = z.infer<typeof ScenarioDifficulty>;

// ── Scenario Category ─────────────────────────────────────────

export const ScenarioCategory = z.enum([
  "memory",
  "tools",
  "reasoning",
  "coding",
  "creativity",
  "planning",
  "self_improvement",
]);
export type ScenarioCategory = z.infer<typeof ScenarioCategory>;

// ── Evaluator Type ────────────────────────────────────────────

export const EvaluatorType = z.enum(["llm", "regex", "contains"]);
export type EvaluatorType = z.infer<typeof EvaluatorType>;

// ── Evaluator Config ─────────────────────────────────────────

export const EvaluatorConfigSchema = z.object({
  /** For regex/contains: the pattern to match against the result */
  pattern: z.string().optional(),
  /** For llm: the criteria to evaluate against */
  criteria: z.string().optional(),
  /** Pass threshold for LLM scores (default 0.6) */
  passThreshold: z.number().min(0).max(1).default(0.6),
});
export type EvaluatorConfig = z.infer<typeof EvaluatorConfigSchema>;

// ── Training Scenario ─────────────────────────────────────────

export const TrainingScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  difficulty: ScenarioDifficulty,
  category: ScenarioCategory,
  /** The goal string passed to the bloop */
  goal: z.string(),
  /** Human-readable description of what is being evaluated */
  evaluationCriteria: z.string(),
  evaluatorType: EvaluatorType,
  evaluatorConfig: EvaluatorConfigSchema,
  /** What capabilities this scenario teaches/tests */
  teaches: z.array(z.string()).default([]),
  /** Tool names required for this scenario */
  requiredTools: z.array(z.string()).default([]),
  /** IDs of scenarios that must be passed before this one */
  prerequisites: z.array(z.string()).default([]),
  maxAttempts: z.number().default(3),
  timeoutMs: z.number().default(300_000),
});
export type TrainingScenario = z.infer<typeof TrainingScenarioSchema>;

// ── Scenario Attempt ──────────────────────────────────────────

export const AttemptStatusSchema = z.enum(["pass", "fail", "error"]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;

export const ScenarioAttemptSchema = z.object({
  scenarioId: z.string(),
  bloopId: z.string(),
  status: AttemptStatusSchema,
  /** Score between 0 and 1 */
  score: z.number().min(0).max(1),
  feedback: z.string(),
  tokensUsed: z.number(),
  durationMs: z.number(),
  attemptNumber: z.number(),
  timestamp: z.string().datetime(),
});
export type ScenarioAttempt = z.infer<typeof ScenarioAttemptSchema>;

// ── Training Progress ─────────────────────────────────────────

export const GraduationStatus = z.enum(["training", "graduated", "failed"]);
export type GraduationStatus = z.infer<typeof GraduationStatus>;

export const FailedScenarioRecordSchema = z.object({
  id: z.string(),
  attempts: z.number(),
});
export type FailedScenarioRecord = z.infer<typeof FailedScenarioRecordSchema>;

export const TrainingProgressSchema = z.object({
  projectSlug: z.string(),
  currentLevel: ScenarioDifficulty,
  passedScenarios: z.array(z.string()).default([]),
  failedScenarios: z.array(FailedScenarioRecordSchema).default([]),
  scenarioAttempts: z.array(ScenarioAttemptSchema).default([]),
  createdTools: z.array(z.string()).default([]),
  createdSkills: z.array(z.string()).default([]),
  graduationStatus: GraduationStatus.default("training"),
  startedAt: z.string().datetime(),
  graduatedAt: z.string().datetime().optional(),
  totalTokensUsed: z.number().default(0),
  totalBloops: z.number().default(0),
});
export type TrainingProgress = z.infer<typeof TrainingProgressSchema>;

// ── Graduation Criteria ───────────────────────────────────────

export const GraduationCriteriaSchema = z.object({
  /** Minimum pass rate required per difficulty level (0-1) */
  minPassRateByLevel: z.record(ScenarioDifficulty, z.number()),
  /** Scenario IDs that must be passed regardless of pass rate */
  requiredScenarioIds: z.array(z.string()).default([]),
  /** Minimum number of custom tools created */
  minToolsCreated: z.number().default(0),
  /** Minimum number of skills created */
  minSkillsCreated: z.number().default(0),
});
export type GraduationCriteria = z.infer<typeof GraduationCriteriaSchema>;

// ── Agent Package ─────────────────────────────────────────────

export const AgentPackageMemorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  memoryType: z.string(),
  title: z.string(),
  content: z.string(),
  sourceBloopId: z.string().nullable(),
  supersededBy: z.string().nullable(),
  confidence: z.number(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentPackageMemory = z.infer<typeof AgentPackageMemorySchema>;

export const AgentPackageKGEntitySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  entityType: z.string(),
  description: z.string().nullable(),
  properties: z.record(z.unknown()),
  sourceBloopId: z.string().nullable(),
  sourceMemoryId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentPackageKGEntity = z.infer<typeof AgentPackageKGEntitySchema>;

export const AgentPackageKGEdgeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  edgeType: z.string(),
  weight: z.number(),
  properties: z.record(z.unknown()),
  sourceBloopId: z.string().nullable(),
  createdAt: z.string(),
});
export type AgentPackageKGEdge = z.infer<typeof AgentPackageKGEdgeSchema>;

export const AgentPackageSkillSchema = z.object({
  name: z.string(),
  content: z.string(),
});
export type AgentPackageSkill = z.infer<typeof AgentPackageSkillSchema>;

export const AgentPackageToolSchema = z.object({
  name: z.string(),
  content: z.string(),
});
export type AgentPackageTool = z.infer<typeof AgentPackageToolSchema>;

export const AgentPackageSchema = z.object({
  version: z.string(),
  exportedAt: z.string().datetime(),
  agentName: z.string(),
  agentSlug: z.string(),
  trainingProgress: TrainingProgressSchema.optional(),
  memories: z.array(AgentPackageMemorySchema).default([]),
  knowledgeGraphEntities: z.array(AgentPackageKGEntitySchema).default([]),
  knowledgeGraphEdges: z.array(AgentPackageKGEdgeSchema).default([]),
  skills: z.array(AgentPackageSkillSchema).default([]),
  tools: z.array(AgentPackageToolSchema).default([]),
  projectContext: z.record(z.unknown()).default({}),
});
export type AgentPackage = z.infer<typeof AgentPackageSchema>;
