import crypto from "node:crypto";

// ── AES-256-GCM Authenticated Encryption ─────────────────────
// Standard NIST-approved AEAD cipher. 12-byte IV (recommended for GCM),
// 16-byte auth tag. Hardware-accelerated via AES-NI on modern CPUs.

const AES_KEY_BYTES = 32;   // 256 bits
const IV_BYTES = 12;        // 96 bits (GCM standard)
const TAG_BYTES = 16;       // 128 bits

export interface AesGcmResult {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns { iv, ciphertext, tag } — all three are needed for decryption.
 * Optional AAD (Additional Authenticated Data) is integrity-checked but not encrypted.
 */
export function aesGcmEncrypt(
  key: Buffer,
  plaintext: Buffer,
  aad?: Buffer,
): AesGcmResult {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES-256-GCM requires a ${AES_KEY_BYTES}-byte key, got ${key.length}`);
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return { iv, ciphertext: encrypted, tag };
}

/**
 * Decrypt ciphertext with AES-256-GCM.
 * Verifies the auth tag — throws on tampered data.
 */
export function aesGcmDecrypt(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad?: Buffer,
): Buffer {
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(`AES-256-GCM requires a ${AES_KEY_BYTES}-byte key, got ${key.length}`);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aad);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── HKDF Key Derivation ──────────────────────────────────────
// RFC 5869. Derives sub-keys from a master key with domain separation.

/**
 * Derive a sub-key using HKDF-SHA256.
 * @param ikm  Input key material (master key)
 * @param salt Random salt (can be empty Buffer for unsalted)
 * @param info Context string for domain separation (e.g. "beercan-project-<id>")
 * @param length Output key length in bytes (default 32 for AES-256)
 */
export function hkdfDerive(
  ikm: Buffer,
  salt: Buffer,
  info: string,
  length: number = AES_KEY_BYTES,
): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

// ── scrypt Key Derivation from Passphrase ────────────────────
// Derives a master key from a user passphrase. Memory-hard to resist GPU attacks.

export interface ScryptParams {
  salt: Buffer;
  N: number;      // CPU/memory cost (must be power of 2)
  r: number;      // block size
  p: number;      // parallelism
  keyLength: number;
}

const DEFAULT_SCRYPT_PARAMS: Omit<ScryptParams, "salt"> = {
  N: 2 ** 14,     // 16384 — ~16MB memory, reasonable for CLI tool
  r: 8,
  p: 1,
  keyLength: AES_KEY_BYTES,
};

/**
 * Derive a key from a passphrase using scrypt.
 * Returns the derived key and the params used (including generated salt).
 */
export function scryptDerive(
  passphrase: string,
  existingSalt?: Buffer,
): { key: Buffer; params: ScryptParams } {
  const salt = existingSalt ?? crypto.randomBytes(32);
  const params: ScryptParams = { ...DEFAULT_SCRYPT_PARAMS, salt };

  const key = crypto.scryptSync(passphrase, salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
  });

  return { key, params };
}

// ── Utilities ────────────────────────────────────────────────

/** Generate a cryptographically random key (256-bit). */
export function generateRandomKey(): Buffer {
  return crypto.randomBytes(AES_KEY_BYTES);
}

/** Securely zero a buffer's contents. */
export function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

/**
 * Pack IV + ciphertext + tag into a single buffer.
 * Layout: [12 iv][N ciphertext][16 tag]
 */
export function packAesGcm(result: AesGcmResult): Buffer {
  return Buffer.concat([result.iv, result.ciphertext, result.tag]);
}

/**
 * Unpack a packed AES-GCM buffer into { iv, ciphertext, tag }.
 */
export function unpackAesGcm(packed: Buffer): AesGcmResult {
  if (packed.length < IV_BYTES + TAG_BYTES) {
    throw new Error(`Packed AES-GCM data too short: ${packed.length} bytes`);
  }
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(packed.length - TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);
  return { iv, ciphertext, tag };
}
