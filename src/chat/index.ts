import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import type { BeerCanEngine } from "../index.js";
import type { ChatProvider, ChatMessage, ChatIntent, SendOpts } from "./types.js";
import { parseIntent } from "./intent.js";
import {
  formatBloopEvent,
  formatBloopResult,
  formatStatus,
  formatProjects,
  formatHistory,
  formatHelp,
} from "./formatter.js";
import { pick } from "./skippy-phrases.js";
import type { BloopEvent } from "../core/runner.js";

// ── Channel Context ────────────────────────────────────────────

interface ChannelContext {
  lastProjectSlug?: string;
  lastBloopId?: string;
}

// ── ChatBridge ─────────────────────────────────────────────────
// Connects chat providers to the BeerCan engine.
// Routes messages through intent parsing and dispatches to handlers.

export class ChatBridge {
  private engine: BeerCanEngine;
  private client: Anthropic;
  private providers: ChatProvider[] = [];
  private channelContexts = new Map<string, ChannelContext>();
  private chatInitiatedBloops = new Set<string>();
  private startTime = Date.now();

  constructor(engine: BeerCanEngine, client: Anthropic) {
    this.engine = engine;
    this.client = client;
  }

  /** Register a chat provider and wire up message handling. */
  addProvider(provider: ChatProvider): void {
    provider.onMessage(async (msg) => {
      await this.handleMessage(provider, msg);
    });

    // Set up tab-completion for terminal providers
    if ("setCompleter" in provider && typeof (provider as any).setCompleter === "function") {
      (provider as any).setCompleter((line: string) => this.complete(line));
    }

    this.providers.push(provider);
  }

  /** Set default project context for a channel (e.g., from CLI arg). */
  setDefaultProject(channelId: string, projectSlug: string): void {
    this.channelContexts.set(channelId, { lastProjectSlug: projectSlug });
    for (const provider of this.providers) {
      this.updateProviderContext(provider, projectSlug);
    }
  }

  /** Subscribe to bloop completion events and deliver results to all chat providers. */
  subscribeToBloopEvents(eventBus: any): void {
    eventBus.subscribe("bloop:completed", (event: any) => {
      this.deliverBloopResult(event.data);
    });
    eventBus.subscribe("bloop:failed", (event: any) => {
      this.deliverBloopResult(event.data);
    });
  }

  private async deliverBloopResult(data: { bloopId: string; goal: string; status: string; tokensUsed: number }): Promise<void> {
    // Skip if this bloop was started from chat — it already got delivered via .then()
    if (this.chatInitiatedBloops.has(data.bloopId)) {
      this.chatInitiatedBloops.delete(data.bloopId);
      return;
    }

    const bloop = this.engine.getBloop(data.bloopId);
    if (!bloop) return;

    const result = `${pick(bloop.status === "completed" ? "bloop_completed" : "bloop_failed")}\n${formatBloopResult(bloop)}`;

    // Deliver to all active providers
    for (const provider of this.providers) {
      try {
        // For Telegram/Slack: send to all known channels
        // For terminal: send to "terminal" channel
        const channelId = provider.name === "terminal" ? "terminal" : data.bloopId;

        // Find the channel from context — use any channel that has this project
        for (const [chId, ctx] of this.channelContexts) {
          await provider.sendMessage(chId, result, { format: "markdown" });
          break; // Send to first known channel
        }

        // If no channel context, try a default broadcast
        if (this.channelContexts.size === 0 && provider.name === "terminal") {
          await provider.sendMessage("terminal", result, { format: "markdown" });
        }
      } catch {
        // Silent — provider might not be connected
      }
    }
  }

  /** Start all registered providers. */
  async start(): Promise<void> {
    for (const provider of this.providers) {
      await provider.start();
    }
  }

  /** Stop all registered providers. */
  async stop(): Promise<void> {
    for (const provider of this.providers) {
      await provider.stop();
    }
  }

  // ── Message Handler ────────────────────────────────────────

  private async handleMessage(provider: ChatProvider, msg: ChatMessage): Promise<void> {
    const ctx = this.channelContexts.get(msg.channelId) ?? {};
    let intent: ChatIntent;

    try {
      intent = await parseIntent(this.client, msg.text, ctx, this.engine);
    } catch (err: any) {
      await provider.sendMessage(
        msg.channelId,
        `Failed to parse intent: ${err.message}`,
        { replyTo: msg.id },
      );
      return;
    }

    try {
      switch (intent.type) {
        case "run_bloop":
          await this.handleRunBloop(provider, msg, intent);
          break;
        case "check_status":
          await this.handleCheckStatus(provider, msg);
          break;
        case "list_projects":
          await this.handleListProjects(provider, msg);
          break;
        case "bloop_history":
          await this.handleBloopHistory(provider, msg, intent);
          break;
        case "bloop_result":
          await this.handleBloopResult(provider, msg, intent);
          break;
        case "cancel_job":
          await this.handleCancelJob(provider, msg, intent);
          break;
        case "create_project":
          await this.handleCreateProject(provider, msg, intent);
          break;
        case "switch_project":
          await this.handleSwitchProject(provider, msg, intent);
          break;
        case "add_schedule":
          await this.handleAddSchedule(provider, msg, intent);
          break;
        case "list_schedules":
          await this.handleListSchedules(provider, msg, intent);
          break;
        case "list_skills":
          await this.handleListSkills(provider, msg);
          break;
        case "help":
          await this.handleHelp(provider, msg);
          break;
        case "conversation":
          await this.sendWithContext(provider, msg, intent.text);
          break;
      }
    } catch (err: any) {
      await provider.sendMessage(
        msg.channelId,
        `Error handling request: ${err.message}`,
        { replyTo: msg.id },
      );
    }
  }

  // ── Intent Handlers ────────────────────────────────────────

  private async handleRunBloop(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "run_bloop" }>,
  ): Promise<void> {
    // Send initial message
    await provider.sendMessage(
      msg.channelId,
      `${pick("bloop_starting", { project: intent.projectSlug })}\nGoal: ${intent.goal}`,
      { replyTo: msg.id },
    );

    // Update context immediately
    this.channelContexts.set(msg.channelId, {
      ...this.channelContexts.get(msg.channelId),
      lastProjectSlug: intent.projectSlug,
    });
    this.updateProviderContext(provider, intent.projectSlug);

    // Track active bloop in prompt
    this.notifyBloopState(provider, "start");

    // Run bloop in background — don't block chat
    // Only show major events (phases, decisions) — skip noisy tool calls
    const channelId = msg.channelId;
    this.engine.runBloop({
      projectSlug: intent.projectSlug,
      goal: intent.goal,
      team: intent.team,
      onEvent: (event: BloopEvent) => {
        // Only show high-level events in background mode
        if (event.type === "tool_call" || event.type === "tool_result" || event.type === "agent_message") return;
        const line = formatBloopEvent(event);
        if (line) {
          provider.sendMessage(channelId, chalk.dim(`  ${line}`)).catch(() => {});
        }
      },
    }).then(async (bloop) => {
      this.chatInitiatedBloops.add(bloop.id); // Prevent duplicate from EventBus
      this.notifyBloopState(provider, "end");
      this.channelContexts.set(channelId, {
        ...this.channelContexts.get(channelId),
        lastBloopId: bloop.id,
      });
      await this.sendWithContext(provider, msg, `\n${pick("bloop_completed")}\n${formatBloopResult(bloop)}`, { format: "markdown" });
    }).catch(async (err: any) => {
      this.notifyBloopState(provider, "end");
      await provider.sendMessage(channelId, `${pick("bloop_failed")}\n${err.message}`);
    });
  }

  private async handleCheckStatus(
    provider: ChatProvider,
    msg: ChatMessage,
  ): Promise<void> {
    const bloopStats = this.engine.getBloopStats();
    const jobStats = this.engine.getJobQueue().getStats();
    const projects = this.engine.listProjects();
    const uptime = formatUptime(Date.now() - this.startTime);

    await provider.sendMessage(
      msg.channelId,
      formatStatus(bloopStats, jobStats, projects.length, uptime),
      { format: "markdown", replyTo: msg.id },
    );
  }

  private async handleListProjects(
    provider: ChatProvider,
    msg: ChatMessage,
  ): Promise<void> {
    const projects = this.engine.listProjects();
    const projectsWithStats = projects.map((project) => ({
      project,
      stats: this.engine.getProjectBloopStats(project.slug),
    }));

    await provider.sendMessage(
      msg.channelId,
      formatProjects(projectsWithStats),
      { format: "markdown", replyTo: msg.id },
    );
  }

  private async handleBloopHistory(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "bloop_history" }>,
  ): Promise<void> {
    let bloops;

    if (intent.projectSlug) {
      bloops = this.engine.getProjectBloops(intent.projectSlug);
      // Update context
      this.channelContexts.set(msg.channelId, {
        ...this.channelContexts.get(msg.channelId),
        lastProjectSlug: intent.projectSlug,
      });
    } else {
      bloops = this.engine.getRecentBloops(20);
    }

    await this.sendWithContext(provider, msg, formatHistory(bloops), { format: "markdown" });
  }

  private async handleBloopResult(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "bloop_result" }>,
  ): Promise<void> {
    // Support partial ID matching (e.g., "a3ebfc4b" instead of full UUID)
    let bloop = this.engine.getBloop(intent.bloopId);
    if (!bloop) {
      for (const p of this.engine.listProjects()) {
        const match = this.engine.getProjectBloops(p.slug).find((b) => b.id.startsWith(intent.bloopId));
        if (match) { bloop = match; break; }
      }
    }

    if (!bloop) {
      await this.sendWithContext(provider, msg, pick("not_found"));
      return;
    }

    // Update context
    this.channelContexts.set(msg.channelId, {
      ...this.channelContexts.get(msg.channelId),
      lastBloopId: bloop.id,
    });

    await this.sendWithContext(provider, msg, formatBloopResult(bloop), { format: "markdown" });
  }

  private async handleCancelJob(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "cancel_job" }>,
  ): Promise<void> {
    const result = this.engine.getJobQueue().cancelJob(intent.jobId);

    if (result.cancelled) {
      await this.sendWithContext(provider, msg, pick("cancel_success", { id: intent.jobId }));
    } else {
      await this.sendWithContext(provider, msg, pick("cancel_failed", { id: intent.jobId, reason: result.reason ?? "unknown" }));
    }
  }

  private async handleCreateProject(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "create_project" }>,
  ): Promise<void> {
    const slug = intent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const existing = this.engine.getProject(slug);
    if (existing) {
      await provider.sendMessage(
        msg.channelId,
        pick("project_exists", { slug }),
        { replyTo: msg.id },
      );
      return;
    }

    const project = this.engine.createProject({
      name: intent.name,
      slug,
      workDir: intent.workDir,
    });

    // Set as current context
    this.channelContexts.set(msg.channelId, {
      ...this.channelContexts.get(msg.channelId),
      lastProjectSlug: project.slug,
    });
    this.updateProviderContext(provider, project.slug);

    let reply = pick("project_created", { project: `${project.name}** (\`${project.slug}\`` });
    if (intent.workDir) reply += `\nWork dir: \`${intent.workDir}\``;
    reply += `\n\n${pick("project_created_followup")}`;

    await provider.sendMessage(msg.channelId, reply, { format: "markdown", replyTo: msg.id });
  }

  private async handleSwitchProject(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "switch_project" }>,
  ): Promise<void> {
    // ## → exit to system level
    if (!intent.projectSlug) {
      this.channelContexts.set(msg.channelId, {
        ...this.channelContexts.get(msg.channelId),
        lastProjectSlug: undefined,
      });
      this.updateProviderContext(provider, null);
      await provider.sendMessage(msg.channelId, pick("exit_project"), { replyTo: msg.id });
      return;
    }

    const project = this.engine.getProject(intent.projectSlug);
    if (!project) {
      await provider.sendMessage(msg.channelId, `Project \`${intent.projectSlug}\` not found.`, { replyTo: msg.id });
      return;
    }

    this.channelContexts.set(msg.channelId, {
      ...this.channelContexts.get(msg.channelId),
      lastProjectSlug: intent.projectSlug,
    });

    this.updateProviderContext(provider, intent.projectSlug);

    const stats = this.engine.getProjectBloopStats(intent.projectSlug);
    const bloopInfo = stats
      ? `${stats.total} bloops (${stats.completed} completed, ${stats.failed} failed)`
      : "no bloops yet";

    await provider.sendMessage(
      msg.channelId,
      `Switched to **${project.name}** (\`${project.slug}\`). ${bloopInfo}.${project.workDir ? `\nWork dir: \`${project.workDir}\`` : ""}`,
      { format: "markdown", replyTo: msg.id },
    );
  }

  /** Update provider prompt to show current project (terminal only). */
  /** Tab-completion for terminal. */
  private complete(line: string): [string[], string] {
    // # → project slugs
    if (line.startsWith("#")) {
      const partial = line.slice(1);
      const slugs = this.engine.listProjects().map((p) => `#${p.slug}`);
      if (!partial) return [["##", ...slugs], line];
      const matches = slugs.filter((s) => s.startsWith(`#${partial}`));
      return [matches.length ? matches : slugs, line];
    }

    // @ → recent bloop IDs
    if (line.startsWith("@")) {
      const partial = line.slice(1);
      const ids = this.engine.getRecentBloops(10).map((b) => `@${b.id.slice(0, 8)}`);
      if (!partial) return [ids, line];
      const matches = ids.filter((id) => id.startsWith(`@${partial}`));
      return [matches.length ? matches : ids, line];
    }

    // / → slash commands
    if (line.startsWith("/")) {
      const commands = ["/run", "/init", "/status", "/projects", "/history", "/result", "/cancel", "/help"];
      const matches = commands.filter((c) => c.startsWith(line));
      return [matches.length ? matches : commands, line];
    }

    return [[], line];
  }

  /** Notify provider of bloop start/end for prompt indicator. */
  private notifyBloopState(provider: ChatProvider, state: "start" | "end"): void {
    if ("bloopStarted" in provider && typeof (provider as any).bloopStarted === "function") {
      if (state === "start") (provider as any).bloopStarted();
      else (provider as any).bloopFinished();
    }
  }

  private updateProviderContext(provider: ChatProvider, projectSlug: string | null): void {
    if ("setProjectContext" in provider && typeof (provider as any).setProjectContext === "function") {
      (provider as any).setProjectContext(projectSlug);
    }
  }

  /** Send a message with project context badge for non-terminal providers. */
  private async sendWithContext(
    provider: ChatProvider,
    msg: ChatMessage,
    text: string,
    opts?: SendOpts,
  ): Promise<string> {
    const ctx = this.channelContexts.get(msg.channelId);
    const hasPrompt = "setProjectContext" in provider; // terminal has it
    if (!hasPrompt && ctx?.lastProjectSlug) {
      text = `\`[${ctx.lastProjectSlug}]\` ${text}`;
    }
    return provider.sendMessage(msg.channelId, text, { ...opts, replyTo: opts?.replyTo ?? msg.id });
  }

  private async handleAddSchedule(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "add_schedule" }>,
  ): Promise<void> {
    const project = this.engine.getProject(intent.projectSlug);
    if (!project) {
      await this.sendWithContext(provider, msg, pick("not_found"));
      return;
    }

    try {
      const schedule = this.engine.getScheduler().addSchedule({
        projectId: project.id,
        projectSlug: intent.projectSlug,
        cronExpression: intent.cron,
        goal: intent.goal,
        description: intent.goal.slice(0, 80),
      });

      await this.sendWithContext(provider, msg,
        `Scheduled! The Magnificent Skippy will handle this automatically.\n\n` +
        `**Schedule** \`${schedule.id.slice(0, 8)}\`\n` +
        `Cron: \`${intent.cron}\`\n` +
        `Project: ${intent.projectSlug}\n` +
        `Goal: ${intent.goal}\n\n` +
        `The schedule is active. Skippy will execute this automatically at the scheduled time.\n` +
        `Use \`/schedule list\` to see all schedules. Make sure \`beercan start\` is running for daemon mode.`,
        { format: "markdown" }
      );
    } catch (err: any) {
      await this.sendWithContext(provider, msg, `Failed to create schedule: ${err.message}`);
    }
  }

  private async handleListSchedules(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "list_schedules" }>,
  ): Promise<void> {
    const schedules = this.engine.getScheduler().listSchedules(intent.projectSlug);
    if (schedules.length === 0) {
      await this.sendWithContext(provider, msg, "No schedules found. Set one up with: \"schedule daily at 9am: fetch AI news\"");
      return;
    }

    const lines = [`**Schedules** (${schedules.length})`, ""];
    for (const s of schedules) {
      const status = s.enabled ? "●" : "○";
      lines.push(`${status} \`${s.cronExpression}\` — ${s.goal.slice(0, 60)}`);
      lines.push(`  Project: ${s.projectSlug} | Last: ${s.lastRunAt ?? "never"} | ID: \`${s.id.slice(0, 8)}\``);
    }
    await this.sendWithContext(provider, msg, lines.join("\n"), { format: "markdown" });
  }

  private async handleListSkills(
    provider: ChatProvider,
    msg: ChatMessage,
  ): Promise<void> {
    const skills = this.engine.getSkillManager().listSkills();
    if (skills.length === 0) {
      await this.sendWithContext(provider, msg, "No skills installed. Create one with `beercan skill:create <name>` and drop it in `~/.beercan/skills/`.");
      return;
    }

    const lines = [`**Skills** (${skills.length})`, ""];
    for (const s of skills) {
      const status = s.enabled ? "●" : "○";
      lines.push(`${status} **${s.name}** — ${s.description}`);
      lines.push(`  Triggers: ${s.triggers.join(", ")}`);
      if (s.requiredTools.length > 0) lines.push(`  Tools: ${s.requiredTools.join(", ")}`);
    }
    await this.sendWithContext(provider, msg, lines.join("\n"), { format: "markdown" });
  }

  private async handleHelp(
    provider: ChatProvider,
    msg: ChatMessage,
  ): Promise<void> {
    await provider.sendMessage(
      msg.channelId,
      formatHelp(),
      { format: "markdown", replyTo: msg.id },
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ── Re-exports ──────────────────────────────────────────────

export type { ChatProvider, ChatMessage, ChatIntent, SendOpts } from "./types.js";
export { parseIntent } from "./intent.js";
export { SKIPPY_SYSTEM_PROMPT, SKIPPY_INTENT_PROMPT } from "./skippy.js";
export { pick, addPhrases, setPhrases, listCategories, getPhrases } from "./skippy-phrases.js";
export {
  formatBloopEvent,
  formatBloopResult,
  formatStatus,
  formatProjects,
  formatHistory,
  formatHelp,
} from "./formatter.js";
