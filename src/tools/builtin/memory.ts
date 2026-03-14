import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";
import type { MemoryManager } from "../../memory/index.js";
import type { MemoryType, EntityType, EdgeType } from "../../memory/schemas.js";

// ── Bloop Context ────────────────────────────────────────────

export interface BloopContext {
  bloopId: string;
  projectId: string;
  projectSlug: string;
}

// ── Memory Tool Factory ─────────────────────────────────────

export function createMemoryTools(
  memory: MemoryManager,
  getBloopContext: () => BloopContext | null,
): Array<{ definition: ToolDefinition; handler: ToolHandler }> {
  return [
    { definition: memorySearchDef, handler: createMemorySearchHandler(memory, getBloopContext) },
    { definition: memoryStoreDef, handler: createMemoryStoreHandler(memory, getBloopContext) },
    { definition: memoryUpdateDef, handler: createMemoryUpdateHandler(memory, getBloopContext) },
    { definition: memoryLinkDef, handler: createMemoryLinkHandler(memory, getBloopContext) },
    { definition: memoryQueryGraphDef, handler: createMemoryQueryGraphHandler(memory, getBloopContext) },
    { definition: memoryScratchDef, handler: createMemoryScratchHandler(memory, getBloopContext) },
  ];
}

// ── memory_search ───────────────────────────────────────────

const memorySearchDef: ToolDefinition = {
  name: "memory_search",
  description:
    "Search long-term memory using hybrid search (full-text + semantic + knowledge graph). Returns relevant memories ranked by relevance.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query text" },
      memory_type: {
        type: "string",
        enum: ["fact", "insight", "decision", "note", "loop_result", "error_resolution"],
        description: "Optional: filter by memory type",
      },
      limit: { type: "number", description: "Max results (default 10)" },
    },
    required: ["query"],
  },
};

function createMemorySearchHandler(memory: MemoryManager, getCtx: () => BloopContext | null): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const results = await memory.search(ctx.projectSlug, input.query as string, {
      projectId: ctx.projectId,
      memoryType: input.memory_type as MemoryType | undefined,
      limit: (input.limit as number) ?? 10,
    });

    if (results.length === 0) return "No memories found matching the query.";

    const lines = results.map((r, i) => {
      const sources = r.sources.map((s) => s.type).join("+");
      return `${i + 1}. [${r.entry.memoryType}] (${sources}, score: ${r.score.toFixed(4)}) ${r.entry.title}\n   ID: ${r.entry.id}\n   ${r.entry.content.slice(0, 500)}`;
    });

    return `Found ${results.length} memories:\n\n${lines.join("\n\n")}`;
  };
}

// ── memory_store ────────────────────────────────────────────

const memoryStoreDef: ToolDefinition = {
  name: "memory_store",
  description:
    "Store a new memory (fact, insight, decision, note). Memories persist across bloops and are searchable.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title for the memory" },
      content: { type: "string", description: "Detailed content" },
      memory_type: {
        type: "string",
        enum: ["fact", "insight", "decision", "note", "error_resolution"],
        description: "Type of memory",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for categorization",
      },
      confidence: { type: "number", description: "Confidence 0-1 (default 1.0)" },
    },
    required: ["title", "content", "memory_type"],
  },
};

function createMemoryStoreHandler(memory: MemoryManager, getCtx: () => BloopContext | null): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const entry = await memory.storeMemory(ctx.projectSlug, {
      projectId: ctx.projectId,
      title: input.title as string,
      content: input.content as string,
      memoryType: input.memory_type as MemoryType,
      tags: input.tags as string[] | undefined,
      confidence: input.confidence as number | undefined,
      sourceBloopId: ctx.bloopId,
    });

    return `Memory stored with ID: ${entry.id}`;
  };
}

// ── memory_update ───────────────────────────────────────────

const memoryUpdateDef: ToolDefinition = {
  name: "memory_update",
  description:
    "Update an existing memory by creating a new version that supersedes it. The old version is preserved for history.",
  inputSchema: {
    type: "object",
    properties: {
      memory_id: { type: "string", description: "ID of the memory to update" },
      title: { type: "string", description: "New title (optional, keeps old if omitted)" },
      content: { type: "string", description: "New content" },
      confidence: { type: "number", description: "New confidence score" },
    },
    required: ["memory_id", "content"],
  },
};

function createMemoryUpdateHandler(memory: MemoryManager, getCtx: () => BloopContext | null): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const updated = await memory.updateMemory(ctx.projectSlug, input.memory_id as string, {
      title: input.title as string | undefined,
      content: input.content as string,
      confidence: input.confidence as number | undefined,
    });

    if (!updated) return `Memory not found: ${input.memory_id}`;
    return `Memory updated. New version ID: ${updated.id} (supersedes ${input.memory_id})`;
  };
}

// ── memory_link ─────────────────────────────────────────────

const memoryLinkDef: ToolDefinition = {
  name: "memory_link",
  description:
    "Create entities and relationships in the knowledge graph. Use to record connections between concepts, files, decisions, errors, etc.",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "object",
        properties: {
          name: { type: "string", description: "Entity name" },
          type: {
            type: "string",
            enum: ["concept", "file", "tool", "decision", "person", "project", "error", "custom"],
          },
          description: { type: "string", description: "Optional description" },
        },
        required: ["name", "type"],
      },
      target: {
        type: "object",
        properties: {
          name: { type: "string", description: "Entity name" },
          type: {
            type: "string",
            enum: ["concept", "file", "tool", "decision", "person", "project", "error", "custom"],
          },
          description: { type: "string", description: "Optional description" },
        },
        required: ["name", "type"],
      },
      relationship: {
        type: "string",
        enum: ["relates_to", "depends_on", "caused_by", "resolved_by", "part_of", "created_by", "supersedes", "uses"],
        description: "Type of relationship from source to target",
      },
    },
    required: ["source", "target", "relationship"],
  },
};

function createMemoryLinkHandler(memory: MemoryManager, getCtx: () => BloopContext | null): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const kg = memory.getKnowledgeGraph();
    const src = input.source as { name: string; type: string; description?: string };
    const tgt = input.target as { name: string; type: string; description?: string };

    const sourceEntity = kg.getOrCreateEntity(
      ctx.projectId, src.name, src.type as EntityType, src.description, ctx.bloopId,
    );
    const targetEntity = kg.getOrCreateEntity(
      ctx.projectId, tgt.name, tgt.type as EntityType, tgt.description, ctx.bloopId,
    );

    const edge = kg.createEdge(
      ctx.projectId, sourceEntity.id, targetEntity.id,
      input.relationship as EdgeType, 1.0, ctx.bloopId,
    );

    return `Linked: ${src.name} --[${input.relationship}]--> ${tgt.name} (edge: ${edge.id})`;
  };
}

// ── memory_query_graph ──────────────────────────────────────

const memoryQueryGraphDef: ToolDefinition = {
  name: "memory_query_graph",
  description:
    "Traverse the knowledge graph to find related entities. Useful for understanding how concepts connect and for multi-hop reasoning.",
  inputSchema: {
    type: "object",
    properties: {
      entity_name: { type: "string", description: "Name of the entity to start from" },
      depth: { type: "number", description: "How many hops to traverse (1-4, default 2)" },
      edge_types: {
        type: "array",
        items: { type: "string" },
        description: "Optional: filter by edge types",
      },
      include_memories: { type: "boolean", description: "Include linked memories for each entity (default false)" },
    },
    required: ["entity_name"],
  },
};

function createMemoryQueryGraphHandler(memory: MemoryManager, getCtx: () => BloopContext | null): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const kg = memory.getKnowledgeGraph();
    const entity = kg.findByName(ctx.projectId, input.entity_name as string);
    if (!entity) return `Entity not found: ${input.entity_name}`;

    const depth = Math.min((input.depth as number) ?? 2, 4);
    const edgeTypes = input.edge_types as EdgeType[] | undefined;
    const includeMemories = (input.include_memories as boolean) ?? false;

    const neighbors = kg.getNeighbors(entity.id, depth, edgeTypes);

    // Build result text
    const lines: string[] = [
      `Entity: ${entity.name} (${entity.entityType})`,
      entity.description ? `Description: ${entity.description}` : "",
      `\nConnected entities (depth ${depth}):`,
    ];

    // Show edges from the starting entity
    const edges = kg.getEdgesFrom(entity.id);
    for (const edge of edges) {
      const target = kg.getEntity(edge.targetId);
      if (target) {
        lines.push(`  --[${edge.edgeType}]--> ${target.name} (${target.entityType})`);
      }
    }
    const inEdges = kg.getEdgesTo(entity.id);
    for (const edge of inEdges) {
      const source = kg.getEntity(edge.sourceId);
      if (source) {
        lines.push(`  <--[${edge.edgeType}]-- ${source.name} (${source.entityType})`);
      }
    }

    if (neighbors.length > 0) {
      lines.push(`\nAll reachable entities (${neighbors.length}):`);
      for (const n of neighbors) {
        let line = `  - ${n.name} (${n.entityType})`;
        if (n.description) line += `: ${n.description}`;

        if (includeMemories) {
          const memories = kg.getMemoriesForEntity(n.id);
          if (memories.length > 0) {
            line += `\n    Memories: ${memories.map((m) => `[${m.memoryType}] ${m.title}`).join("; ")}`;
          }
        }
        lines.push(line);
      }
    }

    return lines.filter(Boolean).join("\n");
  };
}

// ── memory_scratch ──────────────────────────────────────────

const memoryScratchDef: ToolDefinition = {
  name: "memory_scratch",
  description:
    "Read or write to the working memory scratchpad for the current bloop. Use for intermediate reasoning, tracking progress, or passing context between agent phases.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["get", "set", "list", "delete"], description: "Operation to perform" },
      key: { type: "string", description: "Key to read/write (required for get/set/delete)" },
      value: { type: "string", description: "Value to store (required for set)" },
    },
    required: ["action"],
  },
};

function createMemoryScratchHandler(memory: MemoryManager, getCtx: () => BloopContext | null): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const wm = memory.getWorkingMemory();
    const action = input.action as string;
    const key = input.key as string;

    switch (action) {
      case "get": {
        if (!key) throw new Error("Key is required for get");
        const val = wm.get(ctx.bloopId, key);
        return val ?? "(not found)";
      }
      case "set": {
        if (!key) throw new Error("Key is required for set");
        if (!input.value) throw new Error("Value is required for set");
        wm.set(ctx.bloopId, key, input.value as string);
        return "OK";
      }
      case "list": {
        const items = wm.list(ctx.bloopId);
        if (items.length === 0) return "(empty)";
        return items.map((i) => `${i.key}: ${i.value}`).join("\n");
      }
      case "delete": {
        if (!key) throw new Error("Key is required for delete");
        wm.delete(ctx.bloopId, key);
        return "OK";
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  };
}
