import type { Database as DatabaseType } from "better-sqlite3";
import { CryptoManager, isEncrypted, type EncryptionScope } from "./index.js";

// ── Database Encryption Migration ────────────────────────────
// Encrypts/decrypts sensitive fields in an existing BeerCan database.
// Idempotent — checks enc:v1: prefix before encrypting, skips already-handled fields.

interface FieldSpec {
  table: string;
  idColumn: string;
  fields: string[];
  scopeType: "project" | "global" | "memory";
  /** Column name that holds the project_id (for project/memory scopes). */
  projectIdColumn?: string;
}

const FIELD_SPECS: FieldSpec[] = [
  {
    table: "loops",
    idColumn: "id",
    fields: ["goal", "system_prompt", "messages", "result", "tool_calls"],
    scopeType: "project",
    projectIdColumn: "project_id",
  },
  {
    table: "projects",
    idColumn: "id",
    fields: ["context"],
    scopeType: "project",
    projectIdColumn: "id", // project's own ID
  },
  {
    table: "memory_entries",
    idColumn: "id",
    fields: ["title", "content"],
    scopeType: "memory",
    projectIdColumn: "project_id",
  },
  {
    table: "kg_entities",
    idColumn: "id",
    fields: ["description", "properties"],
    scopeType: "project",
    projectIdColumn: "project_id",
  },
  {
    table: "kg_edges",
    idColumn: "id",
    fields: ["properties"],
    scopeType: "project",
    projectIdColumn: "project_id",
  },
  {
    table: "working_memory",
    idColumn: "rowid",
    fields: ["value"],
    scopeType: "global",
  },
  {
    table: "job_queue",
    idColumn: "id",
    fields: ["goal", "extra_context"],
    scopeType: "global",
  },
  {
    table: "schedules",
    idColumn: "id",
    fields: ["goal"],
    scopeType: "project",
    projectIdColumn: "project_id",
  },
  {
    table: "triggers",
    idColumn: "id",
    fields: ["goal_template", "filter_data"],
    scopeType: "project",
    projectIdColumn: "project_id",
  },
  {
    table: "events_log",
    idColumn: "id",
    fields: ["event_data"],
    scopeType: "project",
    projectIdColumn: "project_id",
  },
];

export interface MigrationResult {
  tablesProcessed: number;
  rowsEncrypted: number;
  rowsSkipped: number;
}

/**
 * Encrypt all sensitive fields in an existing unencrypted database.
 * Idempotent — already-encrypted fields are skipped.
 */
export function encryptDatabase(db: DatabaseType, crypto: CryptoManager): MigrationResult {
  let tablesProcessed = 0;
  let rowsEncrypted = 0;
  let rowsSkipped = 0;

  for (const spec of FIELD_SPECS) {
    tablesProcessed++;
    const selectCols = [spec.idColumn, ...spec.fields];
    if (spec.projectIdColumn && !selectCols.includes(spec.projectIdColumn)) {
      selectCols.push(spec.projectIdColumn);
    }

    const rows = db.prepare(
      `SELECT ${selectCols.join(", ")} FROM ${spec.table}`
    ).all() as any[];

    for (const row of rows) {
      let needsUpdate = false;
      const updates: Record<string, string> = {};

      for (const field of spec.fields) {
        const value = row[field];
        if (value == null) continue;
        if (isEncrypted(value)) continue; // already encrypted

        const scope = resolveScope(spec, row);
        updates[field] = crypto.encrypt(value, scope);
        needsUpdate = true;
      }

      if (needsUpdate) {
        const setParts = Object.keys(updates).map((f) => `${f} = ?`);
        const params = [...Object.values(updates), row[spec.idColumn]];
        db.prepare(
          `UPDATE ${spec.table} SET ${setParts.join(", ")} WHERE ${spec.idColumn} = ?`
        ).run(...params);
        rowsEncrypted++;
      } else {
        rowsSkipped++;
      }
    }
  }

  // Mark as encrypted in _crypto_state
  db.prepare(
    `INSERT OR REPLACE INTO _crypto_state (key, value) VALUES ('encrypted_at', ?)`
  ).run(new Date().toISOString());

  return { tablesProcessed, rowsEncrypted, rowsSkipped };
}

/**
 * Decrypt all encrypted fields back to plaintext.
 * Use for database export/backup.
 */
export function decryptDatabase(db: DatabaseType, crypto: CryptoManager): MigrationResult {
  let tablesProcessed = 0;
  let rowsEncrypted = 0; // renamed: rows decrypted
  let rowsSkipped = 0;

  for (const spec of FIELD_SPECS) {
    tablesProcessed++;
    const selectCols = [spec.idColumn, ...spec.fields];
    if (spec.projectIdColumn && !selectCols.includes(spec.projectIdColumn)) {
      selectCols.push(spec.projectIdColumn);
    }

    const rows = db.prepare(
      `SELECT ${selectCols.join(", ")} FROM ${spec.table}`
    ).all() as any[];

    for (const row of rows) {
      let needsUpdate = false;
      const updates: Record<string, string> = {};

      for (const field of spec.fields) {
        const value = row[field];
        if (value == null) continue;
        if (!isEncrypted(value)) continue; // already plaintext

        const scope = resolveScope(spec, row);
        updates[field] = crypto.decrypt(value, scope);
        needsUpdate = true;
      }

      if (needsUpdate) {
        const setParts = Object.keys(updates).map((f) => `${f} = ?`);
        const params = [...Object.values(updates), row[spec.idColumn]];
        db.prepare(
          `UPDATE ${spec.table} SET ${setParts.join(", ")} WHERE ${spec.idColumn} = ?`
        ).run(...params);
        rowsEncrypted++;
      } else {
        rowsSkipped++;
      }
    }
  }

  // Remove encryption marker
  db.prepare(`DELETE FROM _crypto_state WHERE key = 'encrypted_at'`).run();

  return { tablesProcessed, rowsEncrypted, rowsSkipped };
}

/**
 * Re-encrypt database with a new key (key rotation).
 * Decrypts with old crypto, re-encrypts with new crypto.
 */
export function rekeyDatabase(
  db: DatabaseType,
  oldCrypto: CryptoManager,
  newCrypto: CryptoManager,
): MigrationResult {
  // Step 1: decrypt with old key
  const decResult = decryptDatabase(db, oldCrypto);
  // Step 2: encrypt with new key
  const encResult = encryptDatabase(db, newCrypto);
  return {
    tablesProcessed: encResult.tablesProcessed,
    rowsEncrypted: encResult.rowsEncrypted,
    rowsSkipped: encResult.rowsSkipped,
  };
}

function resolveScope(spec: FieldSpec, row: any): EncryptionScope {
  switch (spec.scopeType) {
    case "global":
      return { type: "global" };
    case "project":
      return { type: "project", projectId: row[spec.projectIdColumn!] };
    case "memory":
      return { type: "memory", projectId: row[spec.projectIdColumn!] };
  }
}
