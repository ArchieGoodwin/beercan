import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";
import {
  readFileDefinition, readFileHandler,
  writeFileDefinition, writeFileHandler,
  listDirDefinition, listDirHandler,
  execDefinition, execHandler,
} from "../src/tools/builtin/filesystem.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(readFileDefinition, readFileHandler);
    registry.register(writeFileDefinition, writeFileHandler);
    registry.register(listDirDefinition, listDirHandler);
    registry.register(execDefinition, execHandler);
  });

  it("registers and retrieves tools", () => {
    expect(registry.has("read_file")).toBe(true);
    expect(registry.has("write_file")).toBe(true);
    expect(registry.has("list_directory")).toBe(true);
    expect(registry.has("exec_command")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("gets all definitions with wildcard", () => {
    const defs = registry.getDefinitions(["*"]);
    expect(defs).toHaveLength(4);
  });

  it("filters definitions by allow list", () => {
    const defs = registry.getDefinitions(["read_file", "exec_command"]);
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name).sort()).toEqual(["exec_command", "read_file"]);
  });

  it("converts to LLM tool format", () => {
    const tools = registry.toLLMTools(["read_file"]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toHaveProperty("name", "read_file");
    expect(tools[0]).toHaveProperty("description");
    expect(tools[0]).toHaveProperty("inputSchema");
    expect((tools[0].inputSchema as any).type).toBe("object");
  });

  it("executes tools and returns output", async () => {
    const result = await registry.execute("exec_command", { command: "echo hello" });
    expect(result.output?.trim()).toBe("hello");
    expect(result.error).toBeUndefined();
  });

  it("returns error for unknown tool", async () => {
    const result = await registry.execute("nonexistent", {});
    expect(result.error).toContain("Unknown tool");
  });

  it("catches tool errors gracefully", async () => {
    const result = await registry.execute("read_file", { path: "/nonexistent/file/path" });
    expect(result.error).toBeTruthy();
    expect(result.output).toBeUndefined();
  });
});

describe("Filesystem tools", () => {
  const tmpDir = path.join(os.tmpdir(), `loops-tool-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it("read_file reads a file", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    fs.writeFileSync(filePath, "hello world");

    const result = await readFileHandler({ path: filePath });
    expect(result).toBe("hello world");
  });

  it("read_file throws on missing file", async () => {
    await expect(readFileHandler({ path: "/nonexistent" })).rejects.toThrow("File not found");
  });

  it("write_file creates files and parent dirs", async () => {
    const filePath = path.join(tmpDir, "sub", "deep", "file.txt");
    const result = await writeFileHandler({ path: filePath, content: "created" });
    expect(result).toContain("7 chars");
    expect(fs.readFileSync(filePath, "utf-8")).toBe("created");
  });

  it("list_directory lists contents", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "");
    fs.mkdirSync(path.join(tmpDir, "subdir"), { recursive: true });

    const result = await listDirHandler({ path: tmpDir });
    expect(result).toContain("a.txt");
    expect(result).toContain("b.txt");
    expect(result).toContain("subdir/");
  });

  it("exec_command runs shell commands", async () => {
    const result = await execHandler({ command: "echo test123" });
    expect(result.trim()).toBe("test123");
  });

  it("exec_command returns error info on failure", async () => {
    const result = await execHandler({ command: "exit 42" });
    expect(result).toContain("EXIT");
  });
});
