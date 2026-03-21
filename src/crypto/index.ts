import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  packAesGcm,
  unpackAesGcm,
  zeroBuffer,
} from "./primitives.js";
import { KeyManager } from "./key-manager.js";

// ── Encryption Scope ─────────────────────────────────────────
// Determines which derived key is used for encryption/decryption.

export type EncryptionScope =
  | { type: "global" }
  | { type: "project"; projectId: string }
  | { type: "bloop"; projectId: string; bloopId: string }
  | { type: "memory"; projectId: string };

// ── Encrypted Value Format ───────────────────────────────────
// Encrypted values are stored as: "enc:v1:<base64(iv + ciphertext + tag)>"
// The prefix allows detection of encrypted vs plaintext data.

const ENC_PREFIX = "enc:v1:";

// ── CryptoManager ────────────────────────────────────────────
// High-level facade for all encryption operations in BeerCan.
// Thread-safe (single-threaded Node.js), handles key derivation
// and provides encrypt/decrypt with scope-based key selection.

export class CryptoManager {
  private keyManager: KeyManager | null;

  private constructor(keyManager: KeyManager | null) {
    this.keyManager = keyManager;
  }

  // ── Factory Methods ──────────────────────────────────────

  /** Create a CryptoManager from a passphrase. */
  static fromPassphrase(passphrase: string, configDir: string): CryptoManager {
    const km = KeyManager.fromPassphrase(passphrase, configDir);
    return new CryptoManager(km);
  }

  /** Create a CryptoManager from a keyfile. */
  static fromKeyfile(keyfilePath: string): CryptoManager {
    const km = KeyManager.fromKeyfile(keyfilePath);
    return new CryptoManager(km);
  }

  /** Create a disabled CryptoManager (no-op passthrough). */
  static disabled(): CryptoManager {
    return new CryptoManager(null);
  }

  // ── Status ───────────────────────────────────────────────

  /** Returns true if encryption is active. */
  isEnabled(): boolean {
    return this.keyManager !== null && !this.keyManager.isDestroyed();
  }

  // ── Encrypt / Decrypt ────────────────────────────────────

  /**
   * Encrypt a plaintext string with scope-based key derivation.
   * Returns an "enc:v1:<base64>" formatted string.
   * If encryption is disabled, returns the plaintext unchanged.
   */
  encrypt(plaintext: string, scope: EncryptionScope): string {
    if (!this.isEnabled()) return plaintext;

    const key = this.resolveKey(scope);
    const result = aesGcmEncrypt(key, Buffer.from(plaintext, "utf-8"));
    const packed = packAesGcm(result);
    return ENC_PREFIX + packed.toString("base64");
  }

  /**
   * Decrypt an "enc:v1:<base64>" string back to plaintext.
   * Throws if the data is tampered or the wrong key is used.
   * If encryption is disabled, returns the input unchanged.
   */
  decrypt(ciphertext: string, scope: EncryptionScope): string {
    if (!this.isEnabled()) return ciphertext;

    if (!ciphertext.startsWith(ENC_PREFIX)) {
      throw new Error("Cannot decrypt: value is not in encrypted format");
    }

    const packed = Buffer.from(ciphertext.slice(ENC_PREFIX.length), "base64");
    const { iv, ciphertext: ct, tag } = unpackAesGcm(packed);
    const key = this.resolveKey(scope);
    const plaintext = aesGcmDecrypt(key, iv, ct, tag);
    return plaintext.toString("utf-8");
  }

  /**
   * Decrypt if encrypted, return as-is if plaintext.
   * Use during migration period when data may be mixed.
   */
  maybeDecrypt(value: string | null | undefined, scope: EncryptionScope): string | null | undefined {
    if (value == null) return value;
    if (!this.isEnabled()) return value;
    if (!isEncrypted(value)) return value;
    return this.decrypt(value, scope);
  }

  /**
   * Encrypt a JSON-serializable value.
   * Serializes to JSON string, then encrypts.
   */
  encryptJSON(obj: unknown, scope: EncryptionScope): string {
    return this.encrypt(JSON.stringify(obj), scope);
  }

  /**
   * Decrypt a value and parse as JSON.
   */
  decryptJSON(ciphertext: string, scope: EncryptionScope): unknown {
    const plaintext = this.decrypt(ciphertext, scope);
    return JSON.parse(plaintext);
  }

  /**
   * Conditionally decrypt a JSON field. If the value is already plaintext JSON, parse directly.
   */
  maybeDecryptJSON(value: string | null | undefined, scope: EncryptionScope): unknown {
    if (value == null) return value;
    if (!this.isEnabled() || !isEncrypted(value)) {
      return JSON.parse(value);
    }
    return this.decryptJSON(value, scope);
  }

  // ── Lifecycle ────────────────────────────────────────────

  /**
   * Securely destroy all key material. Call on shutdown.
   * After calling, encrypt/decrypt will act as disabled (passthrough).
   */
  destroy(): void {
    if (this.keyManager) {
      this.keyManager.destroy();
    }
  }

  // ── Internal ─────────────────────────────────────────────

  private resolveKey(scope: EncryptionScope): Buffer {
    if (!this.keyManager) {
      throw new Error("CryptoManager is disabled — cannot resolve key");
    }

    switch (scope.type) {
      case "global":
        return this.keyManager.deriveGlobalKey();
      case "project":
        return this.keyManager.deriveProjectKey(scope.projectId);
      case "bloop":
        return this.keyManager.deriveBloopKey(scope.projectId, scope.bloopId);
      case "memory":
        return this.keyManager.deriveMemoryKey(scope.projectId);
      default:
        throw new Error(`Unknown encryption scope type: ${(scope as any).type}`);
    }
  }
}

// ── Utility ──────────────────────────────────────────────────

/** Check if a value is in encrypted format. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

// Re-export key types for consumers
export { KeyManager } from "./key-manager.js";
export { generateRandomKey, zeroBuffer } from "./primitives.js";
