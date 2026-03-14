import { describe, it, expect } from "vitest";
import { PRESET_TEAMS, BUILTIN_ROLES } from "../src/core/roles.js";

describe("Preset teams", () => {
  it("has 4 preset teams", () => {
    expect(Object.keys(PRESET_TEAMS).sort()).toEqual([
      "code_review", "full_team", "managed", "solo",
    ]);
  });

  it("solo team has 1 stage, 1 cycle", () => {
    const t = PRESET_TEAMS.solo;
    expect(t.pipeline).toHaveLength(1);
    expect(t.pipeline[0].roleId).toBe("solo");
    expect(t.maxCycles).toBe(1);
  });

  it("code_review has rejection flow", () => {
    const t = PRESET_TEAMS.code_review;
    expect(t.pipeline).toHaveLength(2);
    expect(t.pipeline[1].canReject).toBe(true);
    expect(t.pipeline[1].rejectTo).toBe("primary");
    expect(t.maxCycles).toBe(3);
  });

  it("full_team has 4 stages with rejection", () => {
    const t = PRESET_TEAMS.full_team;
    expect(t.pipeline).toHaveLength(4);
    expect(t.pipeline[0].roleId).toBe("manager");
    expect(t.pipeline[1].roleId).toBe("coder");
    expect(t.pipeline[2].roleId).toBe("reviewer");
    expect(t.pipeline[3].roleId).toBe("tester");
    expect(t.pipeline[2].canReject).toBe(true);
    expect(t.pipeline[3].canReject).toBe(true);
  });

  it("managed has plan-primary-summarize flow", () => {
    const t = PRESET_TEAMS.managed;
    expect(t.pipeline).toHaveLength(3);
    expect(t.pipeline[0].phase).toBe("plan");
    expect(t.pipeline[1].phase).toBe("primary");
    expect(t.pipeline[2].phase).toBe("summarize");
  });

  it("all pipeline roleIds reference valid built-in roles", () => {
    for (const [name, team] of Object.entries(PRESET_TEAMS)) {
      for (const stage of team.pipeline) {
        expect(BUILTIN_ROLES[stage.roleId]).toBeTruthy();
      }
    }
  });
});

describe("Tool resolution logic", () => {
  // Replicate the resolveTools logic from runner.ts for testing
  function resolveTools(roleTools: string[], projectTools: string[]): string[] {
    if (roleTools.includes("*") && projectTools.includes("*")) return ["*"];
    if (roleTools.includes("*")) return projectTools;
    if (projectTools.includes("*")) return roleTools;
    return roleTools.filter((t) => projectTools.includes(t));
  }

  it("both wildcards → wildcard", () => {
    expect(resolveTools(["*"], ["*"])).toEqual(["*"]);
  });

  it("role wildcard → project tools", () => {
    expect(resolveTools(["*"], ["read_file", "exec_command"])).toEqual(["read_file", "exec_command"]);
  });

  it("project wildcard → role tools", () => {
    expect(resolveTools(["read_file", "write_file"], ["*"])).toEqual(["read_file", "write_file"]);
  });

  it("both specified → intersection", () => {
    const result = resolveTools(
      ["read_file", "write_file", "exec_command"],
      ["read_file", "exec_command", "list_directory"],
    );
    expect(result.sort()).toEqual(["exec_command", "read_file"]);
  });

  it("no overlap → empty", () => {
    const result = resolveTools(["read_file"], ["exec_command"]);
    expect(result).toEqual([]);
  });
});

describe("Decision extraction", () => {
  // Replicate the extractDecision logic from runner.ts
  function extractDecision(content: string): { verdict: string; reason: string } | null {
    const match = content.match(/<decision>(APPROVE|REVISE|REJECT)<\/decision>/);
    if (!match) return null;
    const afterDecision = content.split(match[0])[1]?.trim() || "";
    const beforeDecision = content.split(match[0])[0]?.trim() || "";
    const reason = afterDecision || beforeDecision.split("\n").pop() || "";
    return { verdict: match[1], reason };
  }

  it("extracts APPROVE", () => {
    const result = extractDecision("Everything looks good.\n<decision>APPROVE</decision>");
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("APPROVE");
  });

  it("extracts REVISE with reason after tag", () => {
    const result = extractDecision("<decision>REVISE</decision> Missing error handling in auth.ts");
    expect(result!.verdict).toBe("REVISE");
    expect(result!.reason).toContain("Missing error handling");
  });

  it("extracts REJECT with reason before tag", () => {
    const result = extractDecision("The approach is fundamentally wrong.\n<decision>REJECT</decision>");
    expect(result!.verdict).toBe("REJECT");
    expect(result!.reason).toContain("fundamentally wrong");
  });

  it("returns null when no decision tag", () => {
    expect(extractDecision("This is just a normal message")).toBeNull();
  });

  it("ignores invalid decision values", () => {
    expect(extractDecision("<decision>MAYBE</decision>")).toBeNull();
  });
});
