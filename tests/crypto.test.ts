import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { Logger } from "../src/core/logger.js";
import { BeerCanDB } from "../src/storage/database.js";
import { encryptDatabase, decryptDatabase, rekeyDatabase } from "../src/crypto/migration.js";
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  packAesGcm,
  unpackAesGcm,
  hkdfDerive,
  scryptDerive,
  generateRandomKey,
  zeroBuffer,
} from "../src/crypto/primitives.js";
import { KeyManager } from "../src/crypto/key-manager.js";
import { CryptoManager, isEncrypted } from "../src/crypto/index.js";

// ── Helpers ──────────────────────────────────────────────────

function tmpDir(): string {
  const dir = `/tmp/beercan-crypto-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Primitives ───────────────────────────────────────────────

describe("AES-256-GCM", () => {
  const key = generateRandomKey();

  it("encrypts and decrypts a string roundtrip", () => {
    const plaintext = Buffer.from("Hello, BeerCan!", "utf-8");
    const { iv, ciphertext, tag } = aesGcmEncrypt(key, plaintext);
    const decrypted = aesGcmDecrypt(key, iv, ciphertext, tag);
    expect(decrypted.toString("utf-8")).toBe("Hello, BeerCan!");
  });

  it("produces different ciphertext for same plaintext (random IV)", () => {
    const plaintext = Buffer.from("same input", "utf-8");
    const r1 = aesGcmEncrypt(key, plaintext);
    const r2 = aesGcmEncrypt(key, plaintext);
    expect(r1.ciphertext.equals(r2.ciphertext)).toBe(false);
    expect(r1.iv.equals(r2.iv)).toBe(false);
  });

  it("rejects wrong key", () => {
    const plaintext = Buffer.from("secret", "utf-8");
    const { iv, ciphertext, tag } = aesGcmEncrypt(key, plaintext);
    const wrongKey = generateRandomKey();
    expect(() => aesGcmDecrypt(wrongKey, iv, ciphertext, tag)).toThrow();
  });

  it("detects tampered ciphertext", () => {
    const plaintext = Buffer.from("integrity check", "utf-8");
    const { iv, ciphertext, tag } = aesGcmEncrypt(key, plaintext);
    ciphertext[0] ^= 0xff; // flip a bit
    expect(() => aesGcmDecrypt(key, iv, ciphertext, tag)).toThrow();
  });

  it("detects tampered auth tag", () => {
    const plaintext = Buffer.from("integrity check", "utf-8");
    const { iv, ciphertext, tag } = aesGcmEncrypt(key, plaintext);
    tag[0] ^= 0xff;
    expect(() => aesGcmDecrypt(key, iv, ciphertext, tag)).toThrow();
  });

  it("supports AAD (additional authenticated data)", () => {
    const plaintext = Buffer.from("with context", "utf-8");
    const aad = Buffer.from("project-123", "utf-8");
    const { iv, ciphertext, tag } = aesGcmEncrypt(key, plaintext, aad);

    // Correct AAD
    const decrypted = aesGcmDecrypt(key, iv, ciphertext, tag, aad);
    expect(decrypted.toString("utf-8")).toBe("with context");

    // Wrong AAD
    const wrongAad = Buffer.from("project-456", "utf-8");
    expect(() => aesGcmDecrypt(key, iv, ciphertext, tag, wrongAad)).toThrow();
  });

  it("rejects invalid key length", () => {
    const shortKey = Buffer.alloc(16);
    const plaintext = Buffer.from("test", "utf-8");
    expect(() => aesGcmEncrypt(shortKey, plaintext)).toThrow(/32-byte key/);
  });

  it("handles empty plaintext", () => {
    const plaintext = Buffer.alloc(0);
    const { iv, ciphertext, tag } = aesGcmEncrypt(key, plaintext);
    const decrypted = aesGcmDecrypt(key, iv, ciphertext, tag);
    expect(decrypted.length).toBe(0);
  });

  it("handles large plaintext", () => {
    const plaintext = Buffer.alloc(1024 * 1024, 0x42); // 1MB
    const { iv, ciphertext, tag } = aesGcmEncrypt(key, plaintext);
    const decrypted = aesGcmDecrypt(key, iv, ciphertext, tag);
    expect(decrypted.equals(plaintext)).toBe(true);
  });
});

describe("pack/unpack AES-GCM", () => {
  it("packs and unpacks correctly", () => {
    const key = generateRandomKey();
    const original = aesGcmEncrypt(key, Buffer.from("pack test", "utf-8"));
    const packed = packAesGcm(original);
    const unpacked = unpackAesGcm(packed);

    expect(unpacked.iv.equals(original.iv)).toBe(true);
    expect(unpacked.ciphertext.equals(original.ciphertext)).toBe(true);
    expect(unpacked.tag.equals(original.tag)).toBe(true);
  });

  it("rejects too-short packed data", () => {
    expect(() => unpackAesGcm(Buffer.alloc(10))).toThrow(/too short/);
  });
});

// ── HKDF ─────────────────────────────────────────────────────

describe("HKDF key derivation", () => {
  const ikm = generateRandomKey();
  const salt = Buffer.alloc(32);

  it("derives deterministic keys for same inputs", () => {
    const k1 = hkdfDerive(ikm, salt, "same-context");
    const k2 = hkdfDerive(ikm, salt, "same-context");
    expect(k1.equals(k2)).toBe(true);
  });

  it("derives different keys for different contexts", () => {
    const k1 = hkdfDerive(ikm, salt, "context-a");
    const k2 = hkdfDerive(ikm, salt, "context-b");
    expect(k1.equals(k2)).toBe(false);
  });

  it("derives different keys for different salts", () => {
    const salt2 = Buffer.alloc(32, 1);
    const k1 = hkdfDerive(ikm, salt, "same");
    const k2 = hkdfDerive(ikm, salt2, "same");
    expect(k1.equals(k2)).toBe(false);
  });

  it("derives different keys for different IKM", () => {
    const ikm2 = generateRandomKey();
    const k1 = hkdfDerive(ikm, salt, "same");
    const k2 = hkdfDerive(ikm2, salt, "same");
    expect(k1.equals(k2)).toBe(false);
  });

  it("supports custom output length", () => {
    const k16 = hkdfDerive(ikm, salt, "short", 16);
    const k64 = hkdfDerive(ikm, salt, "long", 64);
    expect(k16.length).toBe(16);
    expect(k64.length).toBe(64);
  });
});

// ── scrypt ───────────────────────────────────────────────────

describe("scrypt key derivation", () => {
  it("derives a 32-byte key from passphrase", () => {
    const { key, params } = scryptDerive("test-passphrase");
    expect(key.length).toBe(32);
    expect(params.salt.length).toBe(32);
  });

  it("produces same key with same passphrase and salt", () => {
    const { key: k1, params } = scryptDerive("deterministic");
    const { key: k2 } = scryptDerive("deterministic", params.salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it("produces different keys for different passphrases", () => {
    const salt = Buffer.alloc(32, 0x42);
    const { key: k1 } = scryptDerive("password-a", salt);
    const { key: k2 } = scryptDerive("password-b", salt);
    expect(k1.equals(k2)).toBe(false);
  });
});

// ── Utility ──────────────────────────────────────────────────

describe("zeroBuffer", () => {
  it("fills buffer with zeros", () => {
    const buf = Buffer.from("sensitive data", "utf-8");
    zeroBuffer(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });
});

describe("generateRandomKey", () => {
  it("generates a 32-byte key", () => {
    const key = generateRandomKey();
    expect(key.length).toBe(32);
  });

  it("generates unique keys", () => {
    const k1 = generateRandomKey();
    const k2 = generateRandomKey();
    expect(k1.equals(k2)).toBe(false);
  });
});

// ── KeyManager ───────────────────────────────────────────────

describe("KeyManager", () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { cleanup(dir); });

  describe("passphrase mode", () => {
    it("creates config on first use and reuses on second", () => {
      const km1 = KeyManager.fromPassphrase("my-secret", dir);
      expect(fs.existsSync(path.join(dir, "crypto.json"))).toBe(true);

      const km2 = KeyManager.fromPassphrase("my-secret", dir);
      // Both should derive the same keys
      const k1 = km1.deriveGlobalKey();
      const k2 = km2.deriveGlobalKey();
      expect(k1.equals(k2)).toBe(true);

      km1.destroy();
      km2.destroy();
    });

    it("rejects wrong passphrase", () => {
      const km = KeyManager.fromPassphrase("correct-horse", dir);
      km.destroy();

      expect(() => KeyManager.fromPassphrase("wrong-horse", dir)).toThrow(/verification failed/);
    });

    it("config file has restrictive permissions", () => {
      KeyManager.fromPassphrase("perm-test", dir).destroy();
      const stats = fs.statSync(path.join(dir, "crypto.json"));
      // 0o600 = owner read/write only
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe("keyfile mode", () => {
    it("reads a 32-byte keyfile", () => {
      const keyfilePath = path.join(dir, "master.key");
      KeyManager.generateKeyfile(keyfilePath, dir);

      const km = KeyManager.fromKeyfile(keyfilePath);
      const key = km.deriveGlobalKey();
      expect(key.length).toBe(32);
      km.destroy();
    });

    it("rejects missing keyfile", () => {
      expect(() => KeyManager.fromKeyfile("/nonexistent/master.key")).toThrow(/not found/);
    });

    it("rejects wrong-size keyfile", () => {
      const keyfilePath = path.join(dir, "bad.key");
      fs.writeFileSync(keyfilePath, Buffer.alloc(16));
      expect(() => KeyManager.fromKeyfile(keyfilePath)).toThrow(/32 bytes/);
    });
  });

  describe("key derivation", () => {
    it("derives different keys for different scopes", () => {
      const km = KeyManager.fromPassphrase("scope-test", dir);

      const global = km.deriveGlobalKey();
      const project = km.deriveProjectKey("proj-1");
      const bloop = km.deriveBloopKey("proj-1", "bloop-1");
      const memory = km.deriveMemoryKey("proj-1");

      // All different
      expect(global.equals(project)).toBe(false);
      expect(project.equals(bloop)).toBe(false);
      expect(bloop.equals(memory)).toBe(false);
      expect(global.equals(memory)).toBe(false);

      km.destroy();
    });

    it("derives different project keys for different projects", () => {
      const km = KeyManager.fromPassphrase("isolation-test", dir);
      const k1 = km.deriveProjectKey("project-a");
      const k2 = km.deriveProjectKey("project-b");
      expect(k1.equals(k2)).toBe(false);
      km.destroy();
    });

    it("caches derived keys (LRU)", () => {
      const km = KeyManager.fromPassphrase("cache-test", dir);
      const k1 = km.deriveProjectKey("cached");
      const k2 = km.deriveProjectKey("cached");
      // Same buffer reference from cache
      expect(k1).toBe(k2);
      km.destroy();
    });
  });

  describe("destroy", () => {
    it("throws on key derivation after destroy", () => {
      const km = KeyManager.fromPassphrase("destroy-test", dir);
      km.destroy();
      expect(() => km.deriveGlobalKey()).toThrow(/destroyed/);
    });

    it("is idempotent", () => {
      const km = KeyManager.fromPassphrase("idempotent", dir);
      km.destroy();
      km.destroy(); // should not throw
      expect(km.isDestroyed()).toBe(true);
    });
  });
});

// ── CryptoManager ────────────────────────────────────────────

describe("CryptoManager", () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { cleanup(dir); });

  describe("disabled mode", () => {
    const cm = CryptoManager.disabled();

    it("reports not enabled", () => {
      expect(cm.isEnabled()).toBe(false);
    });

    it("passes through plaintext on encrypt", () => {
      const result = cm.encrypt("hello", { type: "global" });
      expect(result).toBe("hello");
    });

    it("passes through plaintext on decrypt", () => {
      const result = cm.decrypt("hello", { type: "global" });
      expect(result).toBe("hello");
    });

    it("passes through null on maybeDecrypt", () => {
      expect(cm.maybeDecrypt(null, { type: "global" })).toBe(null);
      expect(cm.maybeDecrypt(undefined, { type: "global" })).toBe(undefined);
    });

    it("passes through plaintext on maybeDecrypt", () => {
      expect(cm.maybeDecrypt("plain", { type: "global" })).toBe("plain");
    });
  });

  describe("enabled mode", () => {
    let cm: CryptoManager;

    beforeEach(() => {
      cm = CryptoManager.fromPassphrase("test-pass", dir);
    });
    afterEach(() => {
      cm.destroy();
    });

    it("reports enabled", () => {
      expect(cm.isEnabled()).toBe(true);
    });

    it("encrypt/decrypt roundtrip", () => {
      const scope = { type: "global" as const };
      const encrypted = cm.encrypt("secret data", scope);
      expect(encrypted.startsWith("enc:v1:")).toBe(true);
      expect(encrypted).not.toContain("secret data");

      const decrypted = cm.decrypt(encrypted, scope);
      expect(decrypted).toBe("secret data");
    });

    it("encrypt/decrypt with project scope", () => {
      const scope = { type: "project" as const, projectId: "p1" };
      const encrypted = cm.encrypt("project secret", scope);
      const decrypted = cm.decrypt(encrypted, scope);
      expect(decrypted).toBe("project secret");
    });

    it("encrypt/decrypt with bloop scope", () => {
      const scope = { type: "bloop" as const, projectId: "p1", bloopId: "b1" };
      const encrypted = cm.encrypt("bloop secret", scope);
      const decrypted = cm.decrypt(encrypted, scope);
      expect(decrypted).toBe("bloop secret");
    });

    it("encrypt/decrypt with memory scope", () => {
      const scope = { type: "memory" as const, projectId: "p1" };
      const encrypted = cm.encrypt("memory content", scope);
      const decrypted = cm.decrypt(encrypted, scope);
      expect(decrypted).toBe("memory content");
    });

    it("different scopes produce different ciphertext", () => {
      const text = "same text";
      const e1 = cm.encrypt(text, { type: "global" });
      const e2 = cm.encrypt(text, { type: "project", projectId: "p1" });
      expect(e1).not.toBe(e2);
    });

    it("cannot decrypt with wrong scope", () => {
      const encrypted = cm.encrypt("scope-bound", { type: "project", projectId: "p1" });
      expect(() => cm.decrypt(encrypted, { type: "project", projectId: "p2" })).toThrow();
    });

    it("maybeDecrypt handles plaintext", () => {
      const result = cm.maybeDecrypt("not encrypted", { type: "global" });
      expect(result).toBe("not encrypted");
    });

    it("maybeDecrypt handles encrypted", () => {
      const scope = { type: "global" as const };
      const encrypted = cm.encrypt("was encrypted", scope);
      const result = cm.maybeDecrypt(encrypted, scope);
      expect(result).toBe("was encrypted");
    });

    it("maybeDecrypt handles null/undefined", () => {
      expect(cm.maybeDecrypt(null, { type: "global" })).toBe(null);
      expect(cm.maybeDecrypt(undefined, { type: "global" })).toBe(undefined);
    });

    it("encryptJSON/decryptJSON roundtrip", () => {
      const obj = { foo: "bar", count: 42, nested: { arr: [1, 2, 3] } };
      const scope = { type: "global" as const };
      const encrypted = cm.encryptJSON(obj, scope);
      expect(encrypted.startsWith("enc:v1:")).toBe(true);

      const decrypted = cm.decryptJSON(encrypted, scope);
      expect(decrypted).toEqual(obj);
    });

    it("maybeDecryptJSON handles plaintext JSON", () => {
      const json = JSON.stringify({ plain: true });
      const result = cm.maybeDecryptJSON(json, { type: "global" });
      expect(result).toEqual({ plain: true });
    });

    it("maybeDecryptJSON handles encrypted JSON", () => {
      const scope = { type: "global" as const };
      const encrypted = cm.encryptJSON({ encrypted: true }, scope);
      const result = cm.maybeDecryptJSON(encrypted, scope);
      expect(result).toEqual({ encrypted: true });
    });

    it("handles unicode text", () => {
      const scope = { type: "global" as const };
      const text = "Привет мир! 🍺 日本語テスト";
      const encrypted = cm.encrypt(text, scope);
      const decrypted = cm.decrypt(encrypted, scope);
      expect(decrypted).toBe(text);
    });

    it("handles empty string", () => {
      const scope = { type: "global" as const };
      const encrypted = cm.encrypt("", scope);
      const decrypted = cm.decrypt(encrypted, scope);
      expect(decrypted).toBe("");
    });

    it("handles large strings", () => {
      const scope = { type: "global" as const };
      const text = "x".repeat(100_000);
      const encrypted = cm.encrypt(text, scope);
      const decrypted = cm.decrypt(encrypted, scope);
      expect(decrypted).toBe(text);
    });
  });

  describe("decrypt rejects non-encrypted input", () => {
    it("throws for plaintext", () => {
      const cm = CryptoManager.fromPassphrase("test", dir);
      expect(() => cm.decrypt("not encrypted", { type: "global" })).toThrow(/not in encrypted format/);
      cm.destroy();
    });
  });

  describe("destroy", () => {
    it("disables encryption after destroy", () => {
      const cm = CryptoManager.fromPassphrase("destroy-test", dir);
      expect(cm.isEnabled()).toBe(true);
      cm.destroy();
      expect(cm.isEnabled()).toBe(false);
    });

    it("passes through after destroy (like disabled)", () => {
      const cm = CryptoManager.fromPassphrase("destroy-test", dir);
      cm.destroy();
      expect(cm.encrypt("test", { type: "global" })).toBe("test");
    });
  });

  describe("cross-instance consistency", () => {
    it("two managers with same passphrase decrypt each other's data", () => {
      const cm1 = CryptoManager.fromPassphrase("shared-pass", dir);
      const scope = { type: "global" as const };
      const encrypted = cm1.encrypt("cross-instance", scope);
      cm1.destroy();

      const cm2 = CryptoManager.fromPassphrase("shared-pass", dir);
      const decrypted = cm2.decrypt(encrypted, scope);
      expect(decrypted).toBe("cross-instance");
      cm2.destroy();
    });
  });
});

// ── isEncrypted ──────────────────────────────────────────────

describe("isEncrypted", () => {
  it("detects encrypted values", () => {
    expect(isEncrypted("enc:v1:abc123")).toBe(true);
  });

  it("rejects plaintext", () => {
    expect(isEncrypted("hello world")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("enc:v2:wrong-version")).toBe(false);
  });
});

// ── Log Sanitization ─────────────────────────────────────────

describe("Logger.sanitize", () => {
  it("redacts sensitive field names", () => {
    const data = {
      goal: "Secret mission",
      status: "running",
      messages: [{ role: "user", content: "hi" }],
      result: { answer: 42 },
      toolCalls: [{ name: "read_file" }],
    };
    const sanitized = Logger.sanitize(data);
    expect(sanitized.goal).toBe("[REDACTED]");
    expect(sanitized.status).toBe("running"); // not sensitive
    expect(sanitized.messages).toBe("[REDACTED]");
    expect(sanitized.result).toBe("[REDACTED]");
    expect(sanitized.toolCalls).toBe("[REDACTED]");
  });

  it("redacts nested sensitive fields", () => {
    const data = {
      bloop: {
        goal: "nested secret",
        id: "abc-123",
      },
    };
    const sanitized = Logger.sanitize(data) as any;
    expect(sanitized.bloop.goal).toBe("[REDACTED]");
    expect(sanitized.bloop.id).toBe("abc-123");
  });

  it("redacts API keys in strings", () => {
    const data = {
      config: "key=sk-ant-api03-abcdefghijklmnop",
      info: "token: xoxb-123456789-abcdef",
    };
    const sanitized = Logger.sanitize(data) as any;
    expect(sanitized.config).toContain("[REDACTED:key]");
    expect(sanitized.config).not.toContain("sk-ant");
    expect(sanitized.info).toContain("[REDACTED:key]");
    expect(sanitized.info).not.toContain("xoxb-");
  });

  it("handles empty and null-ish data", () => {
    expect(Logger.sanitize({})).toEqual({});
    expect(Logger.sanitize({ a: null })).toEqual({ a: null });
    expect(Logger.sanitize({ a: 42 })).toEqual({ a: 42 });
  });

  it("redacts Bearer tokens", () => {
    const result = Logger.sanitizeString("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(result).toContain("[REDACTED:key]");
  });

  it("preserves non-sensitive strings", () => {
    expect(Logger.sanitizeString("hello world")).toBe("hello world");
    expect(Logger.sanitizeString("")).toBe("");
  });
});

// ── Database Encryption Migration ────────────────────────────

describe("encryptDatabase / decryptDatabase", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tmpDir();
    dbPath = path.join(dir, "test.db");
  });
  afterEach(() => { cleanup(dir); });

  function seedDb(): BeerCanDB {
    const db = new BeerCanDB(dbPath); // no crypto — plaintext
    const projectId = uuid();
    db.createProject({
      id: projectId,
      name: "Test",
      slug: "test",
      context: { secret: "api-key-123" },
      allowedTools: ["*"],
      tokenBudget: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    db.createBloop({
      id: uuid(),
      projectId,
      parentBloopId: null,
      trigger: "manual",
      status: "completed",
      goal: "Test goal for encryption",
      messages: [{ role: "user", content: "hello", timestamp: new Date().toISOString() }],
      result: { answer: "done" },
      toolCalls: [],
      tokensUsed: 100,
      iterations: 1,
      maxIterations: 50,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    db.createMemoryEntry({
      id: uuid(),
      projectId,
      memoryType: "fact",
      title: "Important fact",
      content: "The secret is 42",
      sourceBloopId: null,
      supersededBy: null,
      confidence: 1.0,
      tags: ["test"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return db;
  }

  it("encrypts all sensitive fields in a plaintext database", () => {
    const db = seedDb();
    db.close();

    const crypto = CryptoManager.fromPassphrase("migration-test", dir);
    const rawDb = new Database(dbPath);
    const result = encryptDatabase(rawDb, crypto);

    expect(result.rowsEncrypted).toBeGreaterThan(0);

    // Verify raw SQL shows encrypted data
    const bloopRow = rawDb.prepare("SELECT goal FROM loops LIMIT 1").get() as any;
    expect(isEncrypted(bloopRow.goal)).toBe(true);

    const projectRow = rawDb.prepare("SELECT context FROM projects LIMIT 1").get() as any;
    expect(isEncrypted(projectRow.context)).toBe(true);

    const memRow = rawDb.prepare("SELECT title, content FROM memory_entries LIMIT 1").get() as any;
    expect(isEncrypted(memRow.title)).toBe(true);
    expect(isEncrypted(memRow.content)).toBe(true);

    rawDb.close();
    crypto.destroy();
  });

  it("is idempotent — second encrypt skips already-encrypted rows", () => {
    const db = seedDb();
    db.close();

    const crypto = CryptoManager.fromPassphrase("idempotent-test", dir);
    const rawDb = new Database(dbPath);

    const r1 = encryptDatabase(rawDb, crypto);
    expect(r1.rowsEncrypted).toBeGreaterThan(0);

    const r2 = encryptDatabase(rawDb, crypto);
    expect(r2.rowsEncrypted).toBe(0);
    expect(r2.rowsSkipped).toBe(r1.rowsEncrypted + r1.rowsSkipped);

    rawDb.close();
    crypto.destroy();
  });

  it("decrypt reverses encrypt", () => {
    const db = seedDb();
    db.close();

    const crypto = CryptoManager.fromPassphrase("roundtrip-test", dir);
    const rawDb = new Database(dbPath);

    // Read original plaintext
    const originalGoal = (rawDb.prepare("SELECT goal FROM loops LIMIT 1").get() as any).goal;

    // Encrypt
    encryptDatabase(rawDb, crypto);
    const encGoal = (rawDb.prepare("SELECT goal FROM loops LIMIT 1").get() as any).goal;
    expect(isEncrypted(encGoal)).toBe(true);

    // Decrypt
    decryptDatabase(rawDb, crypto);
    const decGoal = (rawDb.prepare("SELECT goal FROM loops LIMIT 1").get() as any).goal;
    expect(decGoal).toBe(originalGoal);

    rawDb.close();
    crypto.destroy();
  });

  it("encrypted DB can be read via BeerCanDB with crypto", () => {
    const db = seedDb();
    db.close();

    const crypto = CryptoManager.fromPassphrase("read-test", dir);
    const rawDb = new Database(dbPath);
    encryptDatabase(rawDb, crypto);
    rawDb.close();

    // Open with crypto-enabled BeerCanDB
    const encDb = new BeerCanDB(dbPath, crypto);
    const projects = encDb.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].context).toEqual({ secret: "api-key-123" });

    const bloops = encDb.getProjectBloops(projects[0].id);
    expect(bloops).toHaveLength(1);
    expect(bloops[0].goal).toBe("Test goal for encryption");

    encDb.close();
    crypto.destroy();
  });

  it("rekey changes encryption key", () => {
    const db = seedDb();
    db.close();

    const dir2 = tmpDir();
    const oldCrypto = CryptoManager.fromPassphrase("old-key", dir);
    const rawDb = new Database(dbPath);

    encryptDatabase(rawDb, oldCrypto);

    const newCrypto = CryptoManager.fromPassphrase("new-key", dir2);
    rekeyDatabase(rawDb, oldCrypto, newCrypto);

    rawDb.close();
    oldCrypto.destroy();

    // Old key can't read, new key can
    const encDb = new BeerCanDB(dbPath, newCrypto);
    const projects = encDb.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].context).toEqual({ secret: "api-key-123" });

    encDb.close();
    newCrypto.destroy();
    cleanup(dir2);
  });
});
