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

  /** Load all skills from ~/.beercan/skills/ */
  load(): void {
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
