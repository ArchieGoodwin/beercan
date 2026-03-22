import Database, { type Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import path from "path";
import type { Bloop, Project } from "../schemas.js";
import type { Schedule } from "../scheduler/scheduler.js";
import type { Trigger } from "../events/trigger-manager.js";
import type { MemoryEntry, MemoryType, KGEntity, KGEdge } from "../memory/schemas.js";
import type { Job, JobStats } from "../core/job-queue.js";
import type { CryptoManager, EncryptionScope } from "../crypto/index.js";

// ── Database Manager ─────────────────────────────────────────
// Uses better-sqlite3 (native SQLite bindings) for performance,
// FTS5 support, and extension loading (sqlite-vec).
// Auto-persists to disk — no manual persist() calls needed.

export class BeerCanDB {
  private db: DatabaseType;
  private crypto: CryptoManager | null;

  constructor(dbPath: string, crypto?: CryptoManager) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.crypto = crypto ?? null;
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  // ── Encryption Helpers ─────────────────────────────────────

  /** Encrypt a string field. No-op if crypto is disabled or value is null. */
  private enc(value: string | null | undefined, scope: EncryptionScope): string | null | undefined {
    if (value == null || !this.crypto) return value;
    return this.crypto.encrypt(value, scope);
  }

  /** Encrypt a JSON field (stringify then encrypt). No-op if crypto is disabled. */
  private encJSON(value: unknown, scope: EncryptionScope): string {
    const json = JSON.stringify(value);
    if (!this.crypto) return json;
    return this.crypto.encrypt(json, scope);
  }

  /** Decrypt a string field. Handles mixed encrypted/plaintext data. */
  private dec(value: string | null | undefined, scope: EncryptionScope): string | null | undefined {
    if (value == null || !this.crypto) return value;
    return this.crypto.maybeDecrypt(value, scope);
  }

  /** Decrypt a JSON field (decrypt then parse). Handles mixed data. */
  private decJSON(value: string | null | undefined, scope: EncryptionScope): unknown {
    if (value == null) return value;
    if (!this.crypto) return JSON.parse(value);
    return this.crypto.maybeDecryptJSON(value, scope);
  }

  /** Build a project-scoped encryption scope from a project ID. */
  private projectScope(projectId: string): EncryptionScope {
    return { type: "project", projectId };
  }

  /** Build a global encryption scope. */
  private globalScope(): EncryptionScope {
    return { type: "global" };
  }

  /** Returns the underlying better-sqlite3 Database instance */
  getDb(): DatabaseType {
    return this.db;
  }

  // ── Migrations ───────────────────────────────────────────

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const applied = new Set<string>();
    const rows = this.db.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>;
    for (const row of rows) {
      applied.add(row.name);
    }

    for (const [name, sql] of Object.entries(MIGRATIONS)) {
      if (!applied.has(name)) {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
      }
    }
  }

  // ── Projects ─────────────────────────────────────────────

  createProject(project: Project): void {
    const scope = this.projectScope(project.id);
    this.db.prepare(
      `INSERT INTO projects (id, name, slug, description, work_dir, system, context, allowed_tools, token_budget, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      project.id,
      project.name,
      project.slug,
      project.description ?? null,
      project.workDir ?? null,
      project.system ? 1 : 0,
      this.encJSON(project.context, scope),
      JSON.stringify(project.allowedTools),
      JSON.stringify(project.tokenBudget),
      project.createdAt,
      project.updatedAt,
    );
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    return row ? this.rowToProject(row) : null;
  }

  getProjectBySlug(slug: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as any;
    return row ? this.rowToProject(row) : null;
  }

  listProjects(opts?: { includeSystem?: boolean }): Project[] {
    const includeSystem = opts?.includeSystem ?? false;
    const query = includeSystem
      ? "SELECT * FROM projects ORDER BY created_at DESC"
      : "SELECT * FROM projects WHERE system = 0 ORDER BY created_at DESC";
    const rows = this.db.prepare(query).all() as any[];
    return rows.map((row) => this.rowToProject(row));
  }

  // ── Bloops ───────────────────────────────────────────────

  createBloop(bloop: Bloop): void {
    const scope = this.projectScope(bloop.projectId);
    this.db.prepare(
      `INSERT INTO loops (id, project_id, parent_loop_id, trigger, status, goal, system_prompt, messages, result, tool_calls, tokens_used, iterations, max_iterations, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      bloop.id,
      bloop.projectId,
      bloop.parentBloopId,
      bloop.trigger,
      bloop.status,
      this.enc(bloop.goal, scope),
      this.enc(bloop.systemPrompt ?? null, scope),
      this.encJSON(bloop.messages, scope),
      this.encJSON(bloop.result, scope),
      this.encJSON(bloop.toolCalls, scope),
      bloop.tokensUsed,
      bloop.iterations,
      bloop.maxIterations,
      bloop.createdAt,
      bloop.updatedAt,
      bloop.completedAt,
    );
  }

  updateBloop(bloop: Bloop): void {
    const scope = this.projectScope(bloop.projectId);
    this.db.prepare(
      `UPDATE loops SET
         status = ?, messages = ?, result = ?, tool_calls = ?,
         tokens_used = ?, iterations = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`
    ).run(
      bloop.status,
      this.encJSON(bloop.messages, scope),
      this.encJSON(bloop.result, scope),
      this.encJSON(bloop.toolCalls, scope),
      bloop.tokensUsed,
      bloop.iterations,
      bloop.updatedAt,
      bloop.completedAt,
      bloop.id,
    );
  }

  getBloop(id: string): Bloop | null {
    const row = this.db.prepare("SELECT * FROM loops WHERE id = ?").get(id) as any;
    return row ? this.rowToBloop(row) : null;
  }

  getProjectBloops(projectId: string, status?: string): Bloop[] {
    let query = "SELECT * FROM loops WHERE project_id = ?";
    const params: any[] = [projectId];
    if (status) {
      query += " AND status = ?";
      params.push(status);
    }
    query += " ORDER BY created_at DESC";

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.rowToBloop(row));
  }

  updateProject(project: Project): void {
    const scope = this.projectScope(project.id);
    this.db.prepare(
      `UPDATE projects SET name = ?, description = ?, work_dir = ?, context = ?, allowed_tools = ?, token_budget = ?, updated_at = ? WHERE id = ?`
    ).run(
      project.name, project.description ?? null, project.workDir ?? null,
      this.encJSON(project.context, scope), JSON.stringify(project.allowedTools),
      JSON.stringify(project.tokenBudget), project.updatedAt, project.id,
    );
  }

  // ── Child Bloop Queries ────────────────────────────────

  getChildBloops(parentBloopId: string): Bloop[] {
    const rows = this.db.prepare(
      "SELECT * FROM loops WHERE parent_loop_id = ? ORDER BY created_at DESC"
    ).all(parentBloopId) as any[];
    return rows.map((row) => this.rowToBloop(row));
  }

  countChildBloops(parentBloopId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM loops WHERE parent_loop_id = ?"
    ).get(parentBloopId) as { cnt: number };
    return row.cnt;
  }

  getBloopAncestorDepth(bloopId: string): number {
    let depth = 0;
    let currentId: string | null = bloopId;
    while (currentId) {
      const row = this.db.prepare(
        "SELECT parent_loop_id FROM loops WHERE id = ?"
      ).get(currentId) as { parent_loop_id: string | null } | undefined;
      if (!row || !row.parent_loop_id) break;
      depth++;
      currentId = row.parent_loop_id;
      if (depth > 10) break; // Hard safety limit
    }
    return depth;
  }

  getBloopByPartialId(partialId: string): Bloop | null {
    const row = this.db.prepare(
      "SELECT * FROM loops WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1"
    ).get(`${partialId}%`) as any;
    return row ? this.rowToBloop(row) : null;
  }

  // ── Global Memory Search ──────────────────────────────

  searchMemoryFTSGlobal(query: string, limit = 10): MemoryEntry[] {
    const rows = this.db.prepare(
      `SELECT me.*, rank
       FROM memory_entries_fts fts
       JOIN memory_entries me ON me.rowid = fts.rowid
       WHERE memory_entries_fts MATCH ?
       AND me.superseded_by IS NULL
       ORDER BY rank
       LIMIT ?`
    ).all(query, limit) as any[];
    return rows.map((row) => this.rowToMemoryEntry(row));
  }

  // ── Row Mappers ──────────────────────────────────────────

  private rowToProject(row: any): Project {
    const scope = this.projectScope(row.id);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      workDir: row.work_dir ?? undefined,
      system: !!row.system,
      context: this.decJSON(row.context, scope) as Record<string, unknown>,
      allowedTools: JSON.parse(row.allowed_tools),
      tokenBudget: JSON.parse(row.token_budget),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToBloop(row: any): Bloop {
    const scope = this.projectScope(row.project_id);
    return {
      id: row.id,
      projectId: row.project_id,
      parentBloopId: row.parent_loop_id,
      trigger: row.trigger,
      status: row.status,
      goal: this.dec(row.goal, scope) as string,
      systemPrompt: this.dec(row.system_prompt, scope) as string | undefined,
      messages: this.decJSON(row.messages, scope) as Bloop["messages"],
      result: this.decJSON(row.result, scope) as Bloop["result"],
      toolCalls: this.decJSON(row.tool_calls, scope) as Bloop["toolCalls"],
      tokensUsed: row.tokens_used,
      iterations: row.iterations,
      maxIterations: row.max_iterations,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  // ── Schedules ──────────────────────────────────────────────

  createSchedule(schedule: Schedule): void {
    const scope = this.projectScope(schedule.projectId);
    this.db.prepare(
      `INSERT INTO schedules (id, project_id, project_slug, cron_expression, goal, team, description, enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      schedule.id, schedule.projectId, schedule.projectSlug,
      schedule.cronExpression, this.enc(schedule.goal, scope), schedule.team,
      schedule.description ?? null, schedule.enabled ? 1 : 0,
      schedule.lastRunAt, schedule.nextRunAt,
      schedule.createdAt, schedule.updatedAt,
    );
  }

  getSchedule(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as any;
    return row ? this.rowToSchedule(row) : null;
  }

  listSchedules(projectSlug?: string): Schedule[] {
    let query = "SELECT * FROM schedules";
    const params: any[] = [];
    if (projectSlug) {
      query += " WHERE project_slug = ?";
      params.push(projectSlug);
    }
    query += " ORDER BY created_at DESC";

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.rowToSchedule(row));
  }

  deleteSchedule(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  updateScheduleRun(id: string, lastRunAt: string): void {
    this.db.prepare(
      "UPDATE schedules SET last_run_at = ?, updated_at = ? WHERE id = ?"
    ).run(lastRunAt, new Date().toISOString(), id);
  }

  // ── Triggers ──────────────────────────────────────────────

  createTrigger(trigger: Trigger): void {
    const scope = this.projectScope(trigger.projectId);
    this.db.prepare(
      `INSERT INTO triggers (id, project_id, project_slug, event_type, filter_pattern, filter_data, goal_template, team, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      trigger.id, trigger.projectId, trigger.projectSlug,
      trigger.eventType, trigger.filterPattern,
      this.encJSON(trigger.filterData, scope), this.enc(trigger.goalTemplate, scope),
      trigger.team, trigger.enabled ? 1 : 0,
      trigger.createdAt, trigger.updatedAt,
    );
  }

  listTriggers(projectSlug?: string): Trigger[] {
    let query = "SELECT * FROM triggers";
    const params: any[] = [];
    if (projectSlug) {
      query += " WHERE project_slug = ?";
      params.push(projectSlug);
    }
    query += " ORDER BY created_at DESC";

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.rowToTrigger(row));
  }

  deleteTrigger(id: string): void {
    this.db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
  }

  // ── Events Log ────────────────────────────────────────────

  logEvent(event: { id: string; projectId: string; eventType: string; eventData: Record<string, unknown>; triggerId: string; createdAt: string }): void {
    const scope = this.projectScope(event.projectId);
    this.db.prepare(
      `INSERT INTO events_log (id, project_id, event_type, event_data, trigger_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(event.id, event.projectId, event.eventType, this.encJSON(event.eventData, scope), event.triggerId, event.createdAt);
  }

  // ── Row Mappers (new) ─────────────────────────────────────

  private rowToSchedule(row: any): Schedule {
    const scope = this.projectScope(row.project_id);
    return {
      id: row.id,
      projectId: row.project_id,
      projectSlug: row.project_slug,
      cronExpression: row.cron_expression,
      goal: this.dec(row.goal, scope) as string,
      team: row.team,
      description: row.description,
      enabled: !!row.enabled,
      lastRunAt: row.last_run_at,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToTrigger(row: any): Trigger {
    const scope = this.projectScope(row.project_id);
    return {
      id: row.id,
      projectId: row.project_id,
      projectSlug: row.project_slug,
      eventType: row.event_type,
      filterPattern: row.filter_pattern,
      filterData: this.decJSON(row.filter_data || "{}", scope) as Record<string, unknown>,
      goalTemplate: this.dec(row.goal_template, scope) as string,
      team: row.team,
      enabled: !!row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Memory Entries ────────────────────────────────────────

  createMemoryEntry(entry: MemoryEntry): void {
    const scope: EncryptionScope = { type: "memory", projectId: entry.projectId };
    this.db.prepare(
      `INSERT INTO memory_entries (id, project_id, memory_type, title, content, source_loop_id, superseded_by, confidence, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.id, entry.projectId, entry.memoryType,
      this.enc(entry.title, scope), this.enc(entry.content, scope), entry.sourceBloopId,
      entry.supersededBy, entry.confidence,
      JSON.stringify(entry.tags),
      entry.createdAt, entry.updatedAt,
    );
    // Mirror plaintext to FTS5 for keyword search (FTS5 stays unencrypted)
    this.db.prepare(
      `INSERT INTO memory_entries_fts (rowid, title, content, memory_type, tags)
       VALUES ((SELECT rowid FROM memory_entries WHERE id = ?), ?, ?, ?, ?)`
    ).run(entry.id, entry.title, entry.content, entry.memoryType, JSON.stringify(entry.tags));
  }

  getMemoryEntry(id: string): MemoryEntry | null {
    const row = this.db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as any;
    return row ? this.rowToMemoryEntry(row) : null;
  }

  listMemoryEntries(projectId: string, type?: MemoryType): MemoryEntry[] {
    let query = "SELECT * FROM memory_entries WHERE project_id = ? AND superseded_by IS NULL";
    const params: any[] = [projectId];
    if (type) {
      query += " AND memory_type = ?";
      params.push(type);
    }
    query += " ORDER BY created_at DESC";
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.rowToMemoryEntry(row));
  }

  supersedeMemoryEntry(oldId: string, newEntry: MemoryEntry): void {
    const txn = this.db.transaction(() => {
      // Insert new entry first (so FK reference is valid)
      this.createMemoryEntry(newEntry);

      // Then mark old entry as superseded
      this.db.prepare(
        "UPDATE memory_entries SET superseded_by = ?, updated_at = ? WHERE id = ?"
      ).run(newEntry.id, new Date().toISOString(), oldId);
    });
    txn();
  }

  searchMemoryFTS(projectId: string, query: string, limit = 10): MemoryEntry[] {
    // FTS5 MATCH with built-in BM25 ranking
    const rows = this.db.prepare(
      `SELECT me.*, rank
       FROM memory_entries_fts fts
       JOIN memory_entries me ON me.rowid = fts.rowid
       WHERE memory_entries_fts MATCH ?
       AND me.project_id = ?
       AND me.superseded_by IS NULL
       ORDER BY rank
       LIMIT ?`
    ).all(query, projectId, limit) as any[];
    return rows.map((row) => this.rowToMemoryEntry(row));
  }

  deleteMemoryEntry(id: string): void {
    // Delete FTS mirror first
    const row = this.db.prepare("SELECT rowid FROM memory_entries WHERE id = ?").get(id) as any;
    if (row) {
      this.db.prepare("DELETE FROM memory_entries_fts WHERE rowid = ?").run(row.rowid);
    }
    this.db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id);
  }

  private rowToMemoryEntry(row: any): MemoryEntry {
    const scope: EncryptionScope = { type: "memory", projectId: row.project_id };
    return {
      id: row.id,
      projectId: row.project_id,
      memoryType: row.memory_type,
      title: this.dec(row.title, scope) as string,
      content: this.dec(row.content, scope) as string,
      sourceBloopId: row.source_loop_id,
      supersededBy: row.superseded_by,
      confidence: row.confidence,
      tags: JSON.parse(row.tags || "[]"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Knowledge Graph ─────────────────────────────────────

  createKGEntity(entity: KGEntity): void {
    const scope = this.projectScope(entity.projectId);
    this.db.prepare(
      `INSERT INTO kg_entities (id, project_id, name, entity_type, description, properties, source_loop_id, source_memory_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entity.id, entity.projectId, entity.name, entity.entityType,
      this.enc(entity.description, scope), this.encJSON(entity.properties, scope),
      entity.sourceBloopId, entity.sourceMemoryId,
      entity.createdAt, entity.updatedAt,
    );
  }

  getKGEntity(id: string): KGEntity | null {
    const row = this.db.prepare("SELECT * FROM kg_entities WHERE id = ?").get(id) as any;
    return row ? this.rowToKGEntity(row) : null;
  }

  findKGEntityByName(projectId: string, name: string): KGEntity | null {
    const row = this.db.prepare(
      "SELECT * FROM kg_entities WHERE project_id = ? AND name = ?"
    ).get(projectId, name) as any;
    return row ? this.rowToKGEntity(row) : null;
  }

  listKGEntities(projectId: string, type?: string): KGEntity[] {
    let query = "SELECT * FROM kg_entities WHERE project_id = ?";
    const params: any[] = [projectId];
    if (type) {
      query += " AND entity_type = ?";
      params.push(type);
    }
    query += " ORDER BY created_at DESC";
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.rowToKGEntity(row));
  }

  searchKGEntities(projectId: string, query: string): KGEntity[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT * FROM kg_entities WHERE project_id = ? AND (name LIKE ? OR description LIKE ?)
       ORDER BY created_at DESC LIMIT 20`
    ).all(projectId, pattern, pattern) as any[];
    return rows.map((row) => this.rowToKGEntity(row));
  }

  updateKGEntity(id: string, updates: { description?: string; properties?: Record<string, unknown> }): void {
    const entity = this.getKGEntity(id);
    if (!entity) return;
    const scope = this.projectScope(entity.projectId);
    this.db.prepare(
      "UPDATE kg_entities SET description = ?, properties = ?, updated_at = ? WHERE id = ?"
    ).run(
      this.enc(updates.description ?? entity.description, scope),
      this.encJSON(updates.properties ?? entity.properties, scope),
      new Date().toISOString(),
      id,
    );
  }

  createKGEdge(edge: KGEdge): void {
    const scope = this.projectScope(edge.projectId);
    this.db.prepare(
      `INSERT INTO kg_edges (id, project_id, source_id, target_id, edge_type, weight, properties, source_loop_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      edge.id, edge.projectId, edge.sourceId, edge.targetId,
      edge.edgeType, edge.weight, this.encJSON(edge.properties, scope),
      edge.sourceBloopId, edge.createdAt,
    );
  }

  getKGEdgesFrom(entityId: string): KGEdge[] {
    const rows = this.db.prepare(
      "SELECT * FROM kg_edges WHERE source_id = ?"
    ).all(entityId) as any[];
    return rows.map((row) => this.rowToKGEdge(row));
  }

  getKGEdgesTo(entityId: string): KGEdge[] {
    const rows = this.db.prepare(
      "SELECT * FROM kg_edges WHERE target_id = ?"
    ).all(entityId) as any[];
    return rows.map((row) => this.rowToKGEdge(row));
  }

  getKGEdgesBoth(entityId: string): KGEdge[] {
    const rows = this.db.prepare(
      "SELECT * FROM kg_edges WHERE source_id = ? OR target_id = ?"
    ).all(entityId, entityId) as any[];
    return rows.map((row) => this.rowToKGEdge(row));
  }

  createKGEntityMemoryLink(entityId: string, memoryId: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO kg_entity_memories (entity_id, memory_id) VALUES (?, ?)"
    ).run(entityId, memoryId);
  }

  getKGEntityMemoryIds(entityId: string): string[] {
    const rows = this.db.prepare(
      "SELECT memory_id FROM kg_entity_memories WHERE entity_id = ?"
    ).all(entityId) as Array<{ memory_id: string }>;
    return rows.map((r) => r.memory_id);
  }

  getKGMemoryEntityIds(memoryId: string): string[] {
    const rows = this.db.prepare(
      "SELECT entity_id FROM kg_entity_memories WHERE memory_id = ?"
    ).all(memoryId) as Array<{ entity_id: string }>;
    return rows.map((r) => r.entity_id);
  }

  private rowToKGEntity(row: any): KGEntity {
    const scope = this.projectScope(row.project_id);
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      entityType: row.entity_type,
      description: this.dec(row.description, scope) as string,
      properties: this.decJSON(row.properties || "{}", scope) as Record<string, unknown>,
      sourceBloopId: row.source_loop_id,
      sourceMemoryId: row.source_memory_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToKGEdge(row: any): KGEdge {
    const scope = this.projectScope(row.project_id);
    return {
      id: row.id,
      projectId: row.project_id,
      sourceId: row.source_id,
      targetId: row.target_id,
      edgeType: row.edge_type,
      weight: row.weight,
      properties: this.decJSON(row.properties || "{}", scope) as Record<string, unknown>,
      sourceBloopId: row.source_loop_id,
      createdAt: row.created_at,
    };
  }

  // ── Working Memory ──────────────────────────────────────

  setWorkingMemory(bloopId: string, key: string, value: string): void {
    const scope = this.globalScope();
    this.db.prepare(
      `INSERT INTO working_memory (loop_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(loop_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(bloopId, key, this.enc(value, scope) as string, new Date().toISOString());
  }

  getWorkingMemory(bloopId: string, key: string): string | undefined {
    const row = this.db.prepare(
      "SELECT value FROM working_memory WHERE loop_id = ? AND key = ?"
    ).get(bloopId, key) as any;
    if (!row) return undefined;
    return this.dec(row.value, this.globalScope()) as string;
  }

  listWorkingMemory(bloopId: string): Array<{ key: string; value: string }> {
    const scope = this.globalScope();
    const rows = this.db.prepare(
      "SELECT key, value FROM working_memory WHERE loop_id = ? ORDER BY key"
    ).all(bloopId) as Array<{ key: string; value: string }>;
    return rows.map((r) => ({ key: r.key, value: this.dec(r.value, scope) as string }));
  }

  deleteWorkingMemory(bloopId: string, key: string): void {
    this.db.prepare(
      "DELETE FROM working_memory WHERE loop_id = ? AND key = ?"
    ).run(bloopId, key);
  }

  clearWorkingMemory(bloopId: string): void {
    this.db.prepare("DELETE FROM working_memory WHERE loop_id = ?").run(bloopId);
  }

  // ── Memory Vectors (sqlite-vec) ────────────────────────

  private toBuffer(f32: Float32Array): Buffer {
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  }

  storeVector(memoryId: string, embedding: Float32Array): void {
    this.db.prepare(
      "INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)"
    ).run(memoryId, this.toBuffer(embedding));
  }

  updateVector(memoryId: string, embedding: Float32Array): void {
    this.db.prepare(
      "UPDATE memory_vectors SET embedding = ? WHERE memory_id = ?"
    ).run(this.toBuffer(embedding), memoryId);
  }

  deleteVector(memoryId: string): void {
    this.db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(memoryId);
  }

  queryVectors(embedding: Float32Array, topK = 10): Array<{ memoryId: string; distance: number }> {
    const rows = this.db.prepare(
      `SELECT memory_id, distance
       FROM memory_vectors
       WHERE embedding MATCH ?
       AND k = ?
       ORDER BY distance`
    ).all(this.toBuffer(embedding), topK) as Array<{ memory_id: string; distance: number }>;
    return rows.map((r) => ({ memoryId: r.memory_id, distance: r.distance }));
  }

  hasVectors(): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM memory_vectors"
    ).get() as { cnt: number };
    return row.cnt > 0;
  }

  // ── Recovery ────────────────────────────────────────────

  /** Recover jobs and bloops stuck as 'running' from a previous crash. */
  recoverStaleJobs(): { jobs: number; bloops: number } {
    const now = new Date().toISOString();
    const jobResult = this.db.prepare(
      `UPDATE job_queue SET status = 'failed', error = 'Process crashed — recovered on startup', completed_at = ? WHERE status = 'running'`
    ).run(now);
    const bloopResult = this.db.prepare(
      `UPDATE loops SET status = 'failed', result = '{"error":"Process crashed — recovered on startup"}', updated_at = ?, completed_at = ? WHERE status = 'running'`
    ).run(now, now);
    return { jobs: jobResult.changes, bloops: bloopResult.changes };
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM job_queue WHERE id = ?").get(id) as any;
    return row ? this.rowToJob(row) : null;
  }

  // ── Aggregate Queries ───────────────────────────────────

  getBloopStats(): { running: number; completed: number; failed: number; total: number } {
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) as cnt FROM loops GROUP BY status"
    ).all() as Array<{ status: string; cnt: number }>;
    const stats = { running: 0, completed: 0, failed: 0, total: 0 };
    for (const row of rows) {
      if (row.status in stats) (stats as any)[row.status] = row.cnt;
      stats.total += row.cnt;
    }
    return stats;
  }

  getProjectBloopStats(projectId: string): { running: number; completed: number; failed: number; total: number; totalTokens: number } {
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) as cnt, SUM(tokens_used) as tokens FROM loops WHERE project_id = ? GROUP BY status"
    ).all(projectId) as Array<{ status: string; cnt: number; tokens: number }>;
    const stats = { running: 0, completed: 0, failed: 0, total: 0, totalTokens: 0 };
    for (const row of rows) {
      if (row.status in stats) (stats as any)[row.status] = row.cnt;
      stats.total += row.cnt;
      stats.totalTokens += row.tokens ?? 0;
    }
    return stats;
  }

  getRecentBloops(limit = 20, status?: string): Bloop[] {
    let query = "SELECT * FROM loops";
    const params: any[] = [];
    if (status) {
      query += " WHERE status = ?";
      params.push(status);
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.rowToBloop(row));
  }

  // ── Job Queue ────────────────────────────────────────────

  createJob(job: Job): void {
    const scope = this.globalScope();
    this.db.prepare(
      `INSERT INTO job_queue (id, project_slug, goal, team, priority, status, source, source_id, extra_context, parent_loop_id, loop_id, error, created_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      job.id, job.projectSlug, this.enc(job.goal, scope), job.team, job.priority,
      job.status, job.source, job.sourceId, this.enc(job.extraContext, scope),
      job.parentBloopId, job.bloopId, job.error, job.createdAt, job.startedAt, job.completedAt,
    );
  }

  /** Atomically claim the highest-priority pending job. */
  claimNextJob(): Job | null {
    const txn = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM job_queue WHERE status = 'pending'
         ORDER BY priority DESC, created_at ASC LIMIT 1`
      ).get() as any;
      if (!row) return null;

      this.db.prepare(
        "UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ?"
      ).run(new Date().toISOString(), row.id);

      return this.rowToJob({ ...row, status: "running", started_at: new Date().toISOString() });
    });
    return txn() ?? null;
  }

  updateJob(id: string, updates: { status?: string; bloopId?: string; error?: string; completedAt?: string }): void {
    const parts: string[] = [];
    const params: any[] = [];
    if (updates.status) { parts.push("status = ?"); params.push(updates.status); }
    if (updates.bloopId && updates.bloopId.length > 0) { parts.push("loop_id = ?"); params.push(updates.bloopId); }
    if (updates.error !== undefined) { parts.push("error = ?"); params.push(updates.error); }
    if (updates.completedAt) { parts.push("completed_at = ?"); params.push(updates.completedAt); }
    if (parts.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE job_queue SET ${parts.join(", ")} WHERE id = ?`).run(...params);
  }

  getJobStats(): JobStats {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM job_queue
    `).get() as any;
    return {
      pending: row.pending ?? 0,
      running: row.running ?? 0,
      completed: row.completed ?? 0,
      failed: row.failed ?? 0,
    };
  }

  listJobs(status?: string, limit = 20): Job[] {
    let query = "SELECT * FROM job_queue";
    const params: any[] = [];
    if (status) {
      query += " WHERE status = ?";
      params.push(status);
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((r) => this.rowToJob(r));
  }

  private rowToJob(row: any): Job {
    const scope = this.globalScope();
    return {
      id: row.id,
      projectSlug: row.project_slug,
      goal: this.dec(row.goal, scope) as string,
      team: row.team,
      priority: row.priority,
      status: row.status,
      source: row.source,
      sourceId: row.source_id,
      extraContext: (this.dec(row.extra_context, scope) as string | null) ?? null,
      parentBloopId: row.parent_loop_id ?? null,
      bloopId: row.loop_id,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  close(): void {
    this.db.close();
  }
}

// ── Migrations ───────────────────────────────────────────────

const MIGRATIONS: Record<string, string> = {
  "001_initial": `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      context TEXT NOT NULL DEFAULT '{}',
      allowed_tools TEXT NOT NULL DEFAULT '["*"]',
      token_budget TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE loops (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      parent_loop_id TEXT REFERENCES loops(id),
      trigger TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'created',
      goal TEXT NOT NULL,
      system_prompt TEXT,
      messages TEXT NOT NULL DEFAULT '[]',
      result TEXT,
      tool_calls TEXT NOT NULL DEFAULT '[]',
      tokens_used INTEGER NOT NULL DEFAULT 0,
      iterations INTEGER NOT NULL DEFAULT 0,
      max_iterations INTEGER NOT NULL DEFAULT 50,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX idx_loops_project ON loops(project_id);
    CREATE INDEX idx_loops_status ON loops(status);
    CREATE INDEX idx_loops_parent ON loops(parent_loop_id);
  `,

  "002_schedules": `
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      project_slug TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      goal TEXT NOT NULL,
      team TEXT NOT NULL DEFAULT 'solo',
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules(project_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
  `,

  "003_triggers": `
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      project_slug TEXT NOT NULL,
      event_type TEXT NOT NULL,
      filter_pattern TEXT NOT NULL DEFAULT '.*',
      filter_data TEXT NOT NULL DEFAULT '{}',
      goal_template TEXT NOT NULL,
      team TEXT NOT NULL DEFAULT 'solo',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_triggers_project ON triggers(project_id);
    CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON triggers(enabled);
  `,

  "004_events_log": `
    CREATE TABLE IF NOT EXISTS events_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}',
      trigger_id TEXT REFERENCES triggers(id),
      spawned_loop_id TEXT REFERENCES loops(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_project ON events_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events_log(event_type);
  `,

  "005_memory_entries": `
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      memory_type TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_loop_id TEXT REFERENCES loops(id),
      superseded_by TEXT REFERENCES memory_entries(id),
      confidence REAL NOT NULL DEFAULT 1.0,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(memory_type);
    CREATE INDEX IF NOT EXISTS idx_memory_superseded ON memory_entries(superseded_by);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
      title, content, memory_type, tags,
      content=memory_entries, content_rowid=rowid
    );
  `,

  "006_knowledge_graph": `
    CREATE TABLE IF NOT EXISTS kg_entities (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'concept',
      description TEXT,
      properties TEXT NOT NULL DEFAULT '{}',
      source_loop_id TEXT REFERENCES loops(id),
      source_memory_id TEXT REFERENCES memory_entries(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_entity_name_project ON kg_entities(name, project_id);
    CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(entity_type);

    CREATE TABLE IF NOT EXISTS kg_edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      source_id TEXT NOT NULL REFERENCES kg_entities(id),
      target_id TEXT NOT NULL REFERENCES kg_entities(id),
      edge_type TEXT NOT NULL DEFAULT 'relates_to',
      weight REAL NOT NULL DEFAULT 1.0,
      properties TEXT NOT NULL DEFAULT '{}',
      source_loop_id TEXT REFERENCES loops(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kg_edges_source ON kg_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_kg_edges_target ON kg_edges(target_id);

    CREATE TABLE IF NOT EXISTS kg_entity_memories (
      entity_id TEXT NOT NULL REFERENCES kg_entities(id),
      memory_id TEXT NOT NULL REFERENCES memory_entries(id),
      PRIMARY KEY (entity_id, memory_id)
    );
  `,

  "007_working_memory": `
    CREATE TABLE IF NOT EXISTS working_memory (
      loop_id TEXT NOT NULL REFERENCES loops(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (loop_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_working_memory_loop ON working_memory(loop_id);
  `,

  "008_project_workdir": `
    ALTER TABLE projects ADD COLUMN work_dir TEXT;
  `,

  "009_memory_vectors": `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[512]
    );
  `,

  "010_job_queue": `
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      project_slug TEXT NOT NULL,
      goal TEXT NOT NULL,
      team TEXT NOT NULL DEFAULT 'auto',
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      extra_context TEXT,
      loop_id TEXT REFERENCES loops(id),
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
    CREATE INDEX IF NOT EXISTS idx_job_queue_priority ON job_queue(priority DESC, created_at ASC);
  `,

  "011_job_queue_parent": `
    ALTER TABLE job_queue ADD COLUMN parent_loop_id TEXT REFERENCES loops(id);
  `,

  "012_crypto_state": `
    CREATE TABLE IF NOT EXISTS _crypto_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,

  "013_system_projects": `
    ALTER TABLE projects ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
  `,
};
