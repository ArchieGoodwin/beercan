import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";
import type { ToolRegistry } from "../registry.js";
import type { BloopContext } from "./memory.js";
import type { SkillManager } from "../../skills/index.js";
import { getConfig } from "../../config.js";

// ── Integration Tool Factory ────────────────────────────────

const VALID_TOOL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_CUSTOM_TOOLS = 50;

interface IntegrationDeps {
  toolRegistry: ToolRegistry;
  skillManager: SkillManager;
  enqueueBloop: (opts: {
    projectSlug: string;
    goal: string;
    team?: string;
    parentBloopId?: string;
    extraContext?: string;
  }) => string;
}

export function createIntegrationTools(
  deps: IntegrationDeps,
  getBloopContext: () => BloopContext | null,
  dataDir?: string,
): Array<{ definition: ToolDefinition; handler: ToolHandler }> {
  const resolvedDataDir = dataDir ?? getConfig().dataDir;
  return [
    { definition: registerToolDef, handler: createRegisterToolHandler(deps, getBloopContext, resolvedDataDir) },
    { definition: registerSkillFromBloopDef, handler: createRegisterSkillFromBloopHandler(deps.skillManager, getBloopContext, resolvedDataDir) },
    { definition: verifyAndIntegrateDef, handler: createVerifyAndIntegrateHandler(deps, getBloopContext) },
  ];
}

// ── register_tool_from_file ─────────────────────────────────

const registerToolDef: ToolDefinition = {
  name: "register_tool_from_file",
  description:
    "Register a JavaScript file as a BeerCan tool. Validates the file exports the correct interface, " +
    "optionally runs a test command, then copies to ~/.beercan/tools/ and registers it live.",
  inputSchema: {
    type: "object",
    properties: {
      source_path: { type: "string", description: "Path to the .js/.mjs file to register as a tool" },
      tool_name: { type: "string", description: "Name for the tool (lowercase, hyphens ok)" },
      description: { type: "string", description: "What the tool does" },
      test_command: { type: "string", description: "Optional: shell command to test the file before registering" },
    },
    required: ["source_path", "tool_name"],
  },
};

function createRegisterToolHandler(
  deps: IntegrationDeps,
  getCtx: () => BloopContext | null,
  dataDir: string,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const sourcePath = input.source_path as string;
    const toolName = input.tool_name as string;

    // Validate tool name
    if (!VALID_TOOL_NAME.test(toolName)) {
      throw new Error(`Invalid tool name: "${toolName}". Must be lowercase alphanumeric with hyphens.`);
    }

    // Validate file exists and has correct extension
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }
    if (!sourcePath.endsWith(".js") && !sourcePath.endsWith(".mjs")) {
      throw new Error("Source file must be .js or .mjs");
    }

    // Check max tools
    const toolsDir = path.join(dataDir, "tools");
    if (fs.existsSync(toolsDir)) {
      const existing = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
      if (existing.length >= MAX_CUSTOM_TOOLS) {
        throw new Error(`Max custom tools reached (${MAX_CUSTOM_TOOLS}).`);
      }
    }

    // Run test command if provided
    const testCommand = input.test_command as string | undefined;
    if (testCommand) {
      try {
        execSync(testCommand, { timeout: 30_000, stdio: "pipe" });
      } catch (err: any) {
        throw new Error(`Test command failed: ${err.message}`);
      }
    }

    // Validate exports by dynamic import
    let mod: any;
    try {
      mod = await import(`file://${path.resolve(sourcePath)}`);
    } catch (err: any) {
      throw new Error(`Failed to import tool file: ${err.message}`);
    }

    const hasSingleExport = mod.definition && mod.handler;
    const hasDefaultExport = mod.default?.definition && mod.default?.handler;
    const hasMultiExport = Array.isArray(mod.tools) && mod.tools.length > 0;

    if (!hasSingleExport && !hasDefaultExport && !hasMultiExport) {
      throw new Error(
        "Tool file must export { definition, handler }, { default: { definition, handler } }, " +
        "or { tools: [{ definition, handler }, ...] }"
      );
    }

    // Copy to tools directory
    fs.mkdirSync(toolsDir, { recursive: true });
    const destPath = path.join(toolsDir, `${toolName}.js`);
    fs.copyFileSync(sourcePath, destPath);

    // Register live
    if (hasSingleExport) {
      deps.toolRegistry.register(mod.definition, mod.handler);
    } else if (hasDefaultExport) {
      deps.toolRegistry.register(mod.default.definition, mod.default.handler);
    } else if (hasMultiExport) {
      for (const tool of mod.tools) {
        deps.toolRegistry.register(tool.definition, tool.handler);
      }
    }

    return `Tool "${toolName}" registered from ${sourcePath}.\nInstalled to: ${destPath}\nAvailable to all future bloops.`;
  };
}

// ── register_skill_from_bloop ───────────────────────────────

const registerSkillFromBloopDef: ToolDefinition = {
  name: "register_skill_from_bloop",
  description:
    "Package the current bloop's learnings into a reusable skill. " +
    "Creates a skill JSON file with the provided instructions and triggers.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (lowercase, hyphens)" },
      description: { type: "string", description: "What this skill teaches" },
      triggers: {
        type: "array",
        items: { type: "string" },
        description: "Keywords that activate this skill",
      },
      instructions: { type: "string", description: "Step-by-step instructions based on what was learned" },
      required_tools: {
        type: "array",
        items: { type: "string" },
        description: "Tools needed for this workflow",
      },
    },
    required: ["name", "description", "triggers", "instructions"],
  },
};

function createRegisterSkillFromBloopHandler(
  skillManager: SkillManager,
  getCtx: () => BloopContext | null,
  dataDir: string,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const name = input.name as string;

    if (!VALID_TOOL_NAME.test(name)) {
      throw new Error(`Invalid skill name: "${name}". Must be lowercase alphanumeric with hyphens.`);
    }

    const skill = {
      name,
      description: input.description as string,
      triggers: input.triggers as string[],
      instructions: input.instructions as string,
      requiredTools: (input.required_tools as string[]) ?? [],
      config: {},
      enabled: true,
      sourceBloopId: ctx.bloopId,
    };

    const skillsDir = path.join(dataDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillPath = path.join(skillsDir, `${name}.json`);
    fs.writeFileSync(skillPath, JSON.stringify(skill, null, 2));

    // Register live in memory so the skill is immediately available
    skillManager.registerSkill(skill);

    return `Skill "${name}" created and registered from bloop ${ctx.bloopId.slice(0, 8)}...\nFile: ${skillPath}\nTriggers: ${skill.triggers.join(", ")}`;
  };
}

// ── verify_and_integrate ────────────────────────────────────

const verifyAndIntegrateDef: ToolDefinition = {
  name: "verify_and_integrate",
  description:
    "Spawn a verification child bloop to test a built artifact. " +
    "If verification passes (APPROVE), the artifact is integrated as a tool or skill. " +
    "Returns the verification job ID for tracking.",
  inputSchema: {
    type: "object",
    properties: {
      artifact_path: { type: "string", description: "Path to the artifact to verify" },
      artifact_type: {
        type: "string",
        enum: ["tool", "skill"],
        description: "Type of artifact (tool = .js file, skill = workflow)",
      },
      test_commands: {
        type: "array",
        items: { type: "string" },
        description: "Shell commands to test the artifact (must all pass)",
      },
      integration_name: { type: "string", description: "Name for the integrated tool/skill" },
    },
    required: ["artifact_path", "artifact_type", "test_commands", "integration_name"],
  },
};

function createVerifyAndIntegrateHandler(
  deps: IntegrationDeps,
  getCtx: () => BloopContext | null,
): ToolHandler {
  return async (input) => {
    const ctx = getCtx();
    if (!ctx) throw new Error("No active bloop context");

    const artifactPath = input.artifact_path as string;
    const artifactType = input.artifact_type as string;
    const testCommands = input.test_commands as string[];
    const integrationName = input.integration_name as string;

    if (!VALID_TOOL_NAME.test(integrationName)) {
      throw new Error(`Invalid integration name: "${integrationName}". Must be lowercase alphanumeric with hyphens.`);
    }

    if (!testCommands || testCommands.length === 0) {
      throw new Error("At least one test command is required for verification.");
    }

    // Build verification goal
    const testList = testCommands.map((cmd, i) => `${i + 1}. ${cmd}`).join("\n");
    const goal = `Verify artifact at "${artifactPath}" works correctly by running these test commands:\n${testList}\n\n` +
      `If ALL commands succeed (exit code 0) and produce valid output, respond with <decision>APPROVE</decision>.\n` +
      `If ANY command fails, respond with <decision>REJECT</decision> and explain what failed.`;

    const extraContext = [
      `Artifact type: ${artifactType}`,
      `Integration name: ${integrationName}`,
      `Artifact path: ${artifactPath}`,
      `This is an automated verification bloop. Run the test commands and report pass/fail.`,
    ].join("\n");

    // Spawn verification child bloop
    const jobId = deps.enqueueBloop({
      projectSlug: ctx.projectSlug,
      goal,
      team: "solo",
      parentBloopId: ctx.bloopId,
      extraContext,
    });

    return `Verification bloop spawned. Job ID: ${jobId}\n` +
      `Artifact: ${artifactPath} (${artifactType})\n` +
      `Tests: ${testCommands.length} commands\n` +
      `Integration name: ${integrationName}\n\n` +
      `Use get_bloop_result to check verification status. ` +
      `On APPROVE, use register_tool_from_file or register_skill_from_bloop to integrate.`;
  };
}
