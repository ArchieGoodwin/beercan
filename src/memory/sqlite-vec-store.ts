import type { BeerCanDB } from "../storage/database.js";
import type { EmbeddingProvider } from "./embeddings.js";

// ── SQLite-Vec Vector Store ─────────────────────────────────
// Stores embeddings in SQLite via sqlite-vec extension.
// Single DB, transactional consistency with memory_entries.

export interface VecSearchResult {
  memoryId: string;
  distance: number;
}

export class SqliteVecStore {
  constructor(
    private db: BeerCanDB,
    private embedder: EmbeddingProvider,
  ) {}

  /** Store a vector for a memory entry */
  async store(memoryId: string, text: string): Promise<void> {
    const vector = await this.embedder.embed(text);
    const f32 = new Float32Array(vector);
    this.db.storeVector(memoryId, f32);
  }

  /** Update a vector for an existing memory entry */
  async update(memoryId: string, text: string): Promise<void> {
    const vector = await this.embedder.embed(text);
    const f32 = new Float32Array(vector);
    this.db.updateVector(memoryId, f32);
  }

  /** Delete a vector by memory ID */
  delete(memoryId: string): void {
    this.db.deleteVector(memoryId);
  }

  /** Query for nearest vectors, returns memory IDs with distances */
  async query(text: string, topK = 10): Promise<VecSearchResult[]> {
    if (!this.db.hasVectors()) return [];

    const vector = await this.embedder.embed(text);
    const f32 = new Float32Array(vector);
    return this.db.queryVectors(f32, topK);
  }

  /** Check if any vectors exist */
  hasItems(): boolean {
    return this.db.hasVectors();
  }
}
