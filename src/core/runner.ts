import { v4 as uuid } from "uuid";
import { getConfig } from "../config.js";
import { BeerCanDB } from "../storage/database.js";
import { ToolRegistry } from "../tools/registry.js";
import { MemoryManager } from "../memory/index.js";
import type { Bloop, BloopMessage, ToolCallRecord, Project } from "../schemas.js";
import type { AgentRole, BloopTeam } from "./roles.js";
import { BUILTIN_ROLES, PRESET_TEAMS } from "./roles.js";
import { ReflectionEngine, shouldReflect } from "./reflection.js";
import type {
  LLMProvider, LLMMessage, LLMContentBlock, LLMResponseBlock,
  LLMToolResultBlock,
} from "../providers/types.js";

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
  /** AbortSignal for cancellation/timeout support */
  signal?: AbortSignal;
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
  private provider: LLMProvider;
  private db: BeerCanDB;
  private tools: ToolRegistry;
  private memory: MemoryManager;
  private reflectionEngine: ReflectionEngine | null;
  private roles: Map<string, AgentRole>;
  private currentBloopCtx: { bloopId: string; projectId: string; projectSlug: string } | null = null;

  constructor(db: BeerCanDB, tools: ToolRegistry, provider: LLMProvider, memory: MemoryManager, reflectionEngine?: ReflectionEngine) {
    this.provider = provider;
    this.db = db;
    this.tools = tools;
    this.memory = memory;
    this.reflectionEngine = reflectionEngine ?? null;

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

    // Inject recent bloop history so agents know what happened in this project
    const recentBloops = this.db.getProjectBloops(project.id)
      .slice(0, 5)
      .filter((b) => b.id !== bloop.id);

    if (recentBloops.length > 0) {
      const historyLines = recentBloops.map((b) => {
        const resultStr = b.result
          ? typeof b.result === "string" ? b.result : JSON.stringify(b.result)
          : "";
        // Extract file paths from tool calls for context
        const filePaths = b.toolCalls
          .filter((tc) => tc.toolName === "write_file" || tc.toolName === "read_file")
          .map((tc) => {
            const input = tc.input as Record<string, unknown>;
            return `${tc.toolName}(${input?.path ?? ""})`;
          })
          .filter(Boolean)
          .slice(0, 5);
        const fileInfo = filePaths.length > 0 ? ` | Files: ${filePaths.join(", ")}` : "";
        return `- [${b.status}] ${b.goal.slice(0, 120)} (${b.tokensUsed} tokens${fileInfo})`;
      });
      const historyCtx = `\n--- Recent Project Activity (${project.name}) ---\n${historyLines.join("\n")}`;
      options = {
        ...options,
        extraContext: (options.extraContext ?? "") + historyCtx,
      };
    }

    // Set up timeout + abort
    const timeoutMs = config.bloopTimeoutMs;
    const abortController = new AbortController();
    const externalSignal = options.signal;

    // Link external signal (e.g., from job queue cancellation)
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", () => abortController.abort(externalSignal.reason), { once: true });
      }
    }

    const timeoutId = setTimeout(() => {
      abortController.abort(new Error(`Bloop timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const result = await this.executePipeline(bloop, project, team, options, abortController.signal);
      clearTimeout(timeoutId);
      bloop.status = "completed";
      bloop.result = result;
      bloop.completedAt = new Date().toISOString();
      bloop.updatedAt = new Date().toISOString();
      this.db.updateBloop(bloop);

      // Store result in vector memory for future retrieval
      await this.memory.storeBloopResult(bloop, project.slug);

      // Post-bloop reflection (opt-in, lightweight Haiku call)
      if (this.reflectionEngine && shouldReflect(bloop, project)) {
        try {
          await this.reflectionEngine.reflect(bloop, project.slug);
        } catch (err: any) {
          console.warn(`[reflection] Failed: ${err.message}`);
        }
      }

      onEvent?.({ type: "complete", result });
      return bloop;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (abortController.signal.aborted) {
        bloop.status = "timeout";
        bloop.result = { error: err.message || "Bloop timed out or was cancelled" };
      } else {
        bloop.status = "failed";
        bloop.result = { error: err.message };
      }
      bloop.completedAt = new Date().toISOString();
      bloop.updatedAt = new Date().toISOString();
      this.db.updateBloop(bloop);

      onEvent?.({ type: "error", error: err.message });
      return bloop;
    } finally {
      clearTimeout(timeoutId);
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
    options: RunBloopOptions,
    signal?: AbortSignal
  ): Promise<unknown> {
    const { onEvent } = options;
    let pipelineContext = ""; // accumulated output passed between phases
    let cycle = 0;

    while (cycle < team.maxCycles) {
      if (signal?.aborted) throw new Error(String((signal.reason as any)?.message ?? "Bloop aborted"));
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
          options,
          signal
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
    options: RunBloopOptions,
    signal?: AbortSignal
  ): Promise<{ content: string }> {
    const config = getConfig();
    const model = role.model ?? config.defaultModel;

    // Resolve allowed tools for this role within this project
    const roleTools = this.resolveTools(role.allowedTools, project.allowedTools);
    const llmTools = this.tools.toLLMTools(roleTools);
    const toolNames = roleTools.includes("*") ? this.tools.listToolNames() : roleTools;

    // Build system prompt (with tool awareness)
    const systemPrompt = this.buildSystemPrompt(
      role,
      project,
      bloop.goal,
      pipelineContext,
      options.extraContext,
      toolNames
    );

    // Agent conversation (local to this phase execution)
    const messages: LLMMessage[] = [
      {
        role: "user",
        content: pipelineContext
          ? `Goal: ${bloop.goal}\n\nContext from previous phases:\n${pipelineContext}`
          : `Goal: ${bloop.goal}`,
      },
    ];

    let iterations = 0;
    let finalContent = "";
    // Track consecutive failures per tool for retry-with-different-approach detection
    const consecutiveFailures: Map<string, number> = new Map();
    const REPEATED_FAILURE_THRESHOLD = 3;

    while (iterations < role.maxIterations) {
      if (signal?.aborted) throw new Error(String((signal.reason as any)?.message ?? "Bloop aborted"));
      iterations++;
      bloop.iterations++;

      const response = await this.provider.createMessage({
        model,
        maxTokens: 16384,
        system: systemPrompt,
        messages,
        tools: llmTools.length > 0 ? llmTools : undefined,
      }, { signal });

      // Track token usage
      bloop.tokensUsed += response.usage.inputTokens + response.usage.outputTokens;

      // Process response blocks
      let hasToolUse = false;
      const assistantContent: LLMResponseBlock[] = response.content;
      const toolResults: LLMToolResultBlock[] = [];

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

          // Track consecutive failures per tool
          if (result.error) {
            const count = (consecutiveFailures.get(block.name) ?? 0) + 1;
            consecutiveFailures.set(block.name, count);
          } else {
            consecutiveFailures.set(block.name, 0);
          }

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
            toolUseId: block.id,
            content: resultText,
          });
        }
      }

      // If there were tool calls, feed results back
      if (hasToolUse) {
        messages.push({ role: "assistant", content: assistantContent as LLMContentBlock[] });

        // Check for repeated failures and inject course-correction guidance
        const repeatedTools = [...consecutiveFailures.entries()]
          .filter(([, count]) => count >= REPEATED_FAILURE_THRESHOLD);

        if (repeatedTools.length > 0 && toolResults.length > 0) {
          const toolNamesList = repeatedTools.map(([name, count]) => `${name} (${count}x)`).join(", ");
          const lastResult = toolResults[toolResults.length - 1];
          (lastResult as any).content += `\n\n` +
            `SYSTEM WARNING: The following tools have failed ${REPEATED_FAILURE_THRESHOLD}+ times consecutively: ${toolNamesList}. ` +
            `You MUST change your approach — do NOT retry the same tool call with the same parameters. Consider:\n` +
            `- Breaking the operation into smaller steps\n` +
            `- Using a different tool (e.g., exec_command with echo/printf instead of write_file)\n` +
            `- Simplifying or reducing the size of the data you are passing\n` +
            `- Completing the goal with what you already have rather than retrying\n` +
            `If you cannot accomplish the goal differently, explain what went wrong and stop.`;
        }

        messages.push({ role: "user", content: toolResults as LLMContentBlock[] });
        // Save progress
        bloop.updatedAt = new Date().toISOString();
        this.db.updateBloop(bloop);
        continue;
      }

      // No tool calls → agent is done with this phase
      if (response.stopReason === "end_turn") {
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
    extraContext?: string,
    availableToolNames?: string[]
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

    const now = new Date();
    const sysLines = [
      `Project: ${project.name}`,
      `Your Role: ${role.name} (${role.id})`,
      `Goal: ${goal}`,
      `Current Date/Time: ${now.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}, UTC${now.getTimezoneOffset() <= 0 ? "+" : "-"}${String(Math.floor(Math.abs(now.getTimezoneOffset()) / 60)).padStart(2, "0")}:${String(Math.abs(now.getTimezoneOffset()) % 60).padStart(2, "0")})`,
      `Today: ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    ];
    if (project.workDir) {
      sysLines.push(`Working Directory: ${project.workDir}`);
      sysLines.push(`IMPORTANT: All file paths should be relative to or within ${project.workDir}. Use this as the cwd for exec_command.`);
    }
    parts.push(`\n--- System Info ---\n${sysLines.join("\n")}`);

    // Tell the agent what tools it has — override Claude's training about web access
    if (availableToolNames && availableToolNames.length > 0) {
      const toolList = availableToolNames.join(", ");
      const capabilities: string[] = [];
      const hasWeb = availableToolNames.some((t) => t === "web_fetch" || t === "*");
      const hasHttp = availableToolNames.some((t) => t === "http_request" || t === "*");
      if (hasWeb || hasHttp) {
        capabilities.push(
          "IMPORTANT — INTERNET ACCESS: You HAVE real-time internet access. This is NOT a limitation.",
          "DO NOT say you cannot access the internet or that you lack real-time web access. You CAN and MUST use your web tools when the task requires current information.",
        );
        if (hasWeb) capabilities.push("- web_fetch: Fetch any URL and get its content. Use this to search the web, read news sites, access documentation, etc. Pass URLs like https://news.google.com, https://reuters.com, etc.");
        if (hasHttp) capabilities.push("- http_request: Make full HTTP requests (GET, POST, PUT, DELETE) with headers and body. Use for APIs and web services.");
      }
      if (availableToolNames.some((t) => t === "exec_command" || t === "*")) {
        capabilities.push("- exec_command: Execute shell commands. Use for running scripts, builds, tests, etc.");
        capabilities.push("LARGE FILE WRITING: If you need to write a file >3000 chars, do NOT put all the content in write_file — it will get truncated. " +
          "Instead, use exec_command to run a script (Python/Node) that generates the file. " +
          "Example: write a small .py script with write_file, then exec_command to run it.");
      }
      parts.push(`\n--- Available Tools ---\nTools: ${toolList}\n${capabilities.join("\n")}`);
    }

    return parts.join("\n");
  }

  private static BUILTIN_TOOL_NAMES = new Set([
    "read_file", "write_file", "append_file", "list_directory", "exec_command",
    "web_fetch", "http_request", "send_notification",
    "get_datetime", "get_system_info", "get_network_info", "get_env_info",
    "memory_search", "memory_store", "memory_update", "memory_delete", "memory_link", "memory_query_graph", "memory_scratch",
    "spawn_bloop", "get_bloop_result", "list_child_bloops", "list_projects", "search_cross_project", "search_previous_attempts", "list_jobs",
    "create_schedule", "create_trigger", "list_schedules", "list_triggers", "remove_schedule", "remove_trigger",
    "create_skill", "update_skill", "list_skills", "update_project_context",
    "register_tool_from_file", "register_skill_from_bloop", "verify_and_integrate",
  ]);

  private resolveTools(
    roleTools: string[],
    projectTools: string[]
  ): string[] {
    // If either is wildcard, use the other as constraint
    if (roleTools.includes("*") && projectTools.includes("*")) return ["*"];
    if (roleTools.includes("*")) return projectTools;
    if (projectTools.includes("*")) {
      // Append custom (non-builtin) tools so they're always available
      const customTools = this.tools.listToolNames().filter((t) => !BloopRunner.BUILTIN_TOOL_NAMES.has(t));
      return [...new Set([...roleTools, ...customTools])];
    }
    // Intersection + custom tools that are in project's allowed list
    const base = roleTools.filter((t) => projectTools.includes(t));
    const customTools = this.tools.listToolNames().filter((t) => !BloopRunner.BUILTIN_TOOL_NAMES.has(t) && projectTools.includes(t));
    return [...new Set([...base, ...customTools])];
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
