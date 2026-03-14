import { z } from "zod";

// ── Memory Types ────────────────────────────────────────────

export const MemoryType = z.enum([
  "fact",
  "insight",
  "decision",
  "note",
  "loop_result",
  "error_resolution",
]);
export type MemoryType = z.infer<typeof MemoryType>;

// ── Memory Entry ────────────────────────────────────────────

export const MemoryEntrySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  memoryType: MemoryType,
  title: z.string(),
  content: z.string(),
  sourceBloopId: z.string().uuid().nullable().default(null),
  supersededBy: z.string().uuid().nullable().default(null),
  confidence: z.number().min(0).max(1).default(1.0),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

// ── Memory Search Result ────────────────────────────────────

export const MemorySearchResultSchema = z.object({
  entry: MemoryEntrySchema,
  score: z.number(),
  source: z.enum(["fts", "vector", "graph"]),
});
export type MemorySearchResult = z.infer<typeof MemorySearchResultSchema>;

// ── Knowledge Graph Types ───────────────────────────────────

export const EntityType = z.enum([
  "concept",
  "file",
  "tool",
  "decision",
  "person",
  "project",
  "error",
  "custom",
]);
export type EntityType = z.infer<typeof EntityType>;

export const EdgeType = z.enum([
  "relates_to",
  "depends_on",
  "caused_by",
  "resolved_by",
  "part_of",
  "created_by",
  "supersedes",
  "uses",
]);
export type EdgeType = z.infer<typeof EdgeType>;

export const KGEntitySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  name: z.string(),
  entityType: EntityType,
  description: z.string().nullable().default(null),
  properties: z.record(z.unknown()).default({}),
  sourceBloopId: z.string().uuid().nullable().default(null),
  sourceMemoryId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type KGEntity = z.infer<typeof KGEntitySchema>;

export const KGEdgeSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  edgeType: EdgeType,
  weight: z.number().default(1.0),
  properties: z.record(z.unknown()).default({}),
  sourceBloopId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
});
export type KGEdge = z.infer<typeof KGEdgeSchema>;
