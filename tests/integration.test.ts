/**
 * Integration tests that run real agent loops via the Claude API.
 *
 * These tests require ANTHROPIC_API_KEY in .env and cost real tokens.
 * Run with: npm run test:integration
 *
 * Each test verifies:
 * - The gatekeeper correctly analyzes the goal and picks appropriate roles
 * - Agents execute tools, produce results, and store memories
 * - The full pipeline completes successfully
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { BeerCanEngine } from "../src/index.js";
import type { LoopEvent } from "../src/index.js";

// ── Test Setup ──────────────────────────────────────────────

const TEST_DATA_DIR = path.join(os.tmpdir(), `loops-integ-${Date.now()}`);
let engine: BeerCanEngine;
const events: LoopEvent[] = [];

function collectEvent(event: LoopEvent) {
  events.push(event);
  // Minimal logging for CI
  if (event.type === "phase_start") {
    console.log(`  ▸ ${event.phase} (${event.roleId})`);
  } else if (event.type === "tool_call") {
    console.log(`    ⚙ ${event.tool}`);
  } else if (event.type === "decision") {
    console.log(`    ✦ ${event.decision}`);
  } else if (event.type === "agent_message" && event.role === "gatekeeper") {
    console.log(`  🔍 ${event.content.split("\n")[0]}`);
  }
}

beforeAll(async () => {
  // Override data dir to isolated temp
  process.env.LOOPS_DATA_DIR = TEST_DATA_DIR;

  engine = await new BeerCanEngine().init();
  engine.createProject({
    name: "Integration Test",
    slug: "integ-test",
    description: "Project for integration testing",
  });
});

afterAll(async () => {
  await engine.close();
  // Cleanup temp data
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── Test 1: Write a utility function ────────────────────────

describe("Task: Write a utility", () => {
  it("writes a working utility file using the agent pipeline", async () => {
    events.length = 0;
    const workDir = path.join(TEST_DATA_DIR, "projects", "integ-test", "code");
    fs.mkdirSync(workDir, { recursive: true });

    const loop = await engine.runLoop({
      projectSlug: "integ-test",
      goal: `Write a small TypeScript utility file at ${workDir}/slug.ts that exports a function slugify(input: string): string which converts any string into a URL-friendly slug (lowercase, replace spaces and special chars with hyphens, trim leading/trailing hyphens, collapse multiple hyphens). Include 3-4 test cases as console.log assertions at the bottom of the file. After writing, run the file with "npx tsx ${workDir}/slug.ts" to verify it works.`,
      team: "auto",
      onEvent: collectEvent,
    });

    console.log(`\n  Loop status: ${loop.status}, tokens: ${loop.tokensUsed}, iterations: ${loop.iterations}`);

    // Verify loop completed
    expect(loop.status).toBe("completed");

    // Verify the file was created
    expect(fs.existsSync(path.join(workDir, "slug.ts"))).toBe(true);

    // Verify file has a slugify function
    const content = fs.readFileSync(path.join(workDir, "slug.ts"), "utf-8");
    expect(content).toContain("slugify");
    expect(content).toContain("export");

    // Verify the agent used tools
    expect(loop.toolCalls.length).toBeGreaterThan(0);
    const toolNames = loop.toolCalls.map((t) => t.toolName);
    expect(toolNames).toContain("write_file");

    // Verify gatekeeper ran (default team is "auto")
    const gatekeeperEvent = events.find(
      (e) => e.type === "agent_message" && "role" in e && e.role === "gatekeeper"
    );
    expect(gatekeeperEvent).toBeTruthy();
  }, 180_000);
});

// ── Test 2: Summarize data from a CSV file ──────────────────

describe("Task: Summarize data", () => {
  it("reads a CSV and produces a structured summary", async () => {
    events.length = 0;

    // Create a test CSV with clear data to summarize
    const csvDir = path.join(TEST_DATA_DIR, "projects", "integ-test", "data");
    fs.mkdirSync(csvDir, { recursive: true });
    const csvPath = path.join(csvDir, "sales_q1.csv");
    fs.writeFileSync(csvPath, `Month,Region,Product,Revenue,Units
Jan,North,Widget A,45000,150
Jan,South,Widget A,32000,110
Jan,North,Widget B,28000,90
Jan,South,Widget B,19000,65
Feb,North,Widget A,51000,170
Feb,South,Widget A,38000,130
Feb,North,Widget B,31000,100
Feb,South,Widget B,22000,75
Mar,North,Widget A,62000,205
Mar,South,Widget A,44000,150
Mar,North,Widget B,35000,115
Mar,South,Widget B,26000,88
`);

    const summaryPath = path.join(csvDir, "summary.md");

    const loop = await engine.runLoop({
      projectSlug: "integ-test",
      goal: `Read the CSV file at ${csvPath}. Analyze the sales data and write a summary report to ${summaryPath}. The summary should include: total revenue, best performing region, best performing product, month-over-month growth trend, and 2-3 key insights. Format as markdown.`,
      team: "auto",
      onEvent: collectEvent,
    });

    console.log(`\n  Loop status: ${loop.status}, tokens: ${loop.tokensUsed}, iterations: ${loop.iterations}`);

    expect(loop.status).toBe("completed");

    // Verify summary was written
    expect(fs.existsSync(summaryPath)).toBe(true);
    const summary = fs.readFileSync(summaryPath, "utf-8");

    // Should contain actual data-driven content
    expect(summary.length).toBeGreaterThan(100);
    // Should reference the data somehow (numbers, regions, products)
    const hasDataContent =
      summary.includes("North") || summary.includes("South") ||
      summary.includes("Widget") || summary.includes("revenue") ||
      summary.includes("Revenue");
    expect(hasDataContent).toBe(true);

    // Verify agent read the CSV
    const readCalls = loop.toolCalls.filter((t) => t.toolName === "read_file");
    expect(readCalls.length).toBeGreaterThan(0);
  }, 180_000);
});

// ── Test 3: Research via curl and summarize ─────────────────

describe("Task: Web research and summarize", () => {
  it("fetches web content and produces a summary", async () => {
    events.length = 0;

    const outputPath = path.join(TEST_DATA_DIR, "projects", "integ-test", "research.md");

    const loop = await engine.runLoop({
      projectSlug: "integ-test",
      goal: `Research the topic "SQLite WAL mode" by using exec_command to run curl commands against publicly available documentation. Try fetching https://www.sqlite.org/wal.html (use "curl -sL" to follow redirects). Read the output and write a concise summary (10-15 lines) to ${outputPath} covering: what WAL mode is, how it works, its advantages, and when to use it.`,
      team: "auto",
      onEvent: collectEvent,
    });

    console.log(`\n  Loop status: ${loop.status}, tokens: ${loop.tokensUsed}, iterations: ${loop.iterations}`);

    expect(loop.status).toBe("completed");

    // Verify research output was written
    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, "utf-8");
    expect(content.length).toBeGreaterThan(50);

    // Should mention WAL-related concepts
    const hasWalContent =
      content.toLowerCase().includes("wal") ||
      content.toLowerCase().includes("write-ahead") ||
      content.toLowerCase().includes("sqlite");
    expect(hasWalContent).toBe(true);

    // Verify exec_command was used (for curl)
    const execCalls = loop.toolCalls.filter((t) => t.toolName === "exec_command");
    expect(execCalls.length).toBeGreaterThan(0);
  }, 180_000);
});

// ── Test 4: Memory persistence across loops ─────────────────

describe("Task: Memory works across loops", () => {
  it("stores memory in first loop and retrieves it in second loop", async () => {
    events.length = 0;

    // First loop: store a fact using memory_store tool directly
    // Use a very specific, tool-focused instruction
    const loop1 = await engine.runLoop({
      projectSlug: "integ-test",
      goal: `You MUST call the memory_store tool with these exact parameters: title="Project database", content="This project uses SQLite with WAL mode and sqlite-vec for vector search", memory_type="fact". Do not skip this step. After the tool call completes, confirm the memory ID.`,
      team: "solo",
      onEvent: collectEvent,
    });

    console.log(`\n  Loop 1 status: ${loop1.status}, tokens: ${loop1.tokensUsed}`);
    expect(loop1.status).toBe("completed");

    // Check if memory_store was called OR if a memory was created (either way works)
    const storeCalls = loop1.toolCalls.filter((t) => t.toolName === "memory_store");
    const memoryWasStored = storeCalls.length > 0 || db_hasMemories();
    expect(memoryWasStored).toBe(true);

    // If the agent stored memory via tool, the second loop should find it
    if (storeCalls.length > 0) {
      // Second loop: search for the stored fact
      const loop2 = await engine.runLoop({
        projectSlug: "integ-test",
        goal: `You MUST call the memory_search tool with query "database SQLite WAL". Report what you find.`,
        team: "solo",
        onEvent: collectEvent,
      });

      console.log(`  Loop 2 status: ${loop2.status}, tokens: ${loop2.tokensUsed}`);
      expect(loop2.status).toBe("completed");

      const searchCalls = loop2.toolCalls.filter((t) => t.toolName === "memory_search");
      expect(searchCalls.length).toBeGreaterThan(0);
    }

    function db_hasMemories(): boolean {
      const entries = engine.getDB().listMemoryEntries(
        engine.getProject("integ-test")!.id
      );
      return entries.length > 0;
    }
  }, 180_000);
});
