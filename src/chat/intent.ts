import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config.js";
import type { BeerCanEngine } from "../index.js";
import type { ChatIntent } from "./types.js";
import { SKIPPY_INTENT_PROMPT } from "./skippy.js";

// ── Intent Parser ──────────────────────────────────────────────
// Two-tier: slash commands (fast, no LLM) → natural language (Haiku).

/**
 * Parse user text into a structured ChatIntent.
 * Tier 1 handles slash commands synchronously.
 * Tier 2 uses an LLM call for natural language understanding.
 */
export async function parseIntent(
  client: Anthropic,
  text: string,
  ctx: { lastProjectSlug?: string },
  engine: BeerCanEngine,
): Promise<ChatIntent> {
  const trimmed = text.trim();

  // ── Tier 1: Slash Commands ─────────────────────────────────

  const slashResult = parseSlashCommand(trimmed);
  if (slashResult) return slashResult;

  // ── Tier 2: Natural Language (LLM) ─────────────────────────

  return classifyWithLLM(client, trimmed, ctx, engine);
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

    case "/help":
    case "/?":
      return { type: "help" };

    default:
      // Unknown slash command — fall through to LLM
      return null;
  }
}

// ── Tier 2: LLM-based Intent Classification ─────────────────

const CLASSIFY_INTENT_TOOL: Anthropic.Tool = {
  name: "classify_intent",
  description: "Classify the user's chat message into a structured intent for the BeerCan agent system.",
  input_schema: {
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
  client: Anthropic,
  text: string,
  ctx: { lastProjectSlug?: string },
  engine: BeerCanEngine,
): Promise<ChatIntent> {
  const config = getConfig();
  const model = config.gatekeeperModel;

  // Gather available projects for context
  const projects = engine.listProjects();
  const projectList = projects.length > 0
    ? projects.map((p) => `- ${p.slug} (${p.name})`).join("\n")
    : "(no projects exist yet)";

  const systemPrompt = [
    SKIPPY_INTENT_PROMPT,
    "",
    "Available projects:",
    projectList,
    "",
    ctx.lastProjectSlug ? `Current context project: ${ctx.lastProjectSlug}` : "No context project set.",
    "",
    "Intent types:",
    "- run_bloop: user wants to run a task/bloop. Requires projectSlug and goal.",
    "- check_status: user wants system status, uptime, stats.",
    "- list_projects: user wants to see all projects.",
    "- bloop_history: user wants to see past bloops, optionally for a specific project.",
    "- bloop_result: user wants details about a specific bloop by ID.",
    "- cancel_job: user wants to cancel a running or pending job.",
    "- create_project: user wants to create a new project. Extract name and optional workDir.",
    "- help: user wants help with commands.",
    "- conversation: anything else — provide a helpful conversationResponse IN SKIPPY'S VOICE.",
    "",
    "If the user asks to run something but does not specify a project, use the context project if available.",
  ].join("\n");

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 512,
      system: systemPrompt,
      tools: [CLASSIFY_INTENT_TOOL],
      tool_choice: { type: "tool", name: "classify_intent" },
      messages: [{ role: "user", content: text }],
    });

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "classify_intent",
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

    case "create_project": {
      const projectName = (input.projectName as string) || (input.projectSlug as string);
      if (!projectName) {
        return { type: "conversation", text: "Oh, you want me to create a project but can't even tell me its name? Try: /init <name> [work-dir]" };
      }
      return { type: "create_project", name: projectName, workDir: (input.workDir as string) || undefined };
    }

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
