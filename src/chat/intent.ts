import { getConfig } from "../config.js";
import type { BeerCanEngine } from "../index.js";
import type { ChatIntent } from "./types.js";
import { SKIPPY_INTENT_PROMPT } from "./skippy.js";
import type { LLMProvider, LLMTool, LLMToolUseBlock } from "../providers/types.js";

// ── Intent Parser ──────────────────────────────────────────────
// Two-tier: slash commands (fast, no LLM) → natural language (Haiku).

/**
 * Parse user text into a structured ChatIntent.
 * Tier 1 handles slash commands synchronously.
 * Tier 2 uses an LLM call for natural language understanding.
 */
export async function parseIntent(
  provider: LLMProvider,
  text: string,
  ctx: { lastProjectSlug?: string; history?: Array<{ role: string; text: string }> },
  engine: BeerCanEngine,
): Promise<ChatIntent> {
  const trimmed = text.trim();

  // ── Tier 0: # and @ shortcuts ─────────────────────────────

  const shortcutResult = parseShortcuts(trimmed, ctx, engine);
  if (shortcutResult) return shortcutResult;

  // ── Tier 1: Slash Commands ─────────────────────────────────

  const slashResult = parseSlashCommand(trimmed);
  if (slashResult) return slashResult;

  // ── Tier 1.5: Natural Language Patterns ───────────────────
  // Catch common phrases before expensive LLM call.

  const patternResult = parseNaturalPatterns(trimmed);
  if (patternResult) return patternResult;

  // ── Tier 2: Natural Language (LLM) ─────────────────────────

  return classifyWithLLM(provider, trimmed, ctx, engine);
}

// ── Tier 0: # and @ Shortcuts ────────────────────────────────

function parseShortcuts(
  text: string,
  ctx: { lastProjectSlug?: string },
  engine: BeerCanEngine,
): ChatIntent | null {
  // # alone → list projects
  if (text === "#") {
    return { type: "list_projects" };
  }

  // ## → exit project context, back to system-level Skippy
  if (text === "##") {
    return { type: "switch_project", projectSlug: "" };
  }

  // #project-name [goal] → switch context or run bloop
  if (text.startsWith("#")) {
    const parts = text.slice(1).split(/\s+/);
    const slug = parts[0];
    const goal = parts.slice(1).join(" ");

    const project = engine.getProject(slug);
    if (!project) {
      // Show available projects if slug not found
      const projects = engine.listProjects();
      const names = projects.map((p) => `#${p.slug}`).join(", ");
      return { type: "conversation", text: `Project \`${slug}\` not found. Available: ${names || "(none)"}` };
    }

    if (goal) {
      // #project-name do something → run bloop
      return { type: "run_bloop", projectSlug: slug, goal };
    }

    // #project-name alone → switch context (handled by ChatBridge)
    return { type: "switch_project" as any, projectSlug: slug };
  }

  // @ alone → recent bloops
  if (text === "@") {
    return { type: "bloop_history", projectSlug: ctx.lastProjectSlug };
  }

  // @id → bloop result
  if (text.startsWith("@")) {
    const bloopId = text.slice(1).trim();
    return { type: "bloop_result", bloopId };
  }

  return null;
}

// ── Tier 1.5: Natural Language Pattern Matching ──────────────
// Catches high-confidence patterns that the LLM frequently misclassifies.

function parseNaturalPatterns(text: string): ChatIntent | null {
  const lower = text.toLowerCase();

  // "create project X", "new project X", "make a project X", "init project X"
  const createProjectMatch = lower.match(
    /^(?:create|new|make|init|initialize|set\s*up|start)\s+(?:a\s+)?(?:new\s+)?project\s+(?:called\s+|named\s+)?(.+)/i,
  );
  if (createProjectMatch) {
    const rest = createProjectMatch[1].trim();
    // Extract project name — take first phrase before "to", "for", "with", "that", "which", "--"
    const nameMatch = rest.match(/^([^\s]+(?:\s+[^\s]+){0,3}?)(?:\s+(?:to|for|with|that|which|--|—)|\s*$)/);
    const rawName = nameMatch ? nameMatch[1] : rest.split(/\s+/).slice(0, 3).join(" ");
    // Clean name: remove trailing prepositions/articles
    const name = rawName.replace(/\s+(?:to|for|with|that|which|a|an|the)$/i, "").trim();

    if (name) {
      // Check for --work-dir flag using original text to preserve path casing
      const workDirMatch = text.match(/--(?:work-dir|workdir|dir)\s+(\S+)/i);
      return { type: "create_project", name, workDir: workDirMatch?.[1] };
    }
  }

  // "create a project" (no name) — still route to create_project so the handler can prompt
  if (/^(?:create|new|make|init|initialize|set\s*up|start)\s+(?:a\s+)?(?:new\s+)?project\s*$/i.test(lower)) {
    return { type: "conversation", text: "Oh, you want me to create a project but can't even tell me its name? Try: /init <name> [work-dir]" };
  }

  // "show me <file>", "cat <file>", "read <file>", "open <file>", "print <file>",
  // "display <file>", "what's in <file>", "show <file> contents", "show the file <file>"
  const readFileMatch = text.match(
    /^(?:show\s+(?:me\s+)?(?:the\s+)?(?:file\s+|contents?\s+(?:of\s+)?)?|cat\s+|read\s+(?:the\s+)?(?:file\s+)?|open\s+(?:the\s+)?(?:file\s+)?|print\s+(?:the\s+)?(?:file\s+)?|display\s+(?:the\s+)?(?:file\s+)?|what(?:'s|s| is)\s+in\s+(?:the\s+)?(?:file\s+)?)(\S+)\s*$/i,
  );
  if (readFileMatch) {
    const filePath = readFileMatch[1];
    // Only match if it looks like a file path (has extension or path separator)
    if (filePath.includes(".") || filePath.includes("/")) {
      return { type: "read_file", filePath };
    }
  }

  return null;
}

// ── Tier 1: Slash Command Parser ─────────────────────────────

function parseSlashCommand(text: string): ChatIntent | null {
  if (!text.startsWith("/")) return null;

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/status":
    case "/s":
      return { type: "check_status" };

    case "/projects":
    case "/p":
      return { type: "list_projects" };

    case "/history":
    case "/h": {
      const projectSlug = parts[1] || undefined;
      return { type: "bloop_history", projectSlug };
    }

    case "/result":
    case "/r": {
      const bloopId = parts[1];
      if (!bloopId) {
        return { type: "conversation", text: "Usage: /result <bloop-id>" };
      }
      return { type: "bloop_result", bloopId };
    }

    case "/cancel":
    case "/c": {
      const jobId = parts[1];
      if (!jobId) {
        return { type: "conversation", text: "Usage: /cancel <job-id>" };
      }
      return { type: "cancel_job", jobId };
    }

    case "/run": {
      if (parts.length < 3) {
        return { type: "conversation", text: "Usage: /run <project> <goal>" };
      }
      const projectSlug = parts[1];
      const goal = parts.slice(2).join(" ");
      return { type: "run_bloop", projectSlug, goal };
    }

    case "/init": {
      if (parts.length < 2) {
        return { type: "conversation", text: "Usage: /init <name> [work-dir]" };
      }
      const name = parts[1];
      const workDir = parts[2] || undefined;
      return { type: "create_project", name, workDir };
    }

    case "/schedule": {
      // /schedule list [project] OR /schedule add <project> "<cron>" <goal>
      const sub = parts[1];
      if (!sub || sub === "list") {
        return { type: "list_schedules", projectSlug: parts[2] };
      }
      if (sub === "add") {
        const proj = parts[2];
        // Find cron in quotes
        const cronMatch = text.match(/"([^"]+)"/);
        const afterCron = cronMatch ? text.slice(text.indexOf(cronMatch[0]) + cronMatch[0].length).trim() : "";
        if (!proj || !cronMatch || !afterCron) {
          return { type: "conversation", text: 'Usage: /schedule add <project> "<cron>" <goal>' };
        }
        return { type: "add_schedule", projectSlug: proj, cron: cronMatch[1], goal: afterCron };
      }
      return { type: "conversation", text: "Usage: /schedule list [project] OR /schedule add <project> \"<cron>\" <goal>" };
    }

    case "/cat":
    case "/show":
    case "/read": {
      const filePath = parts.slice(1).join(" ");
      if (!filePath) {
        return { type: "conversation", text: "Usage: /cat <file-path>" };
      }
      return { type: "read_file", filePath };
    }

    case "/skills":
      return { type: "list_skills" };

    case "/help":
    case "/?":
      return { type: "help" };

    default:
      // Unknown slash command — fall through to LLM
      return null;
  }
}

// ── Tier 2: LLM-based Intent Classification ─────────────────

const CLASSIFY_INTENT_TOOL: LLMTool = {
  name: "classify_intent",
  description: "Classify the user's chat message into a structured intent for the BeerCan agent system.",
  inputSchema: {
    type: "object" as const,
    properties: {
      intent_type: {
        type: "string",
        enum: [
          "run_bloop",
          "check_status",
          "list_projects",
          "bloop_history",
          "bloop_result",
          "cancel_job",
          "create_project",
          "read_file",
          "add_schedule",
          "list_schedules",
          "help",
          "conversation",
        ],
        description: "The classified intent type.",
      },
      projectName: {
        type: "string",
        description: "Project name for create_project intents.",
      },
      workDir: {
        type: "string",
        description: "Optional working directory path for create_project intents.",
      },
      filePath: {
        type: "string",
        description: "File path for read_file intents. Can be a relative path (resolved against project workDir) or absolute path.",
      },
      cronExpression: {
        type: "string",
        description: "Cron expression for add_schedule. Common patterns: '0 9 * * *' (daily 9am), '0 9 * * 1-5' (weekdays 9am), '*/30 * * * *' (every 30min), '0 */2 * * *' (every 2 hours).",
      },
      projectSlug: {
        type: "string",
        description: "Project slug, required for run_bloop and optional for bloop_history. Use the context project if not specified.",
      },
      goal: {
        type: "string",
        description: "The goal text for run_bloop intents.",
      },
      team: {
        type: "string",
        description: "Optional team preset for run_bloop (auto, solo, code_review, managed, full_team).",
      },
      bloopId: {
        type: "string",
        description: "Bloop ID for bloop_result intents.",
      },
      jobId: {
        type: "string",
        description: "Job ID for cancel_job intents.",
      },
      conversationResponse: {
        type: "string",
        description: "A helpful response to send back for conversation intents.",
      },
    },
    required: ["intent_type"],
  },
};

async function classifyWithLLM(
  provider: LLMProvider,
  text: string,
  ctx: { lastProjectSlug?: string; history?: Array<{ role: string; text: string }> },
  engine: BeerCanEngine,
): Promise<ChatIntent> {
  const config = getConfig();
  const model = config.gatekeeperModel;

  // Gather available projects for context
  const projects = engine.listProjects();
  const projectList = projects.length > 0
    ? projects.map((p) => `- ${p.slug} (${p.name})`).join("\n")
    : "(no projects exist yet)";

  // Build recent conversation summary for context
  const recentHistory = (ctx.history || []).slice(-10);
  const historySummary = recentHistory.length > 0
    ? recentHistory.map((h) => `${h.role}: ${h.text.slice(0, 150)}`).join("\n")
    : "";

  const systemPrompt = [
    SKIPPY_INTENT_PROMPT,
    "",
    "Available projects:",
    projectList,
    "",
    ctx.lastProjectSlug ? `Current context project: ${ctx.lastProjectSlug}` : "No context project set.",
    "",
    historySummary ? `Recent conversation:\n${historySummary}` : "",
    "",
    "Intent types:",
    "- run_bloop: user wants to run a task/bloop. Requires projectSlug and goal.",
    "- check_status: user wants system status, uptime, stats.",
    "- list_projects: user wants to see all projects.",
    "- bloop_history: user wants to see past bloops, optionally for a specific project.",
    "- bloop_result: user wants details about a specific bloop by ID.",
    "- cancel_job: user wants to cancel a running or pending job.",
    "- create_project: user wants to create a new project. Extract name and optional workDir.",
    "- read_file: user wants to SEE/READ/VIEW the contents of an existing file. Extract filePath. CRITICAL: 'show me <file>', 'cat <file>', 'read <file>', 'what's in <file>', 'display <file>', 'open <file>' → ALWAYS read_file, NEVER run_bloop. The user wants to see the ACTUAL FILE CONTENTS, not a summary or a bloop task.",
    "- add_schedule: user wants to schedule a RECURRING task. IMPORTANT: When the user says 'schedule', 'daily', 'every day', 'every morning', 'every hour', 'at 9am', 'recurring', 'set up a cron' — this is ALWAYS add_schedule, NEVER run_bloop. Extract cronExpression and goal. The goal should be JUST THE TASK (e.g., 'search for AI news and write a summary'), NOT 'schedule a task to...' — BeerCan handles the scheduling, the goal is what to DO each time.",
    "  Convert natural language: 'every day at 9am' = '0 9 * * *', 'weekday mornings' = '0 9 * * 1-5', 'every hour' = '0 * * * *', 'every 30 min' = '*/30 * * * *'.",
    "- list_schedules: user wants to see existing schedules.",
    "- help: user wants help with commands.",
    "- conversation: anything else — provide a helpful conversationResponse IN SKIPPY'S VOICE.",
    "",
    "If the user asks to run something but does not specify a project, use the context project if available.",
    "CRITICAL: 'schedule X at Y' = add_schedule. 'do X right now' = run_bloop. Never confuse these.",
  ].join("\n");

  try {
    const response = await provider.createMessage({
      model,
      maxTokens: 512,
      system: systemPrompt,
      tools: [CLASSIFY_INTENT_TOOL],
      toolChoice: { type: "tool", name: "classify_intent" },
      messages: [
        // Include recent conversation for multi-turn context
        ...recentHistory.slice(-6).map((h) => ({
          role: h.role as "user" | "assistant",
          content: h.text.slice(0, 200),
        })),
        { role: "user" as const, content: text },
      ],
    });

    const toolBlock = response.content.find(
      (b): b is LLMToolUseBlock => b.type === "tool_use" && b.name === "classify_intent",
    );

    if (!toolBlock) {
      return { type: "conversation", text: "I'm not sure what you mean. Try /help for available commands." };
    }

    const input = toolBlock.input as Record<string, unknown>;
    return toolInputToIntent(input, ctx, projects.length);
  } catch (err: any) {
    // On LLM failure, return a graceful conversation response
    return {
      type: "conversation",
      text: `I had trouble understanding that (${err.message}). Try /help for available commands.`,
    };
  }
}

/**
 * Convert the raw LLM tool_use input into a typed ChatIntent.
 */
function toolInputToIntent(
  input: Record<string, unknown>,
  ctx: { lastProjectSlug?: string },
  projectCount: number,
): ChatIntent {
  const intentType = input.intent_type as string;

  switch (intentType) {
    case "run_bloop": {
      const projectSlug = (input.projectSlug as string) || ctx.lastProjectSlug;
      const goal = input.goal as string;

      if (!projectSlug || !goal) {
        return {
          type: "conversation",
          text: "I need both a project and a goal to run a bloop. Try: /run <project> <goal>",
        };
      }

      if (projectCount === 0) {
        return {
          type: "conversation",
          text: "No projects yet. Create one with `beercan init <name>` first.",
        };
      }

      return {
        type: "run_bloop",
        projectSlug,
        goal,
        team: (input.team as string) || undefined,
      };
    }

    case "check_status":
      return { type: "check_status" };

    case "list_projects":
      return { type: "list_projects" };

    case "bloop_history":
      return {
        type: "bloop_history",
        projectSlug: (input.projectSlug as string) || ctx.lastProjectSlug || undefined,
      };

    case "bloop_result": {
      const bloopId = input.bloopId as string;
      if (!bloopId) {
        return { type: "conversation", text: "I need a bloop ID. Try: /result <bloop-id>" };
      }
      return { type: "bloop_result", bloopId };
    }

    case "cancel_job": {
      const jobId = input.jobId as string;
      if (!jobId) {
        return { type: "conversation", text: "I need a job ID. Try: /cancel <job-id>" };
      }
      return { type: "cancel_job", jobId };
    }

    case "read_file": {
      const filePath = input.filePath as string;
      if (!filePath) {
        return { type: "conversation", text: "I need a file path. Try: /cat <file-path>" };
      }
      return { type: "read_file", filePath };
    }

    case "create_project": {
      const projectName = (input.projectName as string) || (input.projectSlug as string);
      if (!projectName) {
        return { type: "conversation", text: "Oh, you want me to create a project but can't even tell me its name? Try: /init <name> [work-dir]" };
      }
      return { type: "create_project", name: projectName, workDir: (input.workDir as string) || undefined };
    }

    case "add_schedule": {
      const schedProject = (input.projectSlug as string) || ctx.lastProjectSlug;
      const cron = input.cronExpression as string;
      const schedGoal = (input.goal as string) || "";
      if (!schedProject || !cron || !schedGoal) {
        return { type: "conversation", text: "I need a project, schedule time, and goal. Try: 'schedule daily at 9am on my-project: fetch AI news'" };
      }
      return { type: "add_schedule", projectSlug: schedProject, cron, goal: schedGoal };
    }

    case "list_schedules":
      return { type: "list_schedules", projectSlug: (input.projectSlug as string) || ctx.lastProjectSlug };

    case "help":
      return { type: "help" };

    case "conversation":
    default:
      return {
        type: "conversation",
        text: (input.conversationResponse as string) || "I'm not sure how to help with that. Try /help.",
      };
  }
}
