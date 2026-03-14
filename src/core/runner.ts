import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuid } from "uuid";
import { getConfig } from "../config.js";
import { createAnthropicClient } from "../client.js";
import { BeerCanDB } from "../storage/database.js";
import { ToolRegistry } from "../tools/registry.js";
import { MemoryManager } from "../memory/index.js";
import type { Bloop, BloopMessage, ToolCallRecord, Project } from "../schemas.js";
import type { AgentRole, BloopTeam } from "./roles.js";
import { BUILTIN_ROLES, PRESET_TEAMS } from "./roles.js";

// ── Types ────────────────────────────────────────────────────

export interface RunBloopOptions {
  project: Project;
  goal: string;
  team?: BloopTeam;
  parentBloopId?: string;
  /** Extra context injected into every agent's system prompt */
  extraContext?: string;
  /** Callback for real-time output */
  onEvent?: (event: BloopEvent) => void;
}

export type BloopEvent =
  | { type: "phase_start"; phase: string; roleId: string }
  | { type: "agent_message"; role: string; content: string }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; output: string }
  | { type: "decision"; decision: string; reason: string }
  | { type: "cycle"; cycle: number; maxCycles: number }
  | { type: "complete"; result: unknown }
  | { type: "error"; error: string };

// ── Bloop Runner ──────────────────────────────────────────────

export class BloopRunner {
  private client: Anthropic;
  private db: BeerCanDB;
  private tools: ToolRegistry;
  private memory: MemoryManager;
  private roles: Map<string, AgentRole>;
  private currentBloopCtx: { bloopId: string; projectId: string; projectSlug: string } | null = null;

  constructor(db: BeerCanDB, tools: ToolRegistry, client: Anthropic, memory: MemoryManager) {
    this.client = client;
    this.db = db;
    this.tools = tools;
    this.memory = memory;

    // Load built-in roles
    this.roles = new Map(Object.entries(BUILTIN_ROLES));
  }

  /** Returns the currently executing bloop context (for memory tools) */
  getCurrentBloopContext(): { bloopId: string; projectId: string; projectSlug: string } | null {
    return this.currentBloopCtx;
  }

  /** Register a custom role */
  registerRole(role: AgentRole): void {
    this.roles.set(role.id, role);
  }

  /** Register multiple roles at once (for gatekeeper dynamic roles) */
  registerRoles(roles: AgentRole[]): void {
    for (const role of roles) {
      this.roles.set(role.id, role);
    }
  }

  /** Unregister a dynamic role by ID (does not remove built-in roles) */
  unregisterRole(roleId: string): void {
    if (BUILTIN_ROLES[roleId]) return;
    this.roles.delete(roleId);
  }

  /** Main entry point — create and run a Bloop */
  async run(options: RunBloopOptions): Promise<Bloop> {
    const { project, goal, parentBloopId, onEvent } = options;
    const team = options.team ?? PRESET_TEAMS.solo;
    const config = getConfig();
    const now = new Date().toISOString();

    // Create the Bloop record
    const bloop: Bloop = {
      id: uuid(),
      projectId: project.id,
      parentBloopId: parentBloopId ?? null,
      trigger: parentBloopId ? "child_of" : "manual",
      status: "running",
      goal,
      messages: [],
      result: null,
      toolCalls: [],
      tokensUsed: 0,
      iterations: 0,
      maxIterations: config.maxBloopIterations,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.db.createBloop(bloop);

    // Set bloop context for memory tools
    this.currentBloopCtx = { bloopId: bloop.id, projectId: project.id, projectSlug: project.slug };

    // Initialize working memory scope
    this.memory.getWorkingMemory().createScope(bloop.id);

    // Retrieve relevant past context from vector memory
    const memoryContext = await this.memory.retrieveContext(project.slug, goal, 5);
    if (memoryContext) {
      options = {
        ...options,
        extraContext: (options.extraContext ?? "") + memoryContext,
      };
    }

    try {
      const result = await this.executePipeline(bloop, project, team, options);
      bloop.status = "completed";
      bloop.result = result;
      bloop.completedAt = new Date().toISOString();
      bloop.updatedAt = new Date().toISOString();
      this.db.updateBloop(bloop);

      // Store result in vector memory for future retrieval
      await this.memory.storeBloopResult(bloop, project.slug);

      onEvent?.({ type: "complete", result });
      return bloop;
    } catch (err: any) {
      bloop.status = "failed";
      bloop.result = { error: err.message };
      bloop.updatedAt = new Date().toISOString();
      this.db.updateBloop(bloop);

      onEvent?.({ type: "error", error: err.message });
      return bloop;
    } finally {
      // Clean up working memory and bloop context
      this.memory.getWorkingMemory().cleanup(bloop.id);
      this.currentBloopCtx = null;
    }
  }

  // ── Pipeline Execution ───────────────────────────────────

  private async executePipeline(
    bloop: Bloop,
    project: Project,
    team: BloopTeam,
    options: RunBloopOptions
  ): Promise<unknown> {
    const { onEvent } = options;
    let pipelineContext = ""; // accumulated output passed between phases
    let cycle = 0;

    while (cycle < team.maxCycles) {
      cycle++;
      onEvent?.({ type: "cycle", cycle, maxCycles: team.maxCycles });

      let shouldRestart = false;

      for (const stage of team.pipeline) {
        const role = this.roles.get(stage.roleId);
        if (!role) {
          throw new Error(`Unknown role: ${stage.roleId}. Register it first.`);
        }

        onEvent?.({ type: "phase_start", phase: stage.phase, roleId: stage.roleId });

        const phaseResult = await this.executeAgent(
          bloop,
          project,
          role,
          pipelineContext,
          options
        );

        pipelineContext += `\n\n--- ${role.name} (${stage.phase}) ---\n${phaseResult.content}`;

        // Check for decisions from review/validate phases
        const decision = this.extractDecision(phaseResult.content);
        if (decision) {
          onEvent?.({
            type: "decision",
            decision: decision.verdict,
            reason: decision.reason,
          });

          if (
            decision.verdict === "REJECT" &&
            stage.canReject &&
            stage.rejectTo
          ) {
            // Reset pipeline context and restart from the reject-to phase
            pipelineContext = `REJECTED by ${role.name}: ${decision.reason}\n\nOriginal goal: ${bloop.goal}`;
            shouldRestart = true;
            break;
          }

          if (
            decision.verdict === "REVISE" &&
            stage.canReject &&
            stage.rejectTo
          ) {
            pipelineContext += `\n\nREVISION REQUESTED by ${role.name}: ${decision.reason}`;
            shouldRestart = true;
            break;
          }
        }
      }

      if (!shouldRestart) {
        // Pipeline completed without rejection
        return {
          summary: pipelineContext,
          cycles: cycle,
        };
      }
    }

    // Exhausted max cycles
    return {
      summary: pipelineContext,
      cycles: cycle,
      warning: "Max pipeline cycles reached",
    };
  }

  // ── Single Agent Execution ───────────────────────────────

  private async executeAgent(
    bloop: Bloop,
    project: Project,
    role: AgentRole,
    pipelineContext: string,
    options: RunBloopOptions
  ): Promise<{ content: string }> {
    const config = getConfig();
    const model = role.model ?? config.defaultModel;

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(
      role,
      project,
      bloop.goal,
      pipelineContext,
      options.extraContext
    );

    // Resolve allowed tools for this role within this project
    const roleTools = this.resolveTools(role.allowedTools, project.allowedTools);
    const anthropicTools = this.tools.toAnthropicTools(roleTools);

    // Agent conversation (local to this phase execution)
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: pipelineContext
          ? `Goal: ${bloop.goal}\n\nContext from previous phases:\n${pipelineContext}`
          : `Goal: ${bloop.goal}`,
      },
    ];

    let iterations = 0;
    let finalContent = "";

    while (iterations < role.maxIterations) {
      iterations++;
      bloop.iterations++;

      const response = await this.client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        messages,
      });

      // Track token usage
      bloop.tokensUsed += (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

      // Process response blocks
      let hasToolUse = false;
      const assistantContent: Anthropic.ContentBlock[] = response.content;
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type === "text") {
          finalContent = block.text;
          options.onEvent?.({
            type: "agent_message",
            role: role.id,
            content: block.text,
          });

          // Store in bloop history
          const msg: BloopMessage = {
            role: "assistant",
            content: `[${role.name}] ${block.text}`,
            timestamp: new Date().toISOString(),
          };
          bloop.messages.push(msg);
        }

        if (block.type === "tool_use") {
          hasToolUse = true;
          options.onEvent?.({
            type: "tool_call",
            tool: block.name,
            input: block.input,
          });

          const start = Date.now();
          const result = await this.tools.execute(
            block.name,
            block.input as Record<string, unknown>
          );
          const durationMs = Date.now() - start;

          const toolRecord: ToolCallRecord = {
            id: block.id,
            toolName: block.name,
            input: block.input,
            output: result.output,
            error: result.error,
            durationMs,
            timestamp: new Date().toISOString(),
          };
          bloop.toolCalls.push(toolRecord);

          const resultText = result.output ?? `ERROR: ${result.error}`;
          options.onEvent?.({
            type: "tool_result",
            tool: block.name,
            output:
              resultText.length > 200
                ? resultText.slice(0, 200) + "..."
                : resultText,
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: resultText,
          });
        }
      }

      // If there were tool calls, feed results back
      if (hasToolUse) {
        messages.push({ role: "assistant", content: assistantContent as any });
        messages.push({ role: "user", content: toolResults });
        // Save progress
        bloop.updatedAt = new Date().toISOString();
        this.db.updateBloop(bloop);
        continue;
      }

      // No tool calls → agent is done with this phase
      if (response.stop_reason === "end_turn") {
        break;
      }
    }

    return { content: finalContent };
  }

  // ── Helpers ──────────────────────────────────────────────

  private buildSystemPrompt(
    role: AgentRole,
    project: Project,
    goal: string,
    pipelineContext: string,
    extraContext?: string
  ): string {
    const parts: string[] = [role.systemPrompt];

    // Inject project context
    if (Object.keys(project.context).length > 0) {
      parts.push(
        `\n--- Project Context (${project.name}) ---\n${JSON.stringify(project.context, null, 2)}`
      );
    }

    if (extraContext) {
      parts.push(`\n--- Additional Context ---\n${extraContext}`);
    }

    const sysLines = [
      `Project: ${project.name}`,
      `Your Role: ${role.name} (${role.id})`,
      `Goal: ${goal}`,
    ];
    if (project.workDir) {
      sysLines.push(`Working Directory: ${project.workDir}`);
      sysLines.push(`IMPORTANT: All file paths should be relative to or within ${project.workDir}. Use this as the cwd for exec_command.`);
    }
    parts.push(`\n--- System Info ---\n${sysLines.join("\n")}`);

    return parts.join("\n");
  }

  private resolveTools(
    roleTools: string[],
    projectTools: string[]
  ): string[] {
    // If either is wildcard, use the other as constraint
    if (roleTools.includes("*") && projectTools.includes("*")) return ["*"];
    if (roleTools.includes("*")) return projectTools;
    if (projectTools.includes("*")) return roleTools;
    // Intersection
    return roleTools.filter((t) => projectTools.includes(t));
  }

  private extractDecision(
    content: string
  ): { verdict: string; reason: string } | null {
    const match = content.match(/<decision>(APPROVE|REVISE|REJECT)<\/decision>/);
    if (!match) return null;

    // Extract reason: everything after the decision tag, or the paragraph before it
    const afterDecision = content.split(match[0])[1]?.trim() || "";
    const beforeDecision = content.split(match[0])[0]?.trim() || "";
    const reason = afterDecision || beforeDecision.split("\n").pop() || "";

    return { verdict: match[1], reason };
  }
}
