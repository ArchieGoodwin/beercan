import fs from "node:fs";
import path from "node:path";
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  packAesGcm,
  unpackAesGcm,
  hkdfDerive,
  scryptDerive,
  generateRandomKey,
  zeroBuffer,
  type ScryptParams,
} from "./primitives.js";

// ── Key Manager ──────────────────────────────────────────────
// Manages master key lifecycle: derivation from passphrase or keyfile,
// sub-key derivation via HKDF, and key zeroization on shutdown.

export interface CryptoConfig {
  version: number;
  mode: "passphrase" | "keyfile";
  scrypt?: {
    salt: string;     // base64-encoded
    N: number;
    r: number;
    p: number;
    keyLength: number;
  };
  verifier: string;   // base64 — encrypted known string to verify passphrase
}

const VERIFIER_PLAINTEXT = "beercan-key-verification-v1";
const CONFIG_FILENAME = "crypto.json";
const KEYFILE_FILENAME = "master.key";
const MAX_LRU_SIZE = 200;

export class KeyManager {
  private masterKey: Buffer;
  private hkdfSalt: Buffer;
  private subKeyCache = new Map<string, { key: Buffer; accessedAt: number }>();
  private destroyed = false;

  private constructor(masterKey: Buffer, hkdfSalt: Buffer) {
    this.masterKey = masterKey;
    // Use a fixed HKDF salt derived from the master key for deterministic sub-key derivation
    this.hkdfSalt = hkdfSalt;
  }

  // ── Factory Methods ──────────────────────────────────────

  /**
   * Initialize from a passphrase. If crypto.json exists at configDir, uses stored salt.
   * Otherwise creates a new config with fresh salt.
   */
  static fromPassphrase(passphrase: string, configDir: string): KeyManager {
    const configPath = path.join(configDir, CONFIG_FILENAME);
    let config: CryptoConfig | null = null;

    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as CryptoConfig;
      if (config.mode !== "passphrase") {
        throw new Error(`crypto.json specifies mode "${config.mode}", but passphrase was provided`);
      }
    }

    let key: Buffer;
    if (config?.scrypt) {
      // Re-derive with stored params
      const salt = Buffer.from(config.scrypt.salt, "base64");
      const result = scryptDerive(passphrase, salt);
      key = result.key;

      // Verify the passphrase is correct
      if (!KeyManager.verifyKey(key, config.verifier)) {
        zeroBuffer(key);
        throw new Error("Invalid passphrase — key verification failed");
      }
    } else {
      // First-time setup: derive key and save config
      const result = scryptDerive(passphrase);
      key = result.key;

      const verifier = KeyManager.createVerifier(key);
      const newConfig: CryptoConfig = {
        version: 1,
        mode: "passphrase",
        scrypt: {
          salt: result.params.salt.toString("base64"),
          N: result.params.N,
          r: result.params.r,
          p: result.params.p,
          keyLength: result.params.keyLength,
        },
        verifier,
      };

      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), { mode: 0o600 });
    }

    const hkdfSalt = hkdfDerive(key, Buffer.alloc(0), "beercan-hkdf-salt", 32);
    return new KeyManager(key, hkdfSalt);
  }

  /**
   * Initialize from a keyfile. If the file doesn't exist, throws.
   */
  static fromKeyfile(keyfilePath: string): KeyManager {
    if (!fs.existsSync(keyfilePath)) {
      throw new Error(`Keyfile not found: ${keyfilePath}`);
    }

    const raw = fs.readFileSync(keyfilePath);
    if (raw.length !== 32) {
      throw new Error(`Keyfile must be exactly 32 bytes (256 bits), got ${raw.length}`);
    }

    const key = Buffer.from(raw);
    const hkdfSalt = hkdfDerive(key, Buffer.alloc(0), "beercan-hkdf-salt", 32);
    return new KeyManager(key, hkdfSalt);
  }

  /**
   * Generate a new keyfile at the given path.
   */
  static generateKeyfile(keyfilePath: string, configDir: string): void {
    const key = generateRandomKey();
    const dir = path.dirname(keyfilePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyfilePath, key, { mode: 0o600 });

    // Also write crypto.json in keyfile mode
    const verifier = KeyManager.createVerifier(key);
    const config: CryptoConfig = {
      version: 1,
      mode: "keyfile",
      verifier,
    };
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, CONFIG_FILENAME),
      JSON.stringify(config, null, 2),
      { mode: 0o600 },
    );

    zeroBuffer(key);
  }

  // ── Key Derivation ───────────────────────────────────────

  /**
   * Derive a sub-key for a given context string.
   * Uses LRU cache to avoid repeated HKDF calls.
   */
  deriveKey(context: string): Buffer {
    this.ensureNotDestroyed();

    const cached = this.subKeyCache.get(context);
    if (cached) {
      cached.accessedAt = Date.now();
      return cached.key;
    }

    const derived = hkdfDerive(this.masterKey, this.hkdfSalt, context);

    // Evict oldest entry if cache is full
    if (this.subKeyCache.size >= MAX_LRU_SIZE) {
      let oldestKey = "";
      let oldestTime = Infinity;
      for (const [k, v] of this.subKeyCache) {
        if (v.accessedAt < oldestTime) {
          oldestTime = v.accessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const evicted = this.subKeyCache.get(oldestKey);
        if (evicted) zeroBuffer(evicted.key);
        this.subKeyCache.delete(oldestKey);
      }
    }

    this.subKeyCache.set(context, { key: derived, accessedAt: Date.now() });
    return derived;
  }

  /** Derive a project-scoped key. */
  deriveProjectKey(projectId: string): Buffer {
    return this.deriveKey(`beercan-project-${projectId}`);
  }

  /** Derive a bloop-scoped key. */
  deriveBloopKey(projectId: string, bloopId: string): Buffer {
    return this.deriveKey(`beercan-bloop-${projectId}-${bloopId}`);
  }

  /** Derive a memory-scoped key. */
  deriveMemoryKey(projectId: string): Buffer {
    return this.deriveKey(`beercan-memory-${projectId}`);
  }

  /** Derive the global key (for cross-project data like job queue). */
  deriveGlobalKey(): Buffer {
    return this.deriveKey("beercan-global");
  }

  // ── Lifecycle ────────────────────────────────────────────

  /**
   * Securely destroy all key material. Call on shutdown.
   * After calling, all encrypt/decrypt operations will throw.
   */
  destroy(): void {
    if (this.destroyed) return;

    zeroBuffer(this.masterKey);
    zeroBuffer(this.hkdfSalt);

    for (const [, entry] of this.subKeyCache) {
      zeroBuffer(entry.key);
    }
    this.subKeyCache.clear();
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  // ── Internal ─────────────────────────────────────────────

  private ensureNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("KeyManager has been destroyed — cannot derive keys");
    }
  }

  /**
   * Create a verifier string by encrypting a known plaintext with the key.
   * Used to check if a passphrase is correct without storing the key.
   */
  private static createVerifier(key: Buffer): string {
    const result = aesGcmEncrypt(key, Buffer.from(VERIFIER_PLAINTEXT, "utf-8"));
    return packAesGcm(result).toString("base64");
  }

  /**
   * Verify that a key can decrypt the stored verifier.
   */
  private static verifyKey(key: Buffer, verifierBase64: string): boolean {
    try {
      const packed = Buffer.from(verifierBase64, "base64");
      const { iv, ciphertext, tag } = unpackAesGcm(packed);
      const plaintext = aesGcmDecrypt(key, iv, ciphertext, tag);
      return plaintext.toString("utf-8") === VERIFIER_PLAINTEXT;
    } catch {
      return false;
    }
  }
}
