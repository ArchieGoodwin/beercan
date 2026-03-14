/**
 * Embedding providers for vector memory.
 * Default: TF-IDF based local embeddings (no API calls needed).
 * Pluggable: swap in Voyage AI or OpenAI for neural embeddings.
 */

// ── Embedding Provider Interface ────────────────────────────

export interface EmbeddingProvider {
  /** Generate embedding vector from text */
  embed(text: string): Promise<number[]>;
  /** Dimensionality of output vectors */
  dimensions: number;
}

// ── Local TF-IDF Embedder (default, no API needed) ─────────

const VOCAB_SIZE = 512; // Fixed-dimension output

/**
 * Simple but effective local embedder using hashed TF-IDF.
 * No external API calls. Deterministic. Fast.
 * Good enough for finding similar goals/results in a personal system.
 */
export class LocalEmbedder implements EmbeddingProvider {
  dimensions = VOCAB_SIZE;

  async embed(text: string): Promise<number[]> {
    return hashTfIdf(text, VOCAB_SIZE);
  }
}

/** Hash-based TF-IDF: maps tokens to fixed-size vector via hashing trick */
function hashTfIdf(text: string, dims: number): number[] {
  const vector = new Float64Array(dims);
  const tokens = tokenize(text);
  const tf = new Map<string, number>();

  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  for (const [token, count] of tf) {
    // Hashing trick: map token to bucket
    const hash = fnv1a(token);
    const bucket = ((hash % dims) + dims) % dims;
    // Sign from second hash for variance reduction
    const sign = fnv1a(token + "_sign") % 2 === 0 ? 1 : -1;
    // TF weight with sublinear scaling
    vector[bucket] += sign * (1 + Math.log(count));
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) vector[i] /= norm;
  }

  return Array.from(vector);
}

/** Simple tokenizer: lowercase, split on non-alphanumeric, filter short */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/** FNV-1a hash (32-bit) */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// ── LRU Cache for embeddings ────────────────────────────────

export class EmbeddingCache {
  private cache = new Map<string, number[]>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  get(key: string): number[] | undefined {
    const val = this.cache.get(key);
    if (val) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  set(key: string, value: number[]): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }
}
