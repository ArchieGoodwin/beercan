import fs from "fs";
import path from "path";
import { getLogger } from "../core/logger.js";

// ── Skill System ──────────────────────────────────────────────
// Skills are higher-level than tools. A tool does one thing (fetch a URL).
// A skill orchestrates a workflow with instructions, required tools, and context.
//
// Skills provide agents with:
// 1. Step-by-step instructions for complex workflows
// 2. Required tool configuration (API keys, endpoints)
// 3. Context injection into agent system prompts
//
// Skills are loaded from ~/.beercan/skills/ as .json files.

export interface Skill {
  name: string;
  description: string;
  /** Keywords that trigger this skill (used by intent parser and Gatekeeper) */
  triggers: string[];
  /** Step-by-step instructions injected into the agent's context */
  instructions: string;
  /** Required tools — skill won't activate if tools are missing */
  requiredTools: string[];
  /** Extra config (API keys, endpoints, etc.) — injected as context */
  config: Record<string, string>;
  /** Whether the skill is enabled */
  enabled: boolean;
}

export class SkillManager {
  private skills = new Map<string, Skill>();

  constructor(private dataDir: string) {}

  /** Load built-in + user skills */
  load(): void {
    this.loadBuiltinSkills();

    const skillsDir = path.join(this.dataDir, "skills");
    if (!fs.existsSync(skillsDir)) return;

    const log = getLogger();
    const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      try {
        const fullPath = path.join(skillsDir, file);
        const raw = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
        const skill: Skill = {
          name: raw.name,
          description: raw.description ?? "",
          triggers: raw.triggers ?? [],
          instructions: raw.instructions ?? "",
          requiredTools: raw.requiredTools ?? [],
          config: raw.config ?? {},
          enabled: raw.enabled !== false,
        };
        this.skills.set(skill.name, skill);
        log.info("skills", `Loaded skill: ${skill.name}`, { file });
      } catch (err: any) {
        const log = getLogger();
        log.error("skills", `Failed to load skill: ${file}`, { error: err.message });
      }
    }
  }

  /** Register built-in skills that are always available */
  private loadBuiltinSkills(): void {
    const toolsDir = path.join(this.dataDir, "tools");
    const skillsDir = path.join(this.dataDir, "skills");

    this.skills.set("generate-tool", {
      name: "generate-tool",
      description: "Generate a custom tool file for BeerCan agents",
      triggers: ["create a tool", "generate a tool", "make a tool", "new tool", "build a tool", "add a tool"],
      instructions: [
        `When asked to create/generate a custom tool:`,
        ``,
        `1. Ask what the tool should do if not clear from the request`,
        `2. Generate a JavaScript ESM file with this EXACT structure:`,
        ``,
        `   export const definition = {`,
        `     name: "tool_name",  // snake_case, descriptive`,
        `     description: "What the tool does — agents read this to decide when to use it",`,
        `     inputSchema: {`,
        `       type: "object",`,
        `       properties: { /* input params */ },`,
        `       required: ["param1"],`,
        `     },`,
        `   };`,
        ``,
        `   export async function handler({ param1 }) {`,
        `     // Tool logic — can use fetch(), process.env, etc.`,
        `     return "string result that the agent sees";`,
        `   }`,
        ``,
        `3. IMPORTANT: Write the file to: ${toolsDir}/<tool_name>.js`,
        `4. The tool will be auto-loaded on next BeerCan restart`,
        `5. For multi-tool files, export: export const tools = [{ definition, handler }, ...]`,
        `6. Tools can access env vars via process.env for API keys`,
        `7. Always return a string from the handler — that's what the agent sees`,
      ].join("\n"),
      requiredTools: ["write_file"],
      config: {},
      enabled: true,
    });

    this.skills.set("generate-skill", {
      name: "generate-skill",
      description: "Generate a skill configuration file for BeerCan",
      triggers: ["create a skill", "generate a skill", "make a skill", "new skill", "build a skill", "add a skill"],
      instructions: [
        `When asked to create/generate a skill:`,
        ``,
        `1. Ask what the skill should do if not clear`,
        `2. Generate a JSON file with this structure:`,
        ``,
        `   {`,
        `     "name": "skill-name",`,
        `     "description": "What this skill does",`,
        `     "triggers": ["keyword1", "keyword2"],  // words that activate this skill`,
        `     "instructions": "Step-by-step instructions for agents...",`,
        `     "requiredTools": ["tool1", "tool2"],  // tools agents need`,
        `     "config": { "API_KEY": "value" },  // env vars/config`,
        `     "enabled": true`,
        `   }`,
        ``,
        `3. IMPORTANT: Write the file to: ${skillsDir}/<skill-name>.json`,
        `4. The skill will be auto-loaded on next BeerCan restart`,
        `5. Triggers should be natural language phrases users might say`,
        `6. Instructions tell agents HOW to accomplish the workflow step by step`,
        `7. If the skill needs a custom tool, offer to generate that too`,
      ].join("\n"),
      requiredTools: ["write_file"],
      config: {},
      enabled: true,
    });
  }

  /** Get all loaded skills */
  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /** Get enabled skills */
  getEnabledSkills(): Skill[] {
    return this.listSkills().filter((s) => s.enabled);
  }

  /** Find skills matching a goal (by trigger keywords) */
  matchSkills(goal: string): Skill[] {
    const lower = goal.toLowerCase();
    return this.getEnabledSkills().filter((skill) =>
      skill.triggers.some((trigger) => lower.includes(trigger.toLowerCase()))
    );
  }

  /** Get a skill by name */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Register a skill at runtime (without reloading from disk) */
  registerSkill(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  /** Unregister a skill by name */
  unregisterSkill(name: string): void {
    this.skills.delete(name);
  }

  /** Build extra context from matching skills to inject into agent prompts */
  buildSkillContext(goal: string): string | null {
    const matched = this.matchSkills(goal);
    if (matched.length === 0) return null;

    const parts: string[] = ["--- Active Skills ---"];
    for (const skill of matched) {
      parts.push(`\n## Skill: ${skill.name}`);
      parts.push(`Description: ${skill.description}`);
      parts.push(`\nInstructions:\n${skill.instructions}`);
      if (Object.keys(skill.config).length > 0) {
        parts.push(`\nConfiguration:`);
        for (const [key, value] of Object.entries(skill.config)) {
          // Mask API keys in the prompt (show first 8 chars)
          const display = key.toLowerCase().includes("key") || key.toLowerCase().includes("secret")
            ? value.slice(0, 8) + "..."
            : value;
          parts.push(`  ${key}: ${display}`);
        }
      }
    }
    return parts.join("\n");
  }

  /** Create a skill template file */
  createTemplate(name: string): string {
    const skillsDir = path.join(this.dataDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    const skillPath = path.join(skillsDir, `${name}.json`);
    const template: Skill = {
      name,
      description: `Describe what the ${name} skill does`,
      triggers: ["keyword1", "keyword2"],
      instructions: `Step-by-step instructions for agents:\n1. First, do this\n2. Then, do that\n3. Finally, deliver the result`,
      requiredTools: [],
      config: {},
      enabled: true,
    };

    fs.writeFileSync(skillPath, JSON.stringify(template, null, 2));
    return skillPath;
  }
}
