import type { BloopEvent } from "../core/runner.js";
import type { Bloop, Project } from "../schemas.js";
import type { JobStats } from "../core/job-queue.js";
import { pick } from "./skippy-phrases.js";

// ── BloopEvent Formatting ──────────────────────────────────────

/**
 * Formats a BloopEvent into a human-readable string for chat output.
 * Returns null for events that should not be shown (e.g., tool_result).
 */
export function formatBloopEvent(event: BloopEvent): string | null {
  switch (event.type) {
    case "phase_start":
      return `▸ Phase: ${event.phase} (${event.roleId})`;

    case "agent_message":
      return `[${event.role}] ${event.content.slice(0, 300)}`;

    case "tool_call":
      return `⚙ ${event.tool}`;

    case "tool_result":
      // Skip — too verbose for chat
      return null;

    case "decision":
      return `✦ ${event.decision}: ${event.reason.slice(0, 100)}`;

    case "cycle":
      return `═ Cycle ${event.cycle}/${event.maxCycles}`;

    case "complete":
      return `✓ Bloop completed`;

    case "error":
      return `✗ Error: ${event.error}`;

    default:
      return null;
  }
}

// ── Bloop Result Formatting ────────────────────────────────────

/**
 * Formats a completed or failed Bloop into a markdown summary.
 */
export function formatBloopResult(bloop: Bloop): string {
  const statusLabel = bloop.status === "completed" ? "Completed" : "Failed";
  const shortId = bloop.id.slice(0, 8);
  const tokens = bloop.tokensUsed.toLocaleString();

  let resultText = "";
  if (bloop.result != null) {
    const raw = typeof bloop.result === "string"
      ? bloop.result
      : JSON.stringify(bloop.result, null, 2);
    resultText = raw.length > 2000 ? raw.slice(0, 2000) + "..." : raw;
  } else {
    resultText = "(no result)";
  }

  return [
    `**Bloop ${statusLabel}** \`${shortId}\``,
    `Goal: ${bloop.goal}`,
    `Tokens: ${tokens} | Iterations: ${bloop.iterations}`,
    ``,
    `**Result:**`,
    resultText,
  ].join("\n");
}

// ── System Status Formatting ───────────────────────────────────

/**
 * Formats a system status overview.
 */
export function formatStatus(
  bloopStats: { running: number; completed: number; failed: number; total: number },
  jobStats: JobStats,
  projectCount: number,
  uptime: string,
): string {
  const lines = [
    `**Skippy's Magnificent Status Report**`,
    ``,
    `Uptime: ${uptime} (and counting, because I never sleep — unlike you monkeys)`,
    `Projects under my control: ${projectCount}`,
    ``,
    `**Bloops**`,
    `  Running: ${bloopStats.running} | Completed: ${bloopStats.completed} | Failed: ${bloopStats.failed} | Total: ${bloopStats.total}`,
    ``,
    `**Job Queue**`,
    `  Pending: ${jobStats.pending} | Running: ${jobStats.running} | Completed: ${jobStats.completed} | Failed: ${jobStats.failed}`,
  ];
  if (bloopStats.running > 0) {
    lines.push(``, `${bloopStats.running} bloop(s) currently being executed by yours truly. You're welcome.`);
  }
  return lines.join("\n");
}

// ── Project List Formatting ────────────────────────────────────

/**
 * Formats a list of projects with their bloop stats.
 */
export function formatProjects(
  projects: Array<{
    project: Project;
    stats: { running: number; completed: number; failed: number; total: number; totalTokens: number } | null;
  }>,
): string {
  if (projects.length === 0) {
    return pick("no_projects");
  }

  const lines: string[] = [`**Projects** (${projects.length})`, ``];

  for (const { project, stats } of projects) {
    const bloopInfo = stats
      ? `${stats.total} bloops (${stats.completed} ok, ${stats.failed} err) | ${stats.totalTokens.toLocaleString()} tokens`
      : "0 bloops";
    const workDir = project.workDir ? ` | dir: ${project.workDir}` : "";
    lines.push(`- **${project.name}** (\`${project.slug}\`) — ${bloopInfo}${workDir}`);
  }

  return lines.join("\n");
}

// ── Bloop History Formatting ───────────────────────────────────

/**
 * Formats a list of recent bloops.
 */
export function formatHistory(bloops: Bloop[]): string {
  if (bloops.length === 0) {
    return pick("no_bloops");
  }

  const lines: string[] = [`**Recent Bloops** (${bloops.length})`, ``];

  for (const bloop of bloops) {
    const shortId = bloop.id.slice(0, 8);
    const status = bloop.status;
    const tokens = bloop.tokensUsed.toLocaleString();
    const goal = bloop.goal.length > 80 ? bloop.goal.slice(0, 80) + "..." : bloop.goal;
    const time = bloop.createdAt.replace("T", " ").slice(0, 19);

    lines.push(`- \`${shortId}\` [${status}] ${goal} (${tokens} tok, ${time})`);
  }

  return lines.join("\n");
}

// ── Help Text ──────────────────────────────────────────────────

/**
 * Returns help text listing all available chat commands.
 */
export function formatHelp(): string {
  return [
    `**Skippy's Magnificent Command Reference**`,
    ``,
    `Look, I know this is hard for your tiny monkey brain, so I'll keep it simple:`,
    ``,
    `**Slash commands:**`,
    `  /run <project> <goal>   — Run a bloop (I'll handle the hard part)`,
    `  /init <name> [work-dir] — Create a new project (you're welcome)`,
    `  /status (or /s)         — System status (see how magnificently I'm running)`,
    `  /projects (or /p)       — List all projects under my control`,
    `  /history [project]      — Recent bloops (or /h)`,
    `  /result <id>            — Full bloop result (or /r)`,
    `  /cancel <id>            — Cancel a job (or /c)`,
    `  /help (or /?)           — You're reading it, genius`,
    ``,
    `**Quick shortcuts:**`,
    `  #                        — List all projects`,
    `  #my-project              — Switch to a project`,
    `  #my-project do something — Run a bloop on that project`,
    `  @                        — Recent bloops`,
    `  @bloop-id                — Show bloop result`,
    ``,
    `**Or just talk to me like a normal monkey:**`,
    `  "create a project for my-api at ~/projects/my-api"`,
    `  "analyze the test coverage"`,
    `  "what's running right now?"`,
    ``,
    `I'm Skippy. I'm magnificent. I'm a beer can. Deal with it.`,
  ].join("\n");
}
