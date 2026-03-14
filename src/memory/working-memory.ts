import type { BeerCanDB } from "../storage/database.js";

// ── Working Memory ──────────────────────────────────────────
// Per-bloop ephemeral scratchpad for intermediate reasoning.
// In-memory cache with SQLite write-through for crash recovery.
// Cleaned up after bloop completion.

export class WorkingMemory {
  private cache = new Map<string, Map<string, string>>();

  constructor(private db: BeerCanDB) {}

  /** Create a scope for a new bloop */
  createScope(bloopId: string): void {
    this.cache.set(bloopId, new Map());
  }

  /** Get a value from working memory */
  get(bloopId: string, key: string): string | undefined {
    // Check cache first
    const scope = this.cache.get(bloopId);
    if (scope) {
      const val = scope.get(key);
      if (val !== undefined) return val;
    }

    // Fallback to DB (crash recovery case)
    return this.db.getWorkingMemory(bloopId, key);
  }

  /** Set a value (write-through: cache + DB) */
  set(bloopId: string, key: string, value: string): void {
    // Ensure scope exists
    if (!this.cache.has(bloopId)) {
      this.cache.set(bloopId, new Map());
    }
    this.cache.get(bloopId)!.set(key, value);

    // Write through to DB
    this.db.setWorkingMemory(bloopId, key, value);
  }

  /** List all entries in a bloop's working memory */
  list(bloopId: string): Array<{ key: string; value: string }> {
    // Prefer DB as source of truth (has all data including from crashes)
    return this.db.listWorkingMemory(bloopId);
  }

  /** Delete a key */
  delete(bloopId: string, key: string): void {
    this.cache.get(bloopId)?.delete(key);
    this.db.deleteWorkingMemory(bloopId, key);
  }

  /** Clean up after bloop completion */
  cleanup(bloopId: string): void {
    this.cache.delete(bloopId);
    this.db.clearWorkingMemory(bloopId);
  }
}
