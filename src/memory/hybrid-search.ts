import type { BeerCanDB } from "../storage/database.js";
import type { SqliteVecStore, VecSearchResult } from "./sqlite-vec-store.js";
import type { KnowledgeGraph } from "./knowledge-graph.js";
import type { MemoryEntry, MemoryType } from "./schemas.js";

// ── Hybrid Search ───────────────────────────────────────────
// Combines FTS5 (BM25), sqlite-vec (semantic similarity),
// and knowledge graph expansion using Reciprocal Rank Fusion (RRF).

export interface HybridSearchOptions {
  query: string;
  projectId: string;
  projectSlug: string;
  memoryType?: MemoryType;
  limit?: number;
}

export interface HybridSearchResult {
  entry: MemoryEntry;
  score: number;
  sources: Array<{ type: "fts" | "vector" | "graph"; rank: number }>;
}

const RRF_K = 60; // Standard RRF constant

export class HybridSearch {
  constructor(
    private db: BeerCanDB,
    private vecStore: SqliteVecStore,
    private kg: KnowledgeGraph,
  ) {}

  async search(options: HybridSearchOptions): Promise<HybridSearchResult[]> {
    const { query, projectId, memoryType, limit = 10 } = options;
    const fetchLimit = limit * 2; // Over-fetch for better RRF merging

    // Run FTS5 and vector search in parallel
    const [ftsResults, vectorResults] = await Promise.all([
      this.searchFTS(projectId, query, fetchLimit),
      this.searchVector(query, fetchLimit),
    ]);

    // Graph expansion: find entities matching query, get their linked memory IDs
    const graphMemoryIds = this.graphExpand(projectId, query);

    // Build RRF score map
    const scoreMap = new Map<string, HybridSearchResult>();

    // FTS contributions
    for (let rank = 0; rank < ftsResults.length; rank++) {
      const entry = ftsResults[rank];
      if (memoryType && entry.memoryType !== memoryType) continue;
      this.addScore(scoreMap, entry, rank, "fts");
    }

    // Vector contributions (look up the MemoryEntry for each vector result)
    for (let rank = 0; rank < vectorResults.length; rank++) {
      const result = vectorResults[rank];
      const entry = this.db.getMemoryEntry(result.memoryId);
      if (!entry) continue;
      if (memoryType && entry.memoryType !== memoryType) continue;
      this.addScore(scoreMap, entry, rank, "vector");
    }

    // Graph contributions (boost)
    for (let rank = 0; rank < graphMemoryIds.length; rank++) {
      const entry = this.db.getMemoryEntry(graphMemoryIds[rank]);
      if (!entry) continue;
      if (memoryType && entry.memoryType !== memoryType) continue;
      this.addScore(scoreMap, entry, rank, "graph");
    }

    // Sort by combined RRF score, return top results
    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private searchFTS(projectId: string, query: string, limit: number): MemoryEntry[] {
    try {
      return this.db.searchMemoryFTS(projectId, query, limit);
    } catch {
      // FTS query might fail on syntax errors (e.g., special characters)
      return [];
    }
  }

  private async searchVector(query: string, limit: number): Promise<VecSearchResult[]> {
    try {
      return this.vecStore.query(query, limit);
    } catch {
      return [];
    }
  }

  private graphExpand(projectId: string, query: string): string[] {
    try {
      // Find entities whose names match the query terms
      const entities = this.kg.searchEntities(projectId, query);
      if (entities.length === 0) return [];

      // Collect memory IDs linked to matching entities and their neighbors
      const memoryIds = new Set<string>();
      for (const entity of entities.slice(0, 5)) {
        // Direct entity memories
        const directIds = this.db.getKGEntityMemoryIds(entity.id);
        for (const id of directIds) memoryIds.add(id);

        // Neighbor entity memories (1 hop)
        const neighbors = this.kg.getNeighbors(entity.id, 1);
        for (const neighbor of neighbors.slice(0, 10)) {
          const neighborIds = this.db.getKGEntityMemoryIds(neighbor.id);
          for (const id of neighborIds) memoryIds.add(id);
        }
      }

      return Array.from(memoryIds);
    } catch {
      return [];
    }
  }

  private addScore(
    scoreMap: Map<string, HybridSearchResult>,
    entry: MemoryEntry,
    rank: number,
    source: "fts" | "vector" | "graph",
  ): void {
    const rrfScore = 1 / (RRF_K + rank + 1);

    const existing = scoreMap.get(entry.id);
    if (existing) {
      existing.score += rrfScore;
      existing.sources.push({ type: source, rank });
    } else {
      scoreMap.set(entry.id, {
        entry,
        score: rrfScore,
        sources: [{ type: source, rank }],
      });
    }
  }
}
