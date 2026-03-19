import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { BeerCanDB } from "../src/storage/database.js";
import { SkillManager } from "../src/skills/index.js";
import { createSkillTools } from "../src/tools/builtin/skills.js";
import type { BloopContext } from "../src/tools/builtin/memory.js";

function tmpDb(): string {
  return `/tmp/loops-skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function tmpDir(): string {
  const dir = `/tmp/loops-skill-data-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Skill Tools", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let dataDir: string;
  let skillManager: SkillManager;
  let bloopCtx: BloopContext;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    dataDir = tmpDir();
    skillManager = new SkillManager(dataDir);

    const now = new Date().toISOString();
    db.createProject({
      id: "proj-1",
      name: "Test",
      slug: "test",
      context: { existingKey: "existingValue" },
      allowedTools: ["*"],
      tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
      createdAt: now,
      updatedAt: now,
    });

    bloopCtx = { bloopId: "bloop-1", projectId: "proj-1", projectSlug: "test" };
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = dbPath + suffix;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function getHandler(name: string, ctx: BloopContext | null = bloopCtx) {
    const tools = createSkillTools(skillManager, () => ctx, db, dataDir);
    const tool = tools.find((t) => t.definition.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.handler;
  }

  // ── create_skill ──────────────────────────────────────────

  it("creates a skill and writes JSON file", async () => {
    const handler = getHandler("create_skill");
    const result = await handler({
      name: "analyze-logs",
      description: "Analyze application logs for errors",
      triggers: ["analyze logs", "check logs"],
      instructions: "1. Read log files\n2. Find errors\n3. Report",
      required_tools: ["read_file", "exec_command"],
    });

    expect(result).toContain("analyze-logs");
    expect(result).toContain("created");

    // Verify file was written
    const skillPath = path.join(dataDir, "skills", "analyze-logs.json");
    expect(fs.existsSync(skillPath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(skillPath, "utf-8"));
    expect(written.name).toBe("analyze-logs");
    expect(written.triggers).toEqual(["analyze logs", "check logs"]);

    // Verify registered in memory
    const skill = skillManager.getSkill("analyze-logs");
    expect(skill).toBeTruthy();
    expect(skill!.description).toBe("Analyze application logs for errors");
  });

  it("rejects invalid skill name", async () => {
    const handler = getHandler("create_skill");
    await expect(
      handler({ name: "../evil", description: "Bad", triggers: ["x"], instructions: "y" })
    ).rejects.toThrow("Invalid skill name");
  });

  it("rejects skill name with spaces", async () => {
    const handler = getHandler("create_skill");
    await expect(
      handler({ name: "has spaces", description: "Bad", triggers: ["x"], instructions: "y" })
    ).rejects.toThrow("Invalid skill name");
  });

  it("rejects skill name with uppercase", async () => {
    const handler = getHandler("create_skill");
    await expect(
      handler({ name: "HasUpperCase", description: "Bad", triggers: ["x"], instructions: "y" })
    ).rejects.toThrow("Invalid skill name");
  });

  it("rejects duplicate skill name", async () => {
    const handler = getHandler("create_skill");
    await handler({ name: "my-skill", description: "A", triggers: ["x"], instructions: "y" });
    await expect(
      handler({ name: "my-skill", description: "B", triggers: ["x"], instructions: "y" })
    ).rejects.toThrow("already exists");
  });

  // ── update_skill ──────────────────────────────────────────

  it("updates an existing skill", async () => {
    // First create
    const createHandler = getHandler("create_skill");
    await createHandler({ name: "updatable", description: "V1", triggers: ["old"], instructions: "Old" });

    // Then update
    const updateHandler = getHandler("update_skill");
    const result = await updateHandler({
      name: "updatable",
      description: "V2",
      triggers: ["new trigger"],
    });

    expect(result).toContain("updated");

    const skill = skillManager.getSkill("updatable");
    expect(skill!.description).toBe("V2");
    expect(skill!.triggers).toEqual(["new trigger"]);
    expect(skill!.instructions).toBe("Old"); // Unchanged
  });

  it("rejects updating nonexistent skill", async () => {
    const handler = getHandler("update_skill");
    await expect(
      handler({ name: "nonexistent" })
    ).rejects.toThrow("Skill not found");
  });

  // ── list_skills ───────────────────────────────────────────

  it("lists skills", async () => {
    // Load built-in skills
    skillManager.load();

    const handler = getHandler("list_skills");
    const result = await handler({});

    expect(result).toContain("generate-tool");
    expect(result).toContain("generate-skill");
  });

  it("returns empty message when no skills", async () => {
    const handler = getHandler("list_skills");
    const result = await handler({});
    expect(result).toContain("No skills registered");
  });

  // ── update_project_context ────────────────────────────────

  it("updates project context", async () => {
    const handler = getHandler("update_project_context");
    const result = await handler({
      key: "reflectionEnabled",
      value: true,
    });

    expect(result).toContain("updated");

    const project = db.getProjectBySlug("test")!;
    expect(project.context.reflectionEnabled).toBe(true);
    expect(project.context.existingKey).toBe("existingValue"); // Preserved
  });

  it("updates nested context value", async () => {
    const handler = getHandler("update_project_context");
    await handler({
      key: "heartbeat",
      value: { enabled: true, intervalMinutes: 15, checklist: ["Check X"] },
    });

    const project = db.getProjectBySlug("test")!;
    expect(project.context.heartbeat).toEqual({
      enabled: true,
      intervalMinutes: 15,
      checklist: ["Check X"],
    });
  });

  it("rejects restricted keys", async () => {
    const handler = getHandler("update_project_context");
    for (const key of ["id", "slug", "name", "createdAt"]) {
      await expect(
        handler({ key, value: "hacked" })
      ).rejects.toThrow("restricted key");
    }
  });

  it("rejects oversized values", async () => {
    const handler = getHandler("update_project_context");
    const bigValue = "x".repeat(11 * 1024); // > 10KB
    await expect(
      handler({ key: "bigKey", value: bigValue })
    ).rejects.toThrow("too large");
  });

  // ── no context ───────────────────────────────────────────

  it("throws when no bloop context", async () => {
    const handler = getHandler("create_skill", null);
    await expect(
      handler({ name: "test", description: "x", triggers: ["x"], instructions: "x" })
    ).rejects.toThrow("No active bloop context");
  });
});
