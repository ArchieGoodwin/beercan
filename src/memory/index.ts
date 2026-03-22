import { v4 as uuid } from "uuid";
import { LocalEmbedder, EmbeddingCache, type EmbeddingProvider } from "./embeddings.js";
import { SqliteVecStore } from "./sqlite-vec-store.js";
import { KnowledgeGraph } from "./knowledge-graph.js";
import { WorkingMemory } from "./working-memory.js";
import { HybridSearch, type HybridSearchResult, type HybridSearchOptions } from "./hybrid-search.js";
import type { BeerCanDB } from "../storage/database.js";
import type { MemoryEntry, MemoryType } from "./schemas.js";
import type { Bloop } from "../schemas.js";

// ── Memory Manager ──────────────────────────────────────────
// Central facade over all memory subsystems:
// - FTS5 full-text search (BM25 keyword matching)
// - sqlite-vec vector store (semantic similarity)
// - Knowledge graph (entity relationships, multi-hop)
// - Working memory (per-bloop scratchpad)
// - Hybrid search (RRF-fused results)

export class MemoryManager {
  private embedder: EmbeddingProvider;
  private cache: EmbeddingCache;
  private db: BeerCanDB;
  private vecStore: SqliteVecStore;
  private kg: KnowledgeGraph;
  private wm: WorkingMemory;
  private hybridSearch: HybridSearch;

  constructor(db: BeerCanDB, embedder?: EmbeddingProvider) {
    this.db = db;
    this.embedder = embedder ?? new LocalEmbedder();
    this.cache = new EmbeddingCache(500);
    this.vecStore = new SqliteVecStore(db, this.embedder);
    this.kg = new KnowledgeGraph(db);
    this.wm = new WorkingMemory(db);
    this.hybridSearch = new HybridSearch(
      db,
      this.vecStore,
      this.kg,
    );
  }

  // ── Subsystem Access ──────────────────────────────────

  getKnowledgeGraph(): KnowledgeGraph {
    return this.kg;
  }

  getWorkingMemory(): WorkingMemory {
    return this.wm;
  }

  getVectorStore(): SqliteVecStore {
    return this.vecStore;
  }

  // ── Store Bloop Result ─────────────────────────────────

  /** Store a completed bloop's result in both FTS5 and sqlite-vec */
  async storeBloopResult(bloop: Bloop, projectSlug: string): Promise<void> {
    if (bloop.status !== "completed" || !bloop.result) return;

    try {
      const summary = typeof bloop.result === "string"
        ? bloop.result
        : JSON.stringify(bloop.result).slice(0, 2000);

      const now = new Date().toISOString();
      const memoryId = uuid();

      // Create structured memory entry (FTS5-indexed)
      const entry: MemoryEntry = {
        id: memoryId,
        projectId: bloop.projectId,
        memoryType: "loop_result",
        title: bloop.goal,
        content: summary,
        sourceBloopId: bloop.id,
        supersededBy: null,
        confidence: 1.0,
        tags: [],
        createdAt: now,
        updatedAt: now,
      };
      this.db.createMemoryEntry(entry);

      // Store vector embedding in sqlite-vec
      const text = `${bloop.goal}\n${summary}`;
      await this.vecStore.store(memoryId, text);
    } catch (err: any) {
      console.warn(`[memory] Failed to store bloop result: ${err.message}`);
    }
  }

  // ── Store Arbitrary Memory ────────────────────────────

  /** Store a new memory (fact, insight, decision, note) */
  async storeMemory(
    projectSlug: string,
    opts: {
      projectId: string;
      title: string;
      content: string;
      memoryType: MemoryType;
      tags?: string[];
      confidence?: number;
      sourceBloopId?: string;
    },
  ): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const memoryId = uuid();

    const entry: MemoryEntry = {
      id: memoryId,
      projectId: opts.projectId,
      memoryType: opts.memoryType,
      title: opts.title,
      content: opts.content,
      sourceBloopId: opts.sourceBloopId ?? null,
      supersededBy: null,
      confidence: opts.confidence ?? 1.0,
      tags: opts.tags ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.db.createMemoryEntry(entry);

    // Store vector embedding
    try {
      const text = `${opts.title}\n${opts.content}`;
      await this.vecStore.store(memoryId, text);
    } catch (err: any) {
      console.warn(`[memory] Failed to store vector: ${err.message}`);
    }

    return entry;
  }

  // ── Update Memory (supersede model) ───────────────────

  /** Update a memory by creating a new version that supersedes it */
  async updateMemory(
    projectSlug: string,
    memoryId: string,
    updates: { title?: string; content: string; confidence?: number },
  ): Promise<MemoryEntry | null> {
    const old = this.db.getMemoryEntry(memoryId);
    if (!old) return null;

    const now = new Date().toISOString();
    const newEntry: MemoryEntry = {
      id: uuid(),
      projectId: old.projectId,
      memoryType: old.memoryType,
      title: updates.title ?? old.title,
      content: updates.content,
      sourceBloopId: old.sourceBloopId,
      supersededBy: null,
      confidence: updates.confidence ?? old.confidence,
      tags: old.tags,
      createdAt: now,
      updatedAt: now,
    };

    this.db.supersedeMemoryEntry(memoryId, newEntry);

    // Store new vector
    try {
      const text = `${newEntry.title}\n${newEntry.content}`;
      await this.vecStore.store(newEntry.id, text);
    } catch (err: any) {
      console.warn(`[memory] Failed to store updated vector: ${err.message}`);
    }

    return newEntry;
  }

  // ── Hybrid Search ─────────────────────────────────────

  /** Search across all memory layers using RRF-fused hybrid search */
  async search(
    projectSlug: string,
    query: string,
    opts?: { projectId?: string; memoryType?: MemoryType; limit?: number },
  ): Promise<HybridSearchResult[]> {
    let projectId = opts?.projectId;
    if (!projectId) {
      const project = this.db.getProjectBySlug(projectSlug);
      if (!project) return [];
      projectId = project.id;
    }

    return this.hybridSearch.search({
      query,
      projectId,
      projectSlug,
      memoryType: opts?.memoryType,
      limit: opts?.limit,
    });
  }

  /** Search across ALL projects (no project filter) */
  async searchGlobal(
    query: string,
    opts?: { memoryType?: MemoryType; limit?: number },
  ): Promise<HybridSearchResult[]> {
    return this.hybridSearch.search({
      query,
      memoryType: opts?.memoryType,
      limit: opts?.limit,
    });
  }

  /** Delete a memory entry by ID (also removes vector + FTS) */
  deleteEntry(memoryId: string): boolean {
    const existing = this.db.getMemoryEntry(memoryId);
    if (!existing) return false;
    this.vecStore.delete(memoryId);
    this.db.deleteMemoryEntry(memoryId);
    return true;
  }

  // ── Retrieve Context ──────────────────────────────────

  /** Retrieve relevant past context for a new goal */
  async retrieveContext(projectSlug: string, goal: string, count = 5): Promise<string> {
    try {
      const parts: string[] = [];

      const results = await this.search(projectSlug, goal, { limit: count });
      if (results.length > 0) {
        const lines = results.map((r, i) =>
          `${i + 1}. [${r.entry.memoryType}] ${r.entry.title}\n   ${r.entry.content.slice(0, 300)}`
        );
        parts.push(`\n--- Relevant Memories ---\n${lines.join("\n\n")}`);
      }

      // Also search for reflection lessons from past bloops
      try {
        const lessons = await this.search(projectSlug, goal, {
          memoryType: "insight",
          limit: 3,
        });
        const reflectionLessons = lessons.filter((r) =>
          r.entry.tags.some((t) => t === "reflection")
        );
        if (reflectionLessons.length > 0) {
          const lessonLines = reflectionLessons.map((r, i) =>
            `${i + 1}. ${r.entry.title}\n   ${r.entry.content.slice(0, 300)}`
          );
          parts.push(`\n--- Lessons from Past Bloops ---\n${lessonLines.join("\n\n")}`);
        }
      } catch {
        // Non-critical — skip if lesson search fails
      }

      return parts.join("\n");
    } catch (err: any) {
      console.warn(`[memory] Failed to retrieve context: ${err.message}`);
      return "";
    }
  }
}

export { SqliteVecStore } from "./sqlite-vec-store.js";
export { LocalEmbedder, type EmbeddingProvider } from "./embeddings.js";
export { KnowledgeGraph } from "./knowledge-graph.js";
export { WorkingMemory } from "./working-memory.js";
export { HybridSearch } from "./hybrid-search.js";
export type { HybridSearchResult, HybridSearchOptions } from "./hybrid-search.js";
export type { MemoryEntry, MemoryType, KGEntity, KGEdge, EntityType, EdgeType } from "./schemas.js";
