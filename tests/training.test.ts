import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { BeerCanDB } from "../src/storage/database.js";
import { ScenarioEvaluator } from "../src/training/evaluator.js";
import { DEFAULT_CURRICULUM, GRADUATION_CRITERIA } from "../src/training/curriculum.js";
import { AgentExporter } from "../src/training/exporter.js";
import type { TrainingScenario, TrainingProgress, AgentPackage } from "../src/training/types.js";
import { AgentPackageSchema, TrainingProgressSchema } from "../src/training/types.js";
import type { Project, MemoryEntry, KGEntity, KGEdge } from "../src/schemas.js";

function tmpDb(): string {
  return `/tmp/loops-training-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function makeProject(db: BeerCanDB, overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  const project: Project = {
    id: uuid(), name: "Test Training", slug: "training-test",
    context: { isTrainee: true }, allowedTools: ["*"],
    tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
    createdAt: now, updatedAt: now,
    ...overrides,
  };
  db.createProject(project);
  return project;
}

function makeMemory(db: BeerCanDB, projectId: string, title: string, content: string): MemoryEntry {
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: uuid(), projectId, memoryType: "fact",
    title, content, sourceBloopId: null, supersededBy: null,
    confidence: 0.9, tags: ["test"],
    createdAt: now, updatedAt: now,
  };
  db.createMemoryEntry(entry);
  return entry;
}

function makeEntity(db: BeerCanDB, projectId: string, name: string): KGEntity {
  const now = new Date().toISOString();
  const entity: KGEntity = {
    id: uuid(), projectId, name, entityType: "concept",
    description: `Entity: ${name}`, properties: { source: "test" },
    sourceBloopId: null, sourceMemoryId: null,
    createdAt: now, updatedAt: now,
  };
  db.createKGEntity(entity);
  return entity;
}

function makeEdge(db: BeerCanDB, projectId: string, sourceId: string, targetId: string): KGEdge {
  const now = new Date().toISOString();
  const edge: KGEdge = {
    id: uuid(), projectId, sourceId, targetId,
    edgeType: "relates_to", weight: 1.0,
    properties: { reason: "test link" },
    sourceBloopId: null, createdAt: now,
  };
  db.createKGEdge(edge);
  return edge;
}

// ── Curriculum Tests ────────────────────────────────────────

describe("Curriculum", () => {
  it("has 25 scenarios", () => {
    expect(DEFAULT_CURRICULUM).toHaveLength(25);
  });

  it("has all 4 difficulty levels", () => {
    const levels = new Set(DEFAULT_CURRICULUM.map((s) => s.difficulty));
    expect(levels).toEqual(new Set(["novice", "apprentice", "journeyman", "expert"]));
  });

  it("novice scenarios have no prerequisites from higher levels", () => {
    const noviceIds = DEFAULT_CURRICULUM
      .filter((s) => s.difficulty === "novice")
      .map((s) => s.id);

    for (const scenario of DEFAULT_CURRICULUM.filter((s) => s.difficulty === "novice")) {
      for (const prereq of scenario.prerequisites) {
        expect(noviceIds).toContain(prereq);
      }
    }
  });

  it("all prerequisite IDs reference existing scenarios", () => {
    const allIds = new Set(DEFAULT_CURRICULUM.map((s) => s.id));
    for (const scenario of DEFAULT_CURRICULUM) {
      for (const prereqId of scenario.prerequisites) {
        expect(allIds.has(prereqId)).toBe(true);
      }
    }
  });

  it("required graduation scenario IDs exist in curriculum", () => {
    const allIds = new Set(DEFAULT_CURRICULUM.map((s) => s.id));
    for (const reqId of GRADUATION_CRITERIA.requiredScenarioIds) {
      expect(allIds.has(reqId)).toBe(true);
    }
  });

  it("graduation pass rates are between 0 and 1", () => {
    for (const [, rate] of Object.entries(GRADUATION_CRITERIA.minPassRateByLevel)) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });

  it("scenario IDs are unique", () => {
    const ids = DEFAULT_CURRICULUM.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("create-first-skill uses llm evaluator not contains", () => {
    const scenario = DEFAULT_CURRICULUM.find((s) => s.id === "create-first-skill");
    expect(scenario).toBeDefined();
    expect(scenario!.evaluatorType).toBe("llm");
  });
});

// ── Evaluator Tests ─────────────────────────────────────────

describe("ScenarioEvaluator", () => {
  // Test the non-LLM evaluators (contains and regex) which don't need a provider
  const mockProvider = {} as any;
  let evaluator: ScenarioEvaluator;

  beforeEach(() => {
    evaluator = new ScenarioEvaluator(mockProvider);
  });

  const makeScenario = (overrides: Partial<TrainingScenario>): TrainingScenario => ({
    id: "test",
    name: "Test",
    difficulty: "novice",
    category: "memory",
    goal: "test goal",
    evaluationCriteria: "test criteria",
    evaluatorType: "contains",
    evaluatorConfig: { pattern: "hello", passThreshold: 0.5 },
    teaches: [],
    requiredTools: [],
    prerequisites: [],
    maxAttempts: 3,
    timeoutMs: 60000,
    ...overrides,
  });

  describe("contains evaluator", () => {
    it("passes when pattern is found", async () => {
      const scenario = makeScenario({
        evaluatorType: "contains",
        evaluatorConfig: { pattern: "hello", passThreshold: 0.5 },
      });
      const result = await evaluator.evaluate(scenario, "Say hello world", []);
      expect(result.passed).toBe(true);
      expect(result.score).toBe(1.0);
    });

    it("fails when pattern is missing", async () => {
      const scenario = makeScenario({
        evaluatorType: "contains",
        evaluatorConfig: { pattern: "goodbye", passThreshold: 0.5 },
      });
      const result = await evaluator.evaluate(scenario, "Say hello world", []);
      expect(result.passed).toBe(false);
      expect(result.score).toBe(0.0);
    });

    it("is case-insensitive", async () => {
      const scenario = makeScenario({
        evaluatorType: "contains",
        evaluatorConfig: { pattern: "HELLO", passThreshold: 0.5 },
      });
      const result = await evaluator.evaluate(scenario, "say hello world", []);
      expect(result.passed).toBe(true);
    });
  });

  describe("regex evaluator", () => {
    it("passes when regex matches", async () => {
      const scenario = makeScenario({
        evaluatorType: "regex",
        evaluatorConfig: { pattern: "\\d{2,}", passThreshold: 0.5 },
      });
      const result = await evaluator.evaluate(scenario, "The answer is 42", []);
      expect(result.passed).toBe(true);
      expect(result.score).toBe(1.0);
    });

    it("fails when regex doesn't match", async () => {
      const scenario = makeScenario({
        evaluatorType: "regex",
        evaluatorConfig: { pattern: "^exact$", passThreshold: 0.5 },
      });
      const result = await evaluator.evaluate(scenario, "not exact match", []);
      expect(result.passed).toBe(false);
    });

    it("handles invalid regex gracefully", async () => {
      const scenario = makeScenario({
        evaluatorType: "regex",
        evaluatorConfig: { pattern: "[invalid", passThreshold: 0.5 },
      });
      const result = await evaluator.evaluate(scenario, "test", []);
      expect(result.passed).toBe(false);
      expect(result.feedback).toContain("Invalid regex");
    });
  });

  it("handles unknown evaluator type", async () => {
    const scenario = makeScenario({
      evaluatorType: "unknown" as any,
    });
    const result = await evaluator.evaluate(scenario, "test", []);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("Unknown evaluator type");
  });
});

// ── Training Progress Schema Tests ──────────────────────────

describe("TrainingProgressSchema", () => {
  it("parses valid progress", () => {
    const raw = {
      projectSlug: "test",
      currentLevel: "novice",
      passedScenarios: ["memory-hello"],
      failedScenarios: [],
      scenarioAttempts: [],
      createdTools: [],
      createdSkills: [],
      graduationStatus: "training",
      startedAt: new Date().toISOString(),
      totalTokensUsed: 100,
      totalBloops: 1,
    };
    const parsed = TrainingProgressSchema.parse(raw);
    expect(parsed.projectSlug).toBe("test");
    expect(parsed.currentLevel).toBe("novice");
  });

  it("rejects invalid difficulty level", () => {
    expect(() => TrainingProgressSchema.parse({
      projectSlug: "test",
      currentLevel: "legendary",
      passedScenarios: [],
      failedScenarios: [],
      scenarioAttempts: [],
      createdTools: [],
      createdSkills: [],
      graduationStatus: "training",
      startedAt: new Date().toISOString(),
      totalTokensUsed: 0,
      totalBloops: 0,
    })).toThrow();
  });
});

// ── Agent Package Schema Tests ──────────────────────────────

describe("AgentPackageSchema", () => {
  it("parses a minimal valid package", () => {
    const pkg = {
      version: "1",
      exportedAt: new Date().toISOString(),
      agentName: "TestBot",
      agentSlug: "test-bot",
      memories: [],
      knowledgeGraphEntities: [],
      knowledgeGraphEdges: [],
      skills: [],
      tools: [],
      projectContext: {},
    };
    const parsed = AgentPackageSchema.parse(pkg);
    expect(parsed.agentName).toBe("TestBot");
    expect(parsed.memories).toHaveLength(0);
  });

  it("parses a package with memories and KG", () => {
    const now = new Date().toISOString();
    const pkg = {
      version: "1",
      exportedAt: now,
      agentName: "SmartBot",
      agentSlug: "smart-bot",
      memories: [{
        id: uuid(), projectId: uuid(), memoryType: "fact",
        title: "Test", content: "Content", sourceBloopId: null,
        supersededBy: null, confidence: 0.9, tags: ["test"],
        createdAt: now, updatedAt: now,
      }],
      knowledgeGraphEntities: [{
        id: uuid(), projectId: uuid(), name: "Entity1",
        entityType: "concept", description: "Desc",
        properties: {}, sourceBloopId: null, sourceMemoryId: null,
        createdAt: now, updatedAt: now,
      }],
      knowledgeGraphEdges: [],
      skills: [{ name: "my-skill", content: "{}" }],
      tools: [{ name: "my-tool", content: "export default {}" }],
      projectContext: {},
    };
    const parsed = AgentPackageSchema.parse(pkg);
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.knowledgeGraphEntities).toHaveLength(1);
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.tools).toHaveLength(1);
  });
});

// ── Exporter Tests ──────────────────────────────────────────

describe("AgentExporter", () => {
  let dbPath: string;
  let db: BeerCanDB;
  let tmpDir: string;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new BeerCanDB(dbPath);
    tmpDir = `/tmp/exporter-test-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const makeConfig = () => ({
    dataDir: tmpDir,
    logLevel: "error" as const,
    logFile: path.join(tmpDir, "test.log"),
    defaultModel: "test",
    heavyModel: "test",
    gatekeeperModel: "test",
    maxConcurrent: 1,
    bloopTimeoutMs: 60000,
    maxIterations: 10,
    tokenBudget: 10000,
    webhookRateLimit: 60,
    webhookMaxBodySize: 1048576,
    maxChildrenPerBloop: 5,
    maxSpawnDepth: 3,
    maxSchedulesPerProject: 20,
    maxTriggersPerProject: 20,
    minCronInterval: 5,
    heartbeatInterval: 30,
    heartbeatActiveHours: "08:00-22:00",
    notifyOnComplete: false,
    maintenanceEnabled: false,
    maintenanceInterval: 360,
    calendarEnabled: false,
    calendarCheckInterval: 60,
    calendarMorningBriefCron: "0 8 * * *",
    reflectionEnabled: false,
    encryptionEnabled: false,
    encryptionMode: "passphrase" as const,
    encryptionKeyfile: "",
    logSanitize: undefined,
    provider: "anthropic" as const,
  });

  it("exports project memories and KG to JSON", async () => {
    const project = makeProject(db);
    const mem = makeMemory(db, project.id, "Test Fact", "This is a test fact");
    const e1 = makeEntity(db, project.id, "TypeScript");
    const e2 = makeEntity(db, project.id, "JavaScript");
    makeEdge(db, project.id, e1.id, e2.id);

    const outputPath = path.join(tmpDir, "test-export.json");
    const exporter = new AgentExporter();
    await exporter.export(project.slug, db, makeConfig() as any, outputPath);

    expect(fs.existsSync(outputPath)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    const parsed = AgentPackageSchema.parse(pkg);

    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0].title).toBe("Test Fact");
    expect(parsed.knowledgeGraphEntities).toHaveLength(2);
    expect(parsed.knowledgeGraphEdges).toHaveLength(1);
    expect(parsed.knowledgeGraphEdges[0].properties).toBeDefined();
  });

  it("exports KG edge properties (not empty object)", async () => {
    const project = makeProject(db);
    const e1 = makeEntity(db, project.id, "A");
    const e2 = makeEntity(db, project.id, "B");
    makeEdge(db, project.id, e1.id, e2.id);

    const outputPath = path.join(tmpDir, "edge-props.json");
    const exporter = new AgentExporter();
    await exporter.export(project.slug, db, makeConfig() as any, outputPath);

    const pkg = AgentPackageSchema.parse(
      JSON.parse(fs.readFileSync(outputPath, "utf-8"))
    );
    expect(pkg.knowledgeGraphEdges[0].properties).toEqual({ reason: "test link" });
  });

  it("filters skills for training projects", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "agent-skill.json"), '{"name":"agent-skill"}');
    fs.writeFileSync(path.join(skillsDir, "other-skill.json"), '{"name":"other-skill"}');

    const project = makeProject(db, {
      context: {
        isTrainee: true,
        trainingProgress: {
          projectSlug: "training-test",
          currentLevel: "novice",
          passedScenarios: [],
          failedScenarios: [],
          scenarioAttempts: [],
          createdTools: [],
          createdSkills: ["agent-skill"],
          graduationStatus: "training",
          startedAt: new Date().toISOString(),
          totalTokensUsed: 0,
          totalBloops: 0,
        },
      },
    });

    const outputPath = path.join(tmpDir, "filtered-skills.json");
    const exporter = new AgentExporter();
    await exporter.export(project.slug, db, makeConfig() as any, outputPath);

    const pkg = AgentPackageSchema.parse(
      JSON.parse(fs.readFileSync(outputPath, "utf-8"))
    );
    expect(pkg.skills).toHaveLength(1);
    expect(pkg.skills[0].name).toBe("agent-skill");
  });

  it("filters tools for training projects", async () => {
    const toolsDir = path.join(tmpDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "my-tool.js"), "export default {}");
    fs.writeFileSync(path.join(toolsDir, "other-tool.js"), "export default {}");

    const project = makeProject(db, {
      context: {
        isTrainee: true,
        trainingProgress: {
          projectSlug: "training-test",
          currentLevel: "novice",
          passedScenarios: [],
          failedScenarios: [],
          scenarioAttempts: [],
          createdTools: ["my-tool"],
          createdSkills: [],
          graduationStatus: "training",
          startedAt: new Date().toISOString(),
          totalTokensUsed: 0,
          totalBloops: 0,
        },
      },
    });

    const outputPath = path.join(tmpDir, "filtered-tools.json");
    const exporter = new AgentExporter();
    await exporter.export(project.slug, db, makeConfig() as any, outputPath);

    const pkg = AgentPackageSchema.parse(
      JSON.parse(fs.readFileSync(outputPath, "utf-8"))
    );
    expect(pkg.tools).toHaveLength(1);
    expect(pkg.tools[0].name).toBe("my-tool");
  });

  it("exports all skills/tools for non-training projects", async () => {
    const skillsDir = path.join(tmpDir, "skills");
    const toolsDir = path.join(tmpDir, "tools");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "s1.json"), '{"name":"s1"}');
    fs.writeFileSync(path.join(skillsDir, "s2.json"), '{"name":"s2"}');
    fs.writeFileSync(path.join(toolsDir, "t1.js"), "export default {}");

    const project = makeProject(db, {
      slug: "regular-project",
      context: {},  // not a training project
    });

    const outputPath = path.join(tmpDir, "all-exported.json");
    const exporter = new AgentExporter();
    await exporter.export(project.slug, db, makeConfig() as any, outputPath);

    const pkg = AgentPackageSchema.parse(
      JSON.parse(fs.readFileSync(outputPath, "utf-8"))
    );
    expect(pkg.skills).toHaveLength(2);
    expect(pkg.tools).toHaveLength(1);
  });

  it("import generates new UUIDs (no PK collision on double import)", async () => {
    const project = makeProject(db);
    const mem = makeMemory(db, project.id, "Fact", "Content");
    const e1 = makeEntity(db, project.id, "Node1");
    const e2 = makeEntity(db, project.id, "Node2");
    const edge = makeEdge(db, project.id, e1.id, e2.id);

    // Export
    const outputPath = path.join(tmpDir, "reimport.json");
    const exporter = new AgentExporter();
    await exporter.export(project.slug, db, makeConfig() as any, outputPath);

    // Read package to get original IDs
    const pkg = AgentPackageSchema.parse(
      JSON.parse(fs.readFileSync(outputPath, "utf-8"))
    );
    const origMemId = pkg.memories[0].id;
    const origEntityIds = pkg.knowledgeGraphEntities.map((e) => e.id);
    const origEdgeId = pkg.knowledgeGraphEdges[0].id;

    // Import into a new project (mock engine)
    const mockEngine = {
      getProject: (slug: string) => db.getProjectBySlug(slug),
      createProject: (opts: any) => {
        const now = new Date().toISOString();
        const p: Project = {
          id: uuid(), name: opts.name, slug: opts.slug,
          description: opts.description, workDir: opts.workDir,
          system: opts.system, context: opts.context,
          allowedTools: ["*"],
          tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
          createdAt: now, updatedAt: now,
        };
        db.createProject(p);
        return p;
      },
    } as any;

    const imported = await exporter.import(
      outputPath, "imported-agent", mockEngine, db, makeConfig() as any,
    );

    // Verify the imported memories have NEW IDs
    const importedMems = db.listMemoryEntries(imported.id);
    expect(importedMems).toHaveLength(1);
    expect(importedMems[0].id).not.toBe(origMemId);

    // Verify imported KG entities have NEW IDs
    const importedEntities = db.listKGEntities(imported.id);
    expect(importedEntities).toHaveLength(2);
    for (const ie of importedEntities) {
      expect(origEntityIds).not.toContain(ie.id);
    }

    // Import again with different slug — should not collide
    const imported2 = await exporter.import(
      outputPath, "imported-agent-2", mockEngine, db, makeConfig() as any,
    );
    const importedMems2 = db.listMemoryEntries(imported2.id);
    expect(importedMems2).toHaveLength(1);
    expect(importedMems2[0].id).not.toBe(importedMems[0].id);
  });

  it("import remaps KG edge source/target IDs", async () => {
    const project = makeProject(db);
    const e1 = makeEntity(db, project.id, "Source");
    const e2 = makeEntity(db, project.id, "Target");
    makeEdge(db, project.id, e1.id, e2.id);

    const outputPath = path.join(tmpDir, "remap-edges.json");
    const exporter = new AgentExporter();
    await exporter.export(project.slug, db, makeConfig() as any, outputPath);

    const mockEngine = {
      getProject: (slug: string) => db.getProjectBySlug(slug),
      createProject: (opts: any) => {
        const now = new Date().toISOString();
        const p: Project = {
          id: uuid(), name: opts.name, slug: opts.slug,
          context: opts.context, allowedTools: ["*"],
          tokenBudget: { dailyLimit: 100000, perBloopLimit: 20000 },
          createdAt: now, updatedAt: now,
        };
        db.createProject(p);
        return p;
      },
    } as any;

    const imported = await exporter.import(
      outputPath, "edge-remap-test", mockEngine, db, makeConfig() as any,
    );

    // Get imported entities and edges
    const importedEntities = db.listKGEntities(imported.id);
    const importedEntityIds = new Set(importedEntities.map((e) => e.id));

    // Get edges via the entities
    for (const entity of importedEntities) {
      const edges = db.getKGEdgesBoth(entity.id);
      for (const edge of edges) {
        // Edge source and target should point to NEW entity IDs
        expect(importedEntityIds.has(edge.sourceId)).toBe(true);
        expect(importedEntityIds.has(edge.targetId)).toBe(true);
        // Not the originals
        expect(edge.sourceId).not.toBe(e1.id);
        expect(edge.targetId).not.toBe(e2.id);
      }
    }
  });
});
