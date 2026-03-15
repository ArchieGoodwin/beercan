import Anthropic from "@anthropic-ai/sdk";
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
    this.providers.push(provider);
  }

  /** Set default project context for a channel (e.g., from CLI arg). */
  setDefaultProject(channelId: string, projectSlug: string): void {
    this.channelContexts.set(channelId, { lastProjectSlug: projectSlug });
    for (const provider of this.providers) {
      this.updateProviderContext(provider, projectSlug);
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
    // Send typing indicator if supported
    if (provider.sendTypingIndicator) {
      await provider.sendTypingIndicator(msg.channelId);
    }

    // Send initial progress message
    const progressMsgId = await provider.sendMessage(
      msg.channelId,
      `${pick("bloop_starting", { project: intent.projectSlug })}\nGoal: ${intent.goal}`,
      { replyTo: msg.id },
    );

    // Batch event updates — edit the progress message at most every 3 seconds
    const eventLines: string[] = [];
    let lastEditTime = Date.now();
    let editPending = false;
    let editTimer: ReturnType<typeof setTimeout> | null = null;

    const flushEdit = async () => {
      editPending = false;
      if (editTimer) {
        clearTimeout(editTimer);
        editTimer = null;
      }
      if (eventLines.length === 0) return;

      // Show last 15 event lines to keep the message manageable
      const display = eventLines.slice(-15).join("\n");
      try {
        await provider.editMessage(msg.channelId, progressMsgId, display);
      } catch {
        // Editing may fail on some providers — silently ignore
      }
      lastEditTime = Date.now();
    };

    const onEvent = (event: BloopEvent) => {
      const line = formatBloopEvent(event);
      if (line == null) return;
      eventLines.push(line);

      const elapsed = Date.now() - lastEditTime;
      if (elapsed >= 3000) {
        // Enough time has passed — flush immediately
        flushEdit();
      } else if (!editPending) {
        // Schedule a flush for the remainder of the 3s window
        editPending = true;
        editTimer = setTimeout(flushEdit, 3000 - elapsed);
      }
    };

    try {
      const bloop = await this.engine.runBloop({
        projectSlug: intent.projectSlug,
        goal: intent.goal,
        team: intent.team,
        onEvent,
      });

      // Clear any pending edit timer
      if (editTimer) clearTimeout(editTimer);

      // Update channel context
      this.channelContexts.set(msg.channelId, {
        ...this.channelContexts.get(msg.channelId),
        lastProjectSlug: intent.projectSlug,
        lastBloopId: bloop.id,
      });
      this.updateProviderContext(provider, intent.projectSlug);

      // Send the final formatted result
      await this.sendWithContext(provider, msg, formatBloopResult(bloop), { format: "markdown" });
    } catch (err: any) {
      if (editTimer) clearTimeout(editTimer);
      await provider.sendMessage(
        msg.channelId,
        `Bloop execution failed: ${err.message}`,
      );
    }
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
    const bloop = this.engine.getBloop(intent.bloopId);

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
