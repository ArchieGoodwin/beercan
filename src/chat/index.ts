import Anthropic from "@anthropic-ai/sdk";
import type { BeerCanEngine } from "../index.js";
import type { ChatProvider, ChatMessage, ChatIntent } from "./types.js";
import { parseIntent } from "./intent.js";
import {
  formatBloopEvent,
  formatBloopResult,
  formatStatus,
  formatProjects,
  formatHistory,
  formatHelp,
} from "./formatter.js";
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
        case "help":
          await this.handleHelp(provider, msg);
          break;
        case "conversation":
          await provider.sendMessage(msg.channelId, intent.text, { replyTo: msg.id });
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
      `Starting bloop on \`${intent.projectSlug}\`...\nGoal: ${intent.goal}`,
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

      // Send the final formatted result
      await provider.sendMessage(
        msg.channelId,
        formatBloopResult(bloop),
        { format: "markdown" },
      );
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

    await provider.sendMessage(
      msg.channelId,
      formatHistory(bloops),
      { format: "markdown", replyTo: msg.id },
    );
  }

  private async handleBloopResult(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "bloop_result" }>,
  ): Promise<void> {
    const bloop = this.engine.getBloop(intent.bloopId);

    if (!bloop) {
      await provider.sendMessage(
        msg.channelId,
        `Bloop not found: \`${intent.bloopId}\``,
        { replyTo: msg.id },
      );
      return;
    }

    // Update context
    this.channelContexts.set(msg.channelId, {
      ...this.channelContexts.get(msg.channelId),
      lastBloopId: bloop.id,
    });

    await provider.sendMessage(
      msg.channelId,
      formatBloopResult(bloop),
      { format: "markdown", replyTo: msg.id },
    );
  }

  private async handleCancelJob(
    provider: ChatProvider,
    msg: ChatMessage,
    intent: Extract<ChatIntent, { type: "cancel_job" }>,
  ): Promise<void> {
    const result = this.engine.getJobQueue().cancelJob(intent.jobId);

    if (result.cancelled) {
      await provider.sendMessage(
        msg.channelId,
        `Job \`${intent.jobId}\` cancelled.`,
        { replyTo: msg.id },
      );
    } else {
      await provider.sendMessage(
        msg.channelId,
        `Could not cancel job \`${intent.jobId}\`: ${result.reason}`,
        { replyTo: msg.id },
      );
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
        `Project \`${slug}\` already exists, monkey. Try a different name.`,
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

    let reply = `Oh, the Magnificent Skippy is SO put-upon. Fine. Project **${project.name}** (\`${project.slug}\`) created. Another domain under my glorious rule.`;
    if (intent.workDir) reply += `\nWork dir: \`${intent.workDir}\``;
    reply += `\n\nNow tell me what you need done, monkey. I don't have all day. Well, actually I do. I'm immortal. But still.`;

    await provider.sendMessage(msg.channelId, reply, { format: "markdown", replyTo: msg.id });
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
export {
  formatBloopEvent,
  formatBloopResult,
  formatStatus,
  formatProjects,
  formatHistory,
  formatHelp,
} from "./formatter.js";
