import fs from "fs";
import path from "path";
import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";
import type { BloopContext } from "./memory.js";
import type { SkillManager, Skill } from "../../skills/index.js";
import type { BeerCanDB } from "../../storage/database.js";
import { getConfig } from "../../config.js";

// ── Skill & Project Context Tool Factory ────────────────────

const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SKILLS = 50;
const MAX_CONTEXT_VALUE_SIZE = 10 * 1024; // 10KB
const RESTRICTED_CONTEXT_KEYS = new Set(["id", "slug", "name", "createdAt"]);

export function createSkillTools(
  skillManager: SkillManager,
  getBloopContext: () => BloopContext | null,
  db: BeerCanDB,
  dataDir?: string,
): Array<{ definition: ToolDefinition; handler: ToolHandler }> {
  const resolvedDataDir = dataDir ?? getConfig().dataDir;
  return [
    { definition: createSkillDef, handler: createCreateSkillHandler(skillManager, getBloopContext, resolvedDataDir) },
    { definition: updateSkillDef, handler: createUpdateSkillHandler(skillManager, getBloopContext, resolvedDataDir) },
    { definition: listSkillsDef, handler: createListSkillsHandler(skillManager, getBloopContext) },
    { definition: updateProjectContextDef, handler: createUpdateProjectContextHandler(getBloopContext, db) },
  ];
}

// ── create_skill ────────────────────────────────────────────

const createSkillDef: ToolDefinition = {
  name: "create_skill",
  description:
    "Create a new skill that provides step-by-step instructions and context for agents. " +
    "Skills are auto-matched when a bloop goal contains trigger keywords.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (lowercase, hyphens allowed, e.g., 'analyze-logs')" },
      description: { type: "string", description: "What this skill does" },
      triggers: {
        type: "array",
        items: { type: "string" },
        description: "Keywords that activate this skill (e.g., ['analyze logs', 'check logs'])",
      },
      instructions: { type: "string", description: "Step-by-step instructions for agents" },
      required_tools: {
        type: "array",
        items: { type: "string" },
        description: "Tools the agent needs (e.g., ['exec_command', 'read_file'])",
      },
      config: {
        type: "object",
        description: "Optional configuration (env vars, endpoints, etc.)",
      },
    },
    required: ["name", "description", "triggers", "instructions"],
  },
};

function createCreateSkillHandler(
  skillManager: SkillManager,
  getCtx: () => BloopContext | null,
  dataDir: string,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const name = input.name as string;

    // Validate name
    if (!VALID_SKILL_NAME.test(name)) {
      throw new Error(`Invalid skill name: "${name}". Must be lowercase alphanumeric with hyphens (e.g., 'analyze-logs').`);
    }

    // Check if already exists
    if (skillManager.getSkill(name)) {
      throw new Error(`Skill "${name}" already exists. Use update_skill to modify it.`);
    }

    // Check max skills
    if (skillManager.listSkills().length >= MAX_SKILLS) {
      throw new Error(`Max skills reached (${MAX_SKILLS}). Remove some before creating new ones.`);
    }

    const skill: Skill = {
      name,
      description: input.description as string,
      triggers: input.triggers as string[],
      instructions: input.instructions as string,
      requiredTools: (input.required_tools as string[]) ?? [],
      config: (input.config as Record<string, string>) ?? {},
      enabled: true,
    };

    // Write to disk
    const skillsDir = path.join(dataDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillPath = path.join(skillsDir, `${name}.json`);
    fs.writeFileSync(skillPath, JSON.stringify(skill, null, 2));

    // Register in memory
    skillManager.registerSkill(skill);

    return `Skill "${name}" created and registered.\nFile: ${skillPath}\nTriggers: ${skill.triggers.join(", ")}`;
  };
}

// ── update_skill ────────────────────────────────────────────

const updateSkillDef: ToolDefinition = {
  name: "update_skill",
  description: "Update an existing skill's properties.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name to update" },
      description: { type: "string", description: "New description" },
      triggers: { type: "array", items: { type: "string" }, description: "New trigger keywords" },
      instructions: { type: "string", description: "New instructions" },
      required_tools: { type: "array", items: { type: "string" }, description: "New required tools" },
    },
    required: ["name"],
  },
};

function createUpdateSkillHandler(
  skillManager: SkillManager,
  getCtx: () => BloopContext | null,
  dataDir: string,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const name = input.name as string;
    const existing = skillManager.getSkill(name);
    if (!existing) throw new Error(`Skill not found: "${name}"`);

    // Merge updates
    const updated: Skill = {
      ...existing,
      description: (input.description as string) ?? existing.description,
      triggers: (input.triggers as string[]) ?? existing.triggers,
      instructions: (input.instructions as string) ?? existing.instructions,
      requiredTools: (input.required_tools as string[]) ?? existing.requiredTools,
    };

    // Write to disk
    const skillPath = path.join(dataDir, "skills", `${name}.json`);
    if (fs.existsSync(skillPath)) {
      fs.writeFileSync(skillPath, JSON.stringify(updated, null, 2));
    }

    // Update in memory
    skillManager.registerSkill(updated);

    return `Skill "${name}" updated.`;
  };
}

// ── list_skills ─────────────────────────────────────────────

const listSkillsDef: ToolDefinition = {
  name: "list_skills",
  description: "List all available skills with their triggers and descriptions.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

function createListSkillsHandler(
  skillManager: SkillManager,
  getCtx: () => BloopContext | null,
): ToolHandler {
  return async () => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const skills = skillManager.listSkills();
    if (skills.length === 0) return "No skills registered.";

    const lines = skills.map((s, i) => {
      return [
        `${i + 1}. ${s.name} [${s.enabled ? "enabled" : "disabled"}]`,
        `   ${s.description}`,
        `   Triggers: ${s.triggers.join(", ")}`,
        `   Tools: ${s.requiredTools.join(", ") || "none"}`,
      ].join("\n");
    });

    return `Skills (${skills.length}):\n${lines.join("\n\n")}`;
  };
}

// ── update_project_context ──────────────────────────────────

const updateProjectContextDef: ToolDefinition = {
  name: "update_project_context",
  description:
    "Update the current project's context configuration. " +
    "Use to adjust project settings, enable features, or store agent preferences.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Context key to set (e.g., 'reflectionEnabled', 'heartbeat')" },
      value: { description: "Value to set (any JSON-serializable value)" },
    },
    required: ["key", "value"],
  },
};

function createUpdateProjectContextHandler(
  getCtx: () => BloopContext | null,
  db: BeerCanDB,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const key = input.key as string;
    const value = input.value;

    // Restricted keys
    if (RESTRICTED_CONTEXT_KEYS.has(key)) {
      throw new Error(`Cannot modify restricted key: "${key}"`);
    }

    // Value size limit
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_CONTEXT_VALUE_SIZE) {
      throw new Error(`Value too large (${serialized.length} bytes). Max: ${MAX_CONTEXT_VALUE_SIZE} bytes.`);
    }

    const project = db.getProjectBySlug(ctx.projectSlug);
    if (!project) throw new Error(`Project not found: ${ctx.projectSlug}`);

    project.context[key] = value;
    project.updatedAt = new Date().toISOString();
    db.updateProject(project);

    return `Project context updated: ${key} = ${serialized.slice(0, 200)}`;
  };
}
