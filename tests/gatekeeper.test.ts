import { describe, it, expect } from "vitest";
import { GatekeeperPlanSchema } from "../src/core/gatekeeper.js";
import { BUILTIN_ROLES } from "../src/core/roles.js";
import { ROLE_TEMPLATES } from "../src/core/role-templates.js";

describe("GatekeeperPlanSchema", () => {
  it("validates a simple solo plan", () => {
    const plan = {
      reasoning: "Simple task, one agent is enough",
      complexity: "simple",
      roles: [
        {
          roleId: "solo",
          name: "Solo",
          description: "General purpose agent",
          allowedTools: ["*"],
          phase: "primary",
          maxIterations: 20,
        },
      ],
      pipeline: [{ phase: "primary", roleId: "solo" }],
      maxCycles: 1,
    };

    const result = GatekeeperPlanSchema.parse(plan);
    expect(result.complexity).toBe("simple");
    expect(result.roles).toHaveLength(1);
    expect(result.pipeline).toHaveLength(1);
  });

  it("validates a complex multi-role plan", () => {
    const plan = {
      reasoning: "Writing task needs research, writing, and editing",
      complexity: "medium",
      roles: [
        {
          roleId: "researcher",
          name: "Researcher",
          description: "Gathers context",
          allowedTools: ["read_file", "memory_search"],
          phase: "plan",
          maxIterations: 10,
        },
        {
          roleId: "writer",
          name: "Writer",
          description: "Drafts blog post",
          allowedTools: ["read_file", "write_file", "memory_search"],
          phase: "primary",
          model: "claude-sonnet-4-20250514",
          maxIterations: 15,
        },
        {
          roleId: "editor",
          name: "Editor",
          description: "Reviews and edits",
          allowedTools: ["read_file", "memory_search"],
          phase: "review",
          maxIterations: 5,
        },
      ],
      pipeline: [
        { phase: "plan", roleId: "researcher" },
        { phase: "primary", roleId: "writer" },
        { phase: "review", roleId: "editor", canReject: true, rejectTo: "primary" },
      ],
      maxCycles: 2,
    };

    const result = GatekeeperPlanSchema.parse(plan);
    expect(result.roles).toHaveLength(3);
    expect(result.pipeline[2].canReject).toBe(true);
    expect(result.pipeline[2].rejectTo).toBe("primary");
  });

  it("validates a plan with custom systemPrompt", () => {
    const plan = {
      reasoning: "Custom email processing task",
      complexity: "simple",
      roles: [
        {
          roleId: "email_processor",
          name: "Email Processor",
          description: "Processes incoming emails",
          systemPrompt: "You are an email processor agent. Read emails from the inbox and categorize them.",
          allowedTools: ["read_file", "write_file"],
          phase: "primary",
          maxIterations: 10,
        },
      ],
      pipeline: [{ phase: "primary", roleId: "email_processor" }],
      maxCycles: 1,
    };

    const result = GatekeeperPlanSchema.parse(plan);
    expect(result.roles[0].systemPrompt).toContain("email processor");
  });

  it("rejects invalid complexity", () => {
    const plan = {
      reasoning: "test",
      complexity: "ultra",
      roles: [],
      pipeline: [],
      maxCycles: 1,
    };
    expect(() => GatekeeperPlanSchema.parse(plan)).toThrow();
  });

  it("rejects invalid phase", () => {
    const plan = {
      reasoning: "test",
      complexity: "simple",
      roles: [{
        roleId: "test",
        name: "Test",
        description: "Test",
        allowedTools: [],
        phase: "invalid_phase",
        maxIterations: 5,
      }],
      pipeline: [{ phase: "invalid_phase", roleId: "test" }],
      maxCycles: 1,
    };
    expect(() => GatekeeperPlanSchema.parse(plan)).toThrow();
  });
});

describe("Built-in roles", () => {
  it("has 5 built-in roles", () => {
    const ids = Object.keys(BUILTIN_ROLES);
    expect(ids).toHaveLength(5);
    expect(ids.sort()).toEqual(["coder", "manager", "reviewer", "solo", "tester"]);
  });

  it("all roles have required fields", () => {
    for (const [id, role] of Object.entries(BUILTIN_ROLES)) {
      expect(role.id).toBe(id);
      expect(role.name).toBeTruthy();
      expect(role.systemPrompt).toBeTruthy();
      expect(role.allowedTools.length).toBeGreaterThan(0);
      expect(role.maxIterations).toBeGreaterThan(0);
    }
  });

  it("manager has memory tools", () => {
    const mgr = BUILTIN_ROLES.manager;
    expect(mgr.allowedTools).toContain("memory_search");
    expect(mgr.allowedTools).toContain("memory_query_graph");
    expect(mgr.allowedTools).toContain("memory_scratch");
  });

  it("coder has memory tools for storing knowledge", () => {
    const coder = BUILTIN_ROLES.coder;
    expect(coder.allowedTools).toContain("memory_search");
    expect(coder.allowedTools).toContain("memory_store");
    expect(coder.allowedTools).toContain("memory_update");
    expect(coder.allowedTools).toContain("memory_link");
    expect(coder.allowedTools).toContain("memory_scratch");
  });

  it("solo has wildcard tools", () => {
    expect(BUILTIN_ROLES.solo.allowedTools).toEqual(["*"]);
  });
});

describe("Role templates", () => {
  it("has 11 role templates", () => {
    const ids = Object.keys(ROLE_TEMPLATES);
    expect(ids).toHaveLength(11);
    expect(ids.sort()).toEqual([
      "analyst", "architect", "data_processor", "devops",
      "editor", "heartbeat", "planner", "researcher", "summarizer", "verifier", "writer",
    ]);
  });

  it("all templates have required fields", () => {
    for (const [id, template] of Object.entries(ROLE_TEMPLATES)) {
      expect(template.name).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.systemPrompt).toBeTruthy();
      expect(template.systemPrompt.length).toBeGreaterThan(50);
      expect(template.allowedTools.length).toBeGreaterThan(0);
      expect(template.maxIterations).toBeGreaterThan(0);
    }
  });

  it("editor and reviewer templates have decision instructions", () => {
    expect(ROLE_TEMPLATES.editor.systemPrompt).toContain("<decision>");
  });

  it("templates cover different phases", () => {
    const phases = new Set(Object.values(ROLE_TEMPLATES).map((t) => t.phase));
    expect(phases).toContain("plan");
    expect(phases).toContain("primary");
    expect(phases).toContain("review");
    expect(phases).toContain("summarize");
  });
});
