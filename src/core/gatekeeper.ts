import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getConfig } from "../config.js";
import type { Project } from "../schemas.js";
import type { AgentRole, BloopTeam } from "./roles.js";
import { BUILTIN_ROLES } from "./roles.js";
import { ROLE_TEMPLATES } from "./role-templates.js";
import type { MemoryManager } from "../memory/index.js";

// ── Gatekeeper Plan Schema ──────────────────────────────────

export const GatekeeperRolePlanSchema = z.object({
  roleId: z.string(),
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()),
  phase: z.enum(["plan", "primary", "review", "validate", "summarize"]),
  model: z.string().optional(),
  maxIterations: z.number(),
});
export type GatekeeperRolePlan = z.infer<typeof GatekeeperRolePlanSchema>;

export const GatekeeperPipelineStagePlanSchema = z.object({
  phase: z.enum(["plan", "primary", "review", "validate", "summarize"]),
  roleId: z.string(),
  canReject: z.boolean().optional(),
  rejectTo: z.enum(["plan", "primary", "review", "validate", "summarize"]).optional(),
});

export const GatekeeperPlanSchema = z.object({
  reasoning: z.string(),
  complexity: z.enum(["simple", "medium", "complex"]),
  roles: z.array(GatekeeperRolePlanSchema),
  pipeline: z.array(GatekeeperPipelineStagePlanSchema),
  maxCycles: z.number(),
});
export type GatekeeperPlan = z.infer<typeof GatekeeperPlanSchema>;

// ── Gatekeeper Result ───────────────────────────────────────

export interface GatekeeperResult {
  team: BloopTeam;
  dynamicRoles: AgentRole[];
  plan: GatekeeperPlan;
  tokensUsed: number;
}

// ── Structured Output Tool ──────────────────────────────────

const EXECUTION_PLAN_TOOL: Anthropic.Tool = {
  name: "create_execution_plan",
  description: "Create a structured execution plan for the given goal. You MUST call this tool with your plan.",
  input_schema: {
    type: "object" as const,
    properties: {
      reasoning: {
        type: "string",
        description: "Brief explanation of why you chose this team composition (2-3 sentences max)",
      },
      complexity: {
        type: "string",
        enum: ["simple", "medium", "complex"],
        description: "Overall task complexity.",
      },
      roles: {
        type: "array",
        description: "The roles needed for this execution.",
        items: {
          type: "object",
          properties: {
            roleId: {
              type: "string",
              description: "Role ID. Built-in: manager, coder, reviewer, tester, solo. Templates: writer, researcher, analyst, data_processor, summarizer, planner, editor, devops, architect. Or invent a new one.",
            },
            name: { type: "string", description: "Human-readable role name" },
            description: { type: "string", description: "What this role does for THIS specific goal" },
            systemPrompt: {
              type: "string",
              description: "Custom system prompt. REQUIRED for invented roles. Optional for built-in/template roles.",
            },
            allowedTools: {
              type: "array",
              items: { type: "string" },
              description: "Tools: read_file, write_file, list_directory, exec_command, web_fetch (fetch web pages/URLs for live internet data), http_request (full HTTP requests to APIs), send_notification, memory_search, memory_store, memory_update, memory_link, memory_query_graph, memory_scratch. Use [\"*\"] for all.",
            },
            phase: {
              type: "string",
              enum: ["plan", "primary", "review", "validate", "summarize"],
            },
            model: {
              type: "string",
              description: "Optional model override. Options: claude-haiku-4-5-20251001 (fast/cheap), claude-sonnet-4-6 (balanced), claude-opus-4-6 (powerful).",
            },
            maxIterations: {
              type: "number",
              description: "Max API call iterations (typically 5-30).",
            },
          },
          required: ["roleId", "name", "description", "allowedTools", "phase", "maxIterations"],
        },
      },
      pipeline: {
        type: "array",
        description: "Ordered pipeline stages.",
        items: {
          type: "object",
          properties: {
            phase: { type: "string", enum: ["plan", "primary", "review", "validate", "summarize"] },
            roleId: { type: "string" },
            canReject: { type: "boolean", description: "Can this stage send work back?" },
            rejectTo: { type: "string", enum: ["plan", "primary", "review", "validate", "summarize"] },
          },
          required: ["phase", "roleId"],
        },
      },
      maxCycles: {
        type: "number",
        description: "Max pipeline cycles (1 for simple, 2-3 for complex with review)",
      },
    },
    required: ["reasoning", "complexity", "roles", "pipeline", "maxCycles"],
  },
};

// ── Gatekeeper Class ────────────────────────────────────────

export class Gatekeeper {
  private client: Anthropic;
  private memory: MemoryManager | null;

  constructor(client: Anthropic, memory?: MemoryManager) {
    this.client = client;
    this.memory = memory ?? null;
  }

  /** Analyze a goal and produce a dynamic team composition via a single LLM call. */
  async analyze(options: {
    goal: string;
    project: Project;
    memoryContext?: string;
    model?: string;
    availableTools?: string[];
  }): Promise<GatekeeperResult> {
    const config = getConfig();
    const model = options.model ?? config.gatekeeperModel;

    const systemPrompt = this.buildPrompt(options);

    const response = await this.client.messages.create({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      tools: [EXECUTION_PLAN_TOOL],
      tool_choice: { type: "tool", name: "create_execution_plan" },
      messages: [
        {
          role: "user",
          content: `Analyze this goal and create an execution plan:\n\n${options.goal}`,
        },
      ],
    });

    const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "create_execution_plan"
    );

    if (!toolBlock) {
      throw new Error("Gatekeeper did not produce a valid execution plan");
    }

    const plan = GatekeeperPlanSchema.parse(toolBlock.input);

    // Validate: every pipeline roleId must exist in roles array
    const roleIds = new Set(plan.roles.map((r) => r.roleId));
    for (const stage of plan.pipeline) {
      if (!roleIds.has(stage.roleId)) {
        throw new Error(`Gatekeeper plan references role "${stage.roleId}" in pipeline but it's not in the roles array`);
      }
    }

    return this.planToExecution(plan, tokensUsed);
  }

  /** Convert a GatekeeperPlan into BloopTeam + AgentRole[] */
  private planToExecution(plan: GatekeeperPlan, tokensUsed: number): GatekeeperResult {
    const dynamicRoles: AgentRole[] = [];

    for (const rp of plan.roles) {
      // Built-in role
      const builtin = BUILTIN_ROLES[rp.roleId];
      if (builtin) {
        dynamicRoles.push({
          ...builtin,
          model: rp.model ?? builtin.model,
          maxIterations: rp.maxIterations ?? builtin.maxIterations,
          allowedTools: rp.allowedTools.length > 0 ? rp.allowedTools : builtin.allowedTools,
        });
        continue;
      }

      // Template role
      const template = ROLE_TEMPLATES[rp.roleId];
      if (template) {
        dynamicRoles.push({
          id: rp.roleId,
          name: rp.name || template.name,
          description: rp.description || template.description,
          systemPrompt: rp.systemPrompt || template.systemPrompt,
          allowedTools: rp.allowedTools.length > 0 ? rp.allowedTools : template.allowedTools,
          phase: rp.phase ?? template.phase,
          model: rp.model,
          maxIterations: rp.maxIterations ?? template.maxIterations,
        });
        continue;
      }

      // Fully custom role — generate default systemPrompt if missing
      const customPrompt = rp.systemPrompt ||
        `You are the ${rp.name} agent in the BeerCan system.\n\nRole: ${rp.description || rp.name}\nPhase: ${rp.phase}\n\nDo your best work. Use all available tools. Be thorough and deliver high-quality results.`;
      dynamicRoles.push({
        id: rp.roleId,
        name: rp.name,
        description: rp.description,
        systemPrompt: customPrompt,
        allowedTools: rp.allowedTools,
        phase: rp.phase,
        model: rp.model,
        maxIterations: rp.maxIterations,
      });
    }

    const team: BloopTeam = {
      pipeline: plan.pipeline.map((s) => ({
        phase: s.phase,
        roleId: s.roleId,
        canReject: s.canReject,
        rejectTo: s.rejectTo,
      })),
      maxCycles: plan.maxCycles,
    };

    return { team, dynamicRoles, plan, tokensUsed };
  }

  /** Build the gatekeeper system prompt. */
  private buildPrompt(options: { goal: string; project: Project; memoryContext?: string; availableTools?: string[] }): string {
    const config = getConfig();

    const parts: string[] = [
      `You are a Gatekeeper for the BeerCan autonomous agent system. Analyze the goal and compose the optimal team of agents and execution pipeline.`,
      ``,
      `## Available Models`,
      `- claude-haiku-4-5-20251001 — Fast, cheap ($1/$5 per MTok). Simple tasks, summaries, data processing.`,
      `- claude-sonnet-4-6 — Balanced ($3/$15 per MTok). Most coding, writing, analysis. 1M context.`,
      `- claude-opus-4-6 — Most intelligent ($5/$25 per MTok). Complex architecture, agents, nuanced review. 1M context.`,
      ``,
      `## Built-in Roles`,
      ...Object.entries(BUILTIN_ROLES).map(([id, r]) =>
        `- **${id}** (${r.phase}): ${r.description}`
      ),
      ``,
      `## Template Roles (for non-coding tasks)`,
      ...Object.entries(ROLE_TEMPLATES).map(([id, r]) =>
        `- **${id}** (${r.phase}): ${r.description}`
      ),
      ``,
      `## Available Tools`,
      `Filesystem: read_file, write_file, list_directory, exec_command`,
      `Memory: memory_search, memory_store, memory_update, memory_link, memory_query_graph, memory_scratch`,
      ``,
      `## Rules`,
      `1. Match team to the goal — don't over-engineer simple tasks.`,
      `2. A solo agent is often best for simple goals.`,
      `3. Use review stages only when quality matters.`,
      `4. Pick the cheapest model that can do the job.`,
      `5. Every pipeline roleId MUST have a matching roles entry.`,
      `6. For built-in/template roles, you may omit systemPrompt.`,
      `7. For custom roles, you MUST provide a systemPrompt.`,
      `8. maxCycles: 1 for simple, 2 for medium, 3 for complex with review.`,
      `9. Review stages that reject should have canReject: true and rejectTo.`,
      `10. IMPORTANT: Include web_fetch and http_request in allowedTools for ANY role that needs to access the internet, search the web, or fetch external data. The system HAS live internet access.`,
    ];

    if (options.project.description || Object.keys(options.project.context).length > 0) {
      parts.push(``, `## Project: ${options.project.name}`);
      if (options.project.description) parts.push(options.project.description);
      if (Object.keys(options.project.context).length > 0) {
        parts.push(`Context: ${JSON.stringify(options.project.context, null, 2)}`);
      }
    }

    if (options.memoryContext) {
      parts.push(``, `## Past Patterns`, options.memoryContext);
    }

    if (options.availableTools && options.availableTools.length > 0) {
      parts.push(``, `## Available Tools in This System`, `All registered tools: ${options.availableTools.join(", ")}`, `Include relevant tools in each role's allowedTools. Use ["*"] to give a role access to all tools.`);
    }

    return parts.join("\n");
  }
}
