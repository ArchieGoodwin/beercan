import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config.js";
import type { MemoryManager } from "../memory/index.js";
import type { BeerCanDB } from "../storage/database.js";
import type { Bloop, Project } from "../schemas.js";

// ── Reflection Result ───────────────────────────────────────

export interface ReflectionItem {
  title: string;
  content: string;
}

export interface ReflectionResult {
  lessons: ReflectionItem[];
  patterns: ReflectionItem[];
  errors: ReflectionItem[];
  suggestions: string[];
}

// ── Structured Output Tool ──────────────────────────────────

const EXTRACT_REFLECTION_TOOL: Anthropic.Tool = {
  name: "extract_reflection",
  description: "Extract structured reflection from a completed bloop execution. You MUST call this tool.",
  input_schema: {
    type: "object" as const,
    properties: {
      lessons: {
        type: "array",
        description: "Key lessons learned from this execution (what worked, what to do differently).",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short title for the lesson (1 line)" },
            content: { type: "string", description: "Detailed lesson content (2-4 sentences)" },
          },
          required: ["title", "content"],
        },
      },
      patterns: {
        type: "array",
        description: "Recurring patterns or techniques observed (reusable approaches).",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Pattern name" },
            content: { type: "string", description: "Description of the pattern and when to apply it" },
          },
          required: ["title", "content"],
        },
      },
      errors: {
        type: "array",
        description: "Errors encountered and how they were (or could be) resolved.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Error summary" },
            content: { type: "string", description: "What caused it and how to avoid/fix it" },
          },
          required: ["title", "content"],
        },
      },
      suggestions: {
        type: "array",
        items: { type: "string" },
        description: "Suggestions for improving future similar tasks (1-2 sentences each).",
      },
    },
    required: ["lessons", "patterns", "errors", "suggestions"],
  },
};

// ── Reflection Engine ───────────────────────────────────────

export class ReflectionEngine {
  private client: Anthropic;
  private memory: MemoryManager;
  private db: BeerCanDB;

  constructor(client: Anthropic, memory: MemoryManager, db: BeerCanDB) {
    this.client = client;
    this.memory = memory;
    this.db = db;
  }

  /**
   * Run a lightweight reflection on a completed/failed bloop.
   * Single Haiku call with structured output.
   */
  async reflect(bloop: Bloop, projectSlug: string): Promise<ReflectionResult | null> {
    if (bloop.status !== "completed" && bloop.status !== "failed") return null;

    const config = getConfig();
    const model = config.reflectionModel ?? config.gatekeeperModel;

    // Build compact summary of the bloop
    const summary = this.buildReflectionSummary(bloop);

    const response = await this.client.messages.create({
      model,
      max_tokens: 1024,
      system: `You are a post-execution reflection agent. Analyze the bloop execution below and extract structured insights.
Focus on: what worked, what failed, reusable patterns, errors to avoid.
Be concise and actionable. Skip trivial observations.
If the execution was straightforward with nothing noteworthy, return empty arrays.`,
      tools: [EXTRACT_REFLECTION_TOOL],
      tool_choice: { type: "tool" as const, name: "extract_reflection" },
      messages: [
        {
          role: "user",
          content: `Analyze this bloop execution:\n\n${summary}`,
        },
      ],
    });

    // Extract tool call result
    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") return null;

    const result = toolBlock.input as ReflectionResult;

    // Store lessons in memory
    await this.storeLessons(result, bloop, projectSlug);

    // Create knowledge graph entries
    await this.updateKnowledgeGraph(result, bloop, projectSlug);

    return result;
  }

  /**
   * Periodic consolidation: merge duplicate reflection memories,
   * strengthen high-confidence insights, prune low-value ones.
   */
  async consolidate(projectSlug: string): Promise<{ merged: number; pruned: number }> {
    const config = getConfig();
    const model = config.reflectionModel ?? config.gatekeeperModel;

    // Fetch all reflection-tagged memories
    const results = await this.memory.search(projectSlug, "reflection lesson pattern", {
      limit: 50,
    });

    const reflectionMemories = results.filter((r) =>
      r.entry.tags.some((t) => t === "reflection")
    );

    if (reflectionMemories.length < 3) return { merged: 0, pruned: 0 };

    // Build summary for consolidation
    const memoryList = reflectionMemories.map((r, i) =>
      `${i + 1}. [${r.entry.memoryType}] ${r.entry.title}\n   ${r.entry.content.slice(0, 300)}\n   ID: ${r.entry.id} | Confidence: ${r.entry.confidence}`
    ).join("\n\n");

    const response = await this.client.messages.create({
      model,
      max_tokens: 1024,
      system: `You are a memory consolidation agent. Review the reflection memories below and identify:
1. Duplicates that should be merged (list pairs of IDs)
2. High-confidence insights that should be strengthened
3. Low-value memories that add no useful information

Return a JSON object with: { merges: [{keep: "id", remove: "id", merged_content: "..."}], prune: ["id1", "id2"] }`,
      messages: [
        {
          role: "user",
          content: `Consolidate these ${reflectionMemories.length} reflection memories:\n\n${memoryList}`,
        },
      ],
    });

    let merged = 0;
    let pruned = 0;

    // Parse response and apply consolidation
    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      try {
        // Extract JSON from response
        const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const plan = JSON.parse(jsonMatch[0]);

          // Apply merges
          if (Array.isArray(plan.merges)) {
            for (const merge of plan.merges) {
              if (merge.keep && merge.remove && merge.merged_content) {
                await this.memory.updateMemory(projectSlug, merge.keep, {
                  content: merge.merged_content,
                  confidence: 1.0,
                });
                merged++;
              }
            }
          }

          // Apply prunes (reduce confidence rather than delete)
          if (Array.isArray(plan.prune)) {
            for (const id of plan.prune) {
              if (typeof id === "string") {
                await this.memory.updateMemory(projectSlug, id, {
                  content: "(consolidated — low value)",
                  confidence: 0.1,
                });
                pruned++;
              }
            }
          }
        }
      } catch {
        // Consolidation parsing failed — not critical
      }
    }

    return { merged, pruned };
  }

  // ── Internal ──────────────────────────────────────────────

  private buildReflectionSummary(bloop: Bloop): string {
    const resultStr = bloop.result
      ? typeof bloop.result === "string"
        ? bloop.result
        : JSON.stringify(bloop.result)
      : "(no result)";

    const toolNames = [...new Set(bloop.toolCalls.map((tc) => tc.toolName))];
    const errorCount = bloop.toolCalls.filter((tc) => tc.error).length;

    const lines = [
      `Goal: ${bloop.goal}`,
      `Status: ${bloop.status}`,
      `Tokens used: ${bloop.tokensUsed}`,
      `Iterations: ${bloop.iterations}`,
      `Tools used: ${toolNames.join(", ") || "none"}`,
      `Tool errors: ${errorCount}`,
      `\nResult (truncated):\n${resultStr.slice(0, 2000)}`,
    ];

    // Include tool error details if any
    if (errorCount > 0) {
      const errors = bloop.toolCalls
        .filter((tc) => tc.error)
        .slice(0, 5)
        .map((tc) => `  - ${tc.toolName}: ${tc.error}`);
      lines.push(`\nTool errors:\n${errors.join("\n")}`);
    }

    return lines.join("\n");
  }

  private async storeLessons(
    result: ReflectionResult,
    bloop: Bloop,
    projectSlug: string,
  ): Promise<void> {
    // Store lessons
    for (const lesson of result.lessons) {
      await this.memory.storeMemory(projectSlug, {
        projectId: bloop.projectId,
        title: lesson.title,
        content: lesson.content,
        memoryType: "insight",
        tags: ["reflection", "lesson"],
        confidence: 0.8,
        sourceBloopId: bloop.id,
      });
    }

    // Store error resolutions
    for (const error of result.errors) {
      await this.memory.storeMemory(projectSlug, {
        projectId: bloop.projectId,
        title: error.title,
        content: error.content,
        memoryType: "error_resolution",
        tags: ["reflection", "error_pattern"],
        confidence: 0.9,
        sourceBloopId: bloop.id,
      });
    }

    // Store patterns as insights
    for (const pattern of result.patterns) {
      await this.memory.storeMemory(projectSlug, {
        projectId: bloop.projectId,
        title: pattern.title,
        content: pattern.content,
        memoryType: "insight",
        tags: ["reflection", "pattern"],
        confidence: 0.7,
        sourceBloopId: bloop.id,
      });
    }
  }

  private async updateKnowledgeGraph(
    result: ReflectionResult,
    bloop: Bloop,
    _projectSlug: string,
  ): Promise<void> {
    const kg = this.memory.getKnowledgeGraph();

    // Create a bloop entity
    const bloopEntity = kg.getOrCreateEntity(
      bloop.projectId,
      `bloop:${bloop.id.slice(0, 8)}`,
      "concept",
      bloop.goal.slice(0, 200),
      bloop.id,
    );

    // Create lesson entities and link to bloop
    for (const lesson of result.lessons) {
      const lessonEntity = kg.getOrCreateEntity(
        bloop.projectId,
        `lesson:${lesson.title.slice(0, 50)}`,
        "concept",
        lesson.content.slice(0, 200),
        bloop.id,
      );
      kg.createEdge(bloop.projectId, bloopEntity.id, lessonEntity.id, "created_by", 1.0, bloop.id);
    }

    // Create error entities and link
    for (const error of result.errors) {
      const errorEntity = kg.getOrCreateEntity(
        bloop.projectId,
        `error:${error.title.slice(0, 50)}`,
        "error",
        error.content.slice(0, 200),
        bloop.id,
      );
      kg.createEdge(bloop.projectId, bloopEntity.id, errorEntity.id, "caused_by", 1.0, bloop.id);

      // If there's a resolution in the content, link it
      const resolutionEntity = kg.getOrCreateEntity(
        bloop.projectId,
        `resolution:${error.title.slice(0, 50)}`,
        "concept",
        error.content.slice(0, 200),
        bloop.id,
      );
      kg.createEdge(bloop.projectId, errorEntity.id, resolutionEntity.id, "resolved_by", 1.0, bloop.id);
    }
  }
}

// ── Helper: Should a bloop be reflected on? ─────────────────

export function shouldReflect(bloop: Bloop, project: Project): boolean {
  const config = getConfig();

  // Global opt-in
  const globalEnabled = config.reflectionEnabled;

  // Project-level override
  const projectEnabled = project.context?.reflectionEnabled;

  // Neither enabled
  if (!globalEnabled && projectEnabled !== true) return false;

  // Project explicitly disabled
  if (projectEnabled === false) return false;

  // Anti-recursion: don't reflect on heartbeat bloops
  if (bloop.goal.toLowerCase().startsWith("heartbeat check")) return false;

  // Anti-recursion: don't reflect on consolidation or reflection bloops
  if (bloop.goal.toLowerCase().startsWith("consolidate")) return false;
  if (bloop.goal.toLowerCase().startsWith("reflect")) return false;

  // Don't reflect on trivial bloops (too few tokens = probably nothing interesting)
  if (bloop.tokensUsed < 500) return false;

  return true;
}
