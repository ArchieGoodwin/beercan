import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { BeerCanDB } from "../src/storage/database.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createIntegrationTools } from "../src/tools/builtin/integration.js";
import type { BloopContext } from "../src/tools/builtin/memory.js";

function tmpDb(): string {
  return `/tmp/loops-integ-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function tmpDir(): string {
  const dir = `/tmp/loops-integ-data-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Integration Tools", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let dataDir: string;
  let toolRegistry: ToolRegistry;
  let enqueuedCalls: any[];
  let bloopCtx: BloopContext;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    dataDir = tmpDir();
    toolRegistry = new ToolRegistry();
    enqueuedCalls = [];

    const now = new Date().toISOString();
    db.createProject({
      id: "proj-1",
      name: "Test",
      slug: "test",
      context: {},
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
    const tools = createIntegrationTools(
      {
        toolRegistry,
        enqueueBloop: (opts) => { enqueuedCalls.push(opts); return "job-v1"; },
      },
      () => ctx,
      dataDir,
    );
    const tool = tools.find((t) => t.definition.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool.handler;
  }

  // ── register_tool_from_file ───────────────────────────────

  describe("register_tool_from_file", () => {
    it("registers a valid tool file", async () => {
      // Create a valid tool file
      const toolFile = path.join(dataDir, "my-tool.js");
      fs.writeFileSync(toolFile, `
        export const definition = {
          name: "my_test_tool",
          description: "A test tool",
          inputSchema: { type: "object", properties: {}, required: [] },
        };
        export async function handler(input) {
          return "ok";
        }
      `);

      const handler = getHandler("register_tool_from_file");
      const result = await handler({
        source_path: toolFile,
        tool_name: "my-test-tool",
      });

      expect(result).toContain("registered");
      expect(result).toContain("my-test-tool");

      // Verify copied to tools dir
      const destPath = path.join(dataDir, "tools", "my-test-tool.js");
      expect(fs.existsSync(destPath)).toBe(true);

      // Verify registered in registry
      expect(toolRegistry.has("my_test_tool")).toBe(true);
    });

    it("rejects nonexistent source file", async () => {
      const handler = getHandler("register_tool_from_file");
      await expect(
        handler({ source_path: "/nonexistent/file.js", tool_name: "bad" })
      ).rejects.toThrow("Source file not found");
    });

    it("rejects non-JS files", async () => {
      const pyFile = path.join(dataDir, "script.py");
      fs.writeFileSync(pyFile, "print('hi')");

      const handler = getHandler("register_tool_from_file");
      await expect(
        handler({ source_path: pyFile, tool_name: "py-tool" })
      ).rejects.toThrow("must be .js or .mjs");
    });

    it("rejects invalid tool name", async () => {
      const toolFile = path.join(dataDir, "tool.js");
      fs.writeFileSync(toolFile, "export const definition = {}; export function handler() {}");

      const handler = getHandler("register_tool_from_file");
      await expect(
        handler({ source_path: toolFile, tool_name: "../evil" })
      ).rejects.toThrow("Invalid tool name");
    });

    it("runs test command and rejects on failure", async () => {
      const toolFile = path.join(dataDir, "tool.js");
      fs.writeFileSync(toolFile, "export const definition = {}; export function handler() {}");

      const handler = getHandler("register_tool_from_file");
      await expect(
        handler({
          source_path: toolFile,
          tool_name: "tested-tool",
          test_command: "exit 1",
        })
      ).rejects.toThrow("Test command failed");
    });

    it("rejects file without correct exports", async () => {
      const toolFile = path.join(dataDir, "bad-tool.js");
      fs.writeFileSync(toolFile, "export const foo = 'bar';");

      const handler = getHandler("register_tool_from_file");
      await expect(
        handler({ source_path: toolFile, tool_name: "bad-exports" })
      ).rejects.toThrow("must export");
    });
  });

  // ── register_skill_from_bloop ─────────────────────────────

  describe("register_skill_from_bloop", () => {
    it("creates a skill JSON file", async () => {
      const handler = getHandler("register_skill_from_bloop");
      const result = await handler({
        name: "csv-processing",
        description: "Process CSV files efficiently",
        triggers: ["csv", "parse csv"],
        instructions: "1. Read file\n2. Parse columns\n3. Transform",
      });

      expect(result).toContain("csv-processing");

      const skillPath = path.join(dataDir, "skills", "csv-processing.json");
      expect(fs.existsSync(skillPath)).toBe(true);

      const written = JSON.parse(fs.readFileSync(skillPath, "utf-8"));
      expect(written.name).toBe("csv-processing");
      expect(written.sourceBloopId).toBe("bloop-1");
    });

    it("rejects invalid name", async () => {
      const handler = getHandler("register_skill_from_bloop");
      await expect(
        handler({ name: "Has Spaces", description: "x", triggers: ["x"], instructions: "x" })
      ).rejects.toThrow("Invalid skill name");
    });
  });

  // ── verify_and_integrate ──────────────────────────────────

  describe("verify_and_integrate", () => {
    it("spawns a verification child bloop", async () => {
      const handler = getHandler("verify_and_integrate");
      const result = await handler({
        artifact_path: "/tmp/my-tool.js",
        artifact_type: "tool",
        test_commands: ["node /tmp/my-tool.js --help", "echo test | node /tmp/my-tool.js"],
        integration_name: "my-tool",
      });

      expect(result).toContain("job-v1");
      expect(result).toContain("Verification bloop spawned");
      expect(enqueuedCalls).toHaveLength(1);
      expect(enqueuedCalls[0].parentBloopId).toBe("bloop-1");
      expect(enqueuedCalls[0].goal).toContain("Verify artifact");
      expect(enqueuedCalls[0].goal).toContain("APPROVE");
      expect(enqueuedCalls[0].goal).toContain("REJECT");
    });

    it("rejects without test commands", async () => {
      const handler = getHandler("verify_and_integrate");
      await expect(
        handler({
          artifact_path: "/tmp/tool.js",
          artifact_type: "tool",
          test_commands: [],
          integration_name: "no-tests",
        })
      ).rejects.toThrow("At least one test command");
    });

    it("rejects invalid integration name", async () => {
      const handler = getHandler("verify_and_integrate");
      await expect(
        handler({
          artifact_path: "/tmp/tool.js",
          artifact_type: "tool",
          test_commands: ["echo ok"],
          integration_name: "../hacked",
        })
      ).rejects.toThrow("Invalid integration name");
    });
  });

  // ── no context ───────────────────────────────────────────

  it("throws when no bloop context", async () => {
    const handler = getHandler("register_tool_from_file", null);
    await expect(
      handler({ source_path: "/tmp/x.js", tool_name: "x" })
    ).rejects.toThrow("No active bloop context");
  });
});
