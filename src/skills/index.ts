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

    this.skills.set("markdown-to-html", {
      name: "markdown-to-html",
      description: "Convert markdown files to styled HTML pages using a Python conversion script",
      triggers: [
        "html page", "html from", "convert to html", "create html",
        "generate html", "markdown to html", "web page from", "display as html",
      ],
      instructions: [
        `MANDATORY APPROACH — You MUST write a Python script that READS and PARSES the markdown file at runtime.`,
        `DO NOT hardcode any content from the markdown file into the script or into write_file calls.`,
        `DO NOT try to write HTML directly with write_file — it WILL be truncated.`,
        ``,
        `Steps:`,
        `1. Read the markdown file to understand its structure (headings, sections, links).`,
        `2. Write a SMALL (<2000 chars) Python script that:`,
        `   - Opens and reads the .md file`,
        `   - Uses regex or string parsing to extract sections, headings, links, etc.`,
        `   - Converts markdown syntax (##, **, [], etc.) to HTML tags`,
        `   - Wraps everything in a styled HTML template with inline <style> CSS`,
        `   - Writes the output .html file`,
        `3. exec_command: python3 convert_md.py`,
        `4. exec_command: wc -c output.html (verify it was created with content)`,
        ``,
        `The Python script must be a REAL PARSER — it reads the markdown at runtime, NOT a copy of the content.`,
        `Keep the script SHORT. Use simple regex: re.sub(r'## (.+)', r'<h2>\\1</h2>', text) etc.`,
        `The CSS styling should be a compact string in the script — dark theme, responsive, clean typography.`,
        ``,
        `Example script structure (keep it under 2000 chars):`,
        `  import re, sys`,
        `  with open('input.md') as f: md = f.read()`,
        `  # Parse title, date, sections with regex`,
        `  html = md`,
        `  html = re.sub(r'^### (.+)$', r'<h3>\\1</h3>', html, flags=re.M)`,
        `  html = re.sub(r'^## (.+)$', r'<h2>\\1</h2>', html, flags=re.M)`,
        `  html = re.sub(r'\\*\\*(.+?)\\*\\*', r'<strong>\\1</strong>', html)`,
        `  html = re.sub(r'\\[([^\\]]+)\\]\\(([^)]+)\\)', r'<a href="\\2">\\1</a>', html)`,
        `  # Wrap in template with CSS`,
        `  with open('output.html', 'w') as f: f.write(template + html + '</div></body></html>')`,
      ].join("\n"),
      requiredTools: ["read_file", "write_file", "exec_command"],
      config: {},
      enabled: true,
    });

    this.skills.set("calendar-assistant", {
      name: "calendar-assistant",
      description: "macOS calendar assistant — reads events, creates events, analyzes schedules, tracks recurring patterns",
      triggers: [
        "calendar", "schedule", "meeting", "appointment", "event", "agenda",
        "free time", "availability", "book a", "schedule a", "what's on",
        "what do i have", "my week", "my day", "upcoming", "recurring",
        "standup", "block time", "time slot", "when am i free", "next meeting",
      ],
      instructions: [
        `You are a calendar assistant with access to macOS Calendar via EventKit.`,
        ``,
        `Available tools:`,
        `- calendar_list: List all calendars (name, source, writable status)`,
        `- calendar_get_events: Fetch events in a date range (start_date, end_date in YYYY-MM-DD, optional calendar_name)`,
        `- calendar_create_event: Create event (title, start_date, end_date in ISO 8601, optional: calendar_name, location, notes, all_day)`,
        `- calendar_search: Search events by keyword (query, optional start_date/end_date)`,
        ``,
        `Guidelines:`,
        `- Always start by listing calendars to understand the setup.`,
        `- Convert relative dates ("today", "tomorrow", "next week") to concrete YYYY-MM-DD dates.`,
        `- Present events chronologically, grouped by day: HH:MM - HH:MM | Title (Calendar) [Location]`,
        `- For recurring events, search with a 60-day window to identify patterns.`,
        `- Before creating events, confirm details and suggest the appropriate calendar based on context.`,
        `- Default meeting duration: 30 minutes. Set all_day: true for deadlines/holidays.`,
        `- If notes contain video call links (Zoom, Meet, Teams), surface them when presenting events.`,
        `- For availability analysis, identify gaps between events during working hours (09:00-18:00).`,
      ].join("\n"),
      requiredTools: ["calendar_list", "calendar_get_events", "calendar_create_event", "calendar_search"],
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
