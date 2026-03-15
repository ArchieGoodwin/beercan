#!/usr/bin/env node
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { BeerCanEngine, PRESET_TEAMS } from "./index.js";
import { getProjectDir } from "./config.js";
import { startDaemon } from "./events/daemon.js";
import type { BloopEvent } from "./index.js";

// ── Event Logger ─────────────────────────────────────────────

function logEvent(event: BloopEvent): void {
  switch (event.type) {
    case "cycle":
      console.log(
        chalk.dim(`\n${"═".repeat(60)}\n`) +
        chalk.bold.cyan(`  Pipeline Cycle ${event.cycle}/${event.maxCycles}`) +
        chalk.dim(`\n${"═".repeat(60)}`)
      );
      break;

    case "phase_start":
      console.log(
        chalk.yellow(`\n▸ Phase: ${event.phase}`) +
        chalk.dim(` (${event.roleId})`)
      );
      break;

    case "agent_message":
      const lines = event.content.split("\n");
      const preview = lines.slice(0, 10).join("\n");
      const tag = chalk.bold.magenta(`[${event.role}]`);
      console.log(`${tag} ${preview}`);
      if (lines.length > 10) {
        console.log(chalk.dim(`  ... ${lines.length - 10} more lines`));
      }
      break;

    case "tool_call":
      console.log(
        chalk.blue(`  ⚙ ${event.tool}`) +
        chalk.dim(` ${JSON.stringify(event.input).slice(0, 100)}`)
      );
      break;

    case "tool_result":
      console.log(chalk.dim(`    → ${event.output.slice(0, 120)}`));
      break;

    case "decision":
      const color =
        event.decision === "APPROVE"
          ? chalk.green
          : event.decision === "REVISE"
            ? chalk.yellow
            : chalk.red;
      console.log(color(`\n  ✦ Decision: ${event.decision}`));
      if (event.reason) {
        console.log(chalk.dim(`    ${event.reason.slice(0, 200)}`));
      }
      break;

    case "complete":
      console.log(chalk.bold.green("\n✓ Bloop completed successfully."));
      break;

    case "error":
      console.log(chalk.bold.red(`\n✗ Bloop failed: ${event.error}`));
      break;
  }
}

// ── CLI Commands ─────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const engine = await new BeerCanEngine().init();

  try {
    switch (command) {
      // ── Project Management ──────────────────────────────────

      case "init": {
        const name = args[1] || "my-project";
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const existing = engine.getProject(slug);
        if (existing) {
          console.log(chalk.yellow(`Project "${slug}" already exists.`));
          break;
        }
        // Parse --work-dir flag
        const wdIdx = args.indexOf("--work-dir");
        const workDir = wdIdx >= 0 ? args[wdIdx + 1] : undefined;

        const project = engine.createProject({ name, slug, workDir });
        console.log(chalk.green(`✓ Created project: ${project.name} (${project.slug})`));
        console.log(chalk.dim(`  ID: ${project.id}`));
        if (workDir) console.log(chalk.dim(`  Work dir: ${workDir}`));
        break;
      }

      case "projects": {
        const projects = engine.listProjects();
        if (projects.length === 0) {
          console.log(chalk.dim("No projects yet. Run: beercan init <name>"));
          break;
        }
        for (const p of projects) {
          console.log(
            chalk.bold(p.name) +
            chalk.dim(` (${p.slug})`) +
            chalk.dim(` — ${p.description ?? "no description"}`)
          );
        }
        break;
      }

      // ── Bloop Execution ──────────────────────────────────────

      case "run": {
        const projectSlug = args[1];
        const teamName = args[2] || "auto";
        const goal = args.slice(3).join(" ");

        if (!projectSlug || !goal) {
          console.log(
            chalk.red("Usage: beercan run <project-slug> [team] <goal>")
          );
          console.log(chalk.dim("Teams: auto, solo, code_review, full_team, managed"));
          console.log(
            chalk.dim('Example: beercan run my-project "Add user auth to the API"')
          );
          break;
        }

        if (teamName !== "auto") {
          const team = PRESET_TEAMS[teamName];
          if (!team) {
            console.log(chalk.red(`Unknown team: ${teamName}`));
            console.log(chalk.dim(`Available: auto, ${Object.keys(PRESET_TEAMS).join(", ")}`));
            break;
          }
        }

        console.log(chalk.bold(`\nStarting Bloop`));
        console.log(chalk.dim(`  Project: ${projectSlug}`));
        console.log(chalk.dim(`  Team:    ${teamName}${teamName === "auto" ? " (gatekeeper will decide)" : ""}`));
        console.log(chalk.dim(`  Goal:    ${goal}\n`));

        const bloop = await engine.runBloop({
          projectSlug,
          goal,
          team: teamName,
          onEvent: logEvent,
        });

        console.log(chalk.dim(`\nBloop ID: ${bloop.id}`));
        console.log(chalk.dim(`Status:  ${bloop.status}`));
        console.log(chalk.dim(`Tokens:  ${bloop.tokensUsed.toLocaleString()}`));
        console.log(chalk.dim(`Iterations: ${bloop.iterations}`));
        break;
      }

      case "bootstrap": {
        const slug = "beercan-self";
        let project = engine.getProject(slug);
        if (!project) {
          project = engine.createProject({
            name: "BeerCan Self-Build",
            slug,
            description: "Using BeerCan to build BeerCan. Recursive self-improvement.",
            context: {
              language: "TypeScript",
              runtime: "Node.js with ESM",
              database: "SQLite via sql.js (WASM)",
              architecture: "Project → Bloop → Agent pipeline with roles",
              codeLocation: process.cwd(),
              conventions: [
                "Strict TypeScript, no any",
                "Zod for all schemas",
                "ESM imports with .js extensions",
                "Minimal dependencies",
                "JSDoc on exports",
              ],
            },
          });
          console.log(chalk.green("✓ Created self-build project"));
        }

        const bGoal = args.slice(1).join(" ") ||
          "Read the current codebase in src/ and identify the most important missing feature or improvement. Then implement it.";

        console.log(chalk.bold.cyan("\n🍺 Bootstrapping: BeerCan building BeerCan\n"));
        console.log(chalk.dim(`Goal: ${bGoal}\n`));

        const bBloop = await engine.runBloop({
          projectSlug: slug,
          goal: bGoal,
          team: "full_team",
          extraContext: `The codebase you are working on IS the BeerCan agent system itself.
You are literally improving yourself. The source code is at: ${process.cwd()}/src/
Read the existing code first, understand the architecture, then make targeted improvements.
Do NOT rewrite everything — make focused, incremental changes.`,
          onEvent: logEvent,
        });

        console.log(chalk.dim(`\nBloop ID: ${bBloop.id}`));
        console.log(chalk.dim(`Tokens: ${bBloop.tokensUsed.toLocaleString()}`));
        break;
      }

      // ── Bloop History & Results ─────────────────────────────────

      case "history": {
        const histSlug = args[1];
        if (!histSlug) {
          console.log(chalk.red("Usage: beercan history <project> [--status completed|failed|running]"));
          break;
        }
        const stIdx = args.indexOf("--status");
        const statusFilter = stIdx >= 0 ? args[stIdx + 1] : undefined;

        const bloops = engine.getProjectBloops(histSlug, statusFilter);
        if (bloops.length === 0) {
          console.log(chalk.dim("No bloops found."));
          break;
        }

        for (const l of bloops) {
          const statusColor = l.status === "completed" ? chalk.green : l.status === "failed" ? chalk.red : chalk.yellow;
          console.log(
            statusColor(`${l.status.padEnd(10)}`) +
            chalk.dim(` ${l.id.slice(0, 8)}`) +
            `  ${l.goal.slice(0, 60)}${l.goal.length > 60 ? "..." : ""}` +
            chalk.dim(`  ${l.tokensUsed.toLocaleString()} tokens  ${l.iterations} iter  ${l.createdAt.slice(0, 19)}`)
          );
        }
        console.log(chalk.dim(`\n${bloops.length} bloop(s)`));
        break;
      }

      case "result": {
        const resultId = args[1];
        if (!resultId) {
          console.log(chalk.red("Usage: beercan result <bloop-id>"));
          break;
        }

        // Support partial ID match
        let bloop = engine.getBloop(resultId);
        if (!bloop) {
          // Try partial match from all projects
          for (const p of engine.listProjects()) {
            const pBloops = engine.getProjectBloops(p.slug);
            const match = pBloops.find((l) => l.id.startsWith(resultId));
            if (match) { bloop = match; break; }
          }
        }

        if (!bloop) {
          console.log(chalk.red(`Bloop not found: ${resultId}`));
          break;
        }

        const statusColor = bloop.status === "completed" ? chalk.green : bloop.status === "failed" ? chalk.red : chalk.yellow;
        console.log(chalk.bold("Bloop Details"));
        console.log(chalk.dim(`  ID:         ${bloop.id}`));
        console.log(`  Status:     ${statusColor(bloop.status)}`);
        console.log(`  Goal:       ${bloop.goal}`);
        console.log(chalk.dim(`  Tokens:     ${bloop.tokensUsed.toLocaleString()}`));
        console.log(chalk.dim(`  Iterations: ${bloop.iterations}`));
        console.log(chalk.dim(`  Created:    ${bloop.createdAt}`));
        if (bloop.completedAt) console.log(chalk.dim(`  Completed:  ${bloop.completedAt}`));
        console.log(chalk.dim(`  Tool Calls: ${bloop.toolCalls.length}`));

        if (bloop.toolCalls.length > 0) {
          console.log(chalk.bold("\nTool Calls:"));
          for (const tc of bloop.toolCalls) {
            const status = tc.error ? chalk.red("ERR") : chalk.green("OK ");
            console.log(`  ${status} ${chalk.blue(tc.toolName)} ${chalk.dim(`${tc.durationMs ?? 0}ms`)}`);
          }
        }

        console.log(chalk.bold("\nResult:"));
        if (bloop.result) {
          const resultStr = typeof bloop.result === "string" ? bloop.result : JSON.stringify(bloop.result, null, 2);
          console.log(resultStr);
        } else {
          console.log(chalk.dim("(no result)"));
        }
        break;
      }

      case "status": {
        const statusId = args[1];
        if (!statusId) {
          // Show overall status
          const projects = engine.listProjects();
          console.log(chalk.bold("BeerCan Status\n"));
          for (const p of projects) {
            const pBloops = engine.getProjectBloops(p.slug);
            const completed = pBloops.filter((l) => l.status === "completed").length;
            const failed = pBloops.filter((l) => l.status === "failed").length;
            const running = pBloops.filter((l) => l.status === "running").length;
            const totalTokens = pBloops.reduce((s, l) => s + l.tokensUsed, 0);
            console.log(
              chalk.bold(p.name) + chalk.dim(` (${p.slug})`) +
              (p.workDir ? chalk.dim(`  dir: ${p.workDir}`) : "") +
              `\n  ${chalk.green(`${completed} completed`)} ${chalk.red(`${failed} failed`)} ${chalk.yellow(`${running} running`)}` +
              chalk.dim(`  ${totalTokens.toLocaleString()} total tokens`)
            );
          }
          break;
        }

        // Show status for a specific bloop
        const sBloop = engine.getBloop(statusId);
        if (!sBloop) {
          console.log(chalk.red(`Bloop not found: ${statusId}`));
          break;
        }
        const sc = sBloop.status === "completed" ? chalk.green : sBloop.status === "failed" ? chalk.red : chalk.yellow;
        console.log(`${sc(sBloop.status)} ${sBloop.goal.slice(0, 80)}`);
        console.log(chalk.dim(`  ${sBloop.tokensUsed.toLocaleString()} tokens, ${sBloop.iterations} iterations`));
        break;
      }

      // ── Job Queue ────────────────────────────────────────────

      case "jobs": {
        const jobStatus = args[1];
        const jobs = engine.getJobQueue().listJobs(jobStatus, 30);
        if (jobs.length === 0) {
          console.log(chalk.dim("No jobs found."));
          break;
        }

        const stats = engine.getJobQueue().getStats();
        console.log(
          chalk.bold("Job Queue: ") +
          chalk.yellow(`${stats.pending} pending`) + "  " +
          chalk.blue(`${stats.running} running`) + "  " +
          chalk.green(`${stats.completed} completed`) + "  " +
          chalk.red(`${stats.failed} failed`) + "\n"
        );

        for (const j of jobs) {
          const sc = j.status === "completed" ? chalk.green
            : j.status === "failed" ? chalk.red
            : j.status === "running" ? chalk.blue
            : chalk.yellow;
          console.log(
            sc(j.status.padEnd(10)) +
            chalk.dim(` ${j.id.slice(0, 8)}`) +
            `  [${j.source}] ${j.goal.slice(0, 50)}${j.goal.length > 50 ? "..." : ""}` +
            (j.bloopId ? chalk.dim(`  bloop:${j.bloopId.slice(0, 8)}`) : "") +
            (j.error ? chalk.red(`  ERR: ${j.error.slice(0, 40)}`) : "")
          );
        }
        break;
      }

      // ── Schedule Management ─────────────────────────────────

      case "schedule:add": {
        const projSlug = args[1];
        const cronExpr = args[2];
        const schedGoal = args.slice(3).join(" ");

        if (!projSlug || !cronExpr || !schedGoal) {
          console.log(chalk.red('Usage: beercan schedule:add <project> "<cron>" <goal>'));
          console.log(chalk.dim('Example: beercan schedule:add my-project "0 9 * * 1-5" "Daily standup summary"'));
          break;
        }

        const proj = engine.getProject(projSlug);
        if (!proj) {
          console.log(chalk.red(`Project not found: ${projSlug}`));
          break;
        }

        const scheduler = engine.getScheduler();
        const schedule = scheduler.addSchedule({
          projectId: proj.id,
          projectSlug: projSlug,
          cronExpression: cronExpr,
          goal: schedGoal,
          description: schedGoal.slice(0, 80),
        });

        console.log(chalk.green(`✓ Schedule created`));
        console.log(chalk.dim(`  ID:   ${schedule.id}`));
        console.log(chalk.dim(`  Cron: ${schedule.cronExpression}`));
        console.log(chalk.dim(`  Goal: ${schedule.goal}`));
        break;
      }

      case "schedule:list": {
        const filterSlug = args[1];
        const scheduler = engine.getScheduler();
        const schedules = scheduler.listSchedules(filterSlug);

        if (schedules.length === 0) {
          console.log(chalk.dim("No schedules found."));
          break;
        }

        for (const s of schedules) {
          const status = s.enabled ? chalk.green("●") : chalk.red("○");
          console.log(
            `${status} ${chalk.bold(s.cronExpression)} ${chalk.dim(`(${s.projectSlug})`)}` +
            `\n  ${s.goal}` +
            `\n  ${chalk.dim(`ID: ${s.id}  Last: ${s.lastRunAt ?? "never"}`)}`
          );
        }
        break;
      }

      case "schedule:remove": {
        const schedId = args[1];
        if (!schedId) {
          console.log(chalk.red("Usage: beercan schedule:remove <schedule-id>"));
          break;
        }
        engine.getScheduler().removeSchedule(schedId);
        console.log(chalk.green(`✓ Schedule removed: ${schedId}`));
        break;
      }

      // ── Trigger Management ──────────────────────────────────

      case "trigger:add": {
        const tProjSlug = args[1];
        const tEventType = args[2];
        const tFilter = args[3];
        const tGoalTemplate = args.slice(4).join(" ");

        if (!tProjSlug || !tEventType || !tFilter || !tGoalTemplate) {
          console.log(chalk.red('Usage: beercan trigger:add <project> <event-type> <filter-regex> <goal-template>'));
          console.log(chalk.dim('Example: beercan trigger:add my-project webhook ".*" "Process incoming: {{data.message}}"'));
          break;
        }

        const tProj = engine.getProject(tProjSlug);
        if (!tProj) {
          console.log(chalk.red(`Project not found: ${tProjSlug}`));
          break;
        }

        const trigMgr = engine.getEventManager().getTriggerManager();
        const trigger = trigMgr.addTrigger({
          projectId: tProj.id,
          projectSlug: tProjSlug,
          eventType: tEventType,
          filterPattern: tFilter,
          goalTemplate: tGoalTemplate,
        });

        console.log(chalk.green(`✓ Trigger created`));
        console.log(chalk.dim(`  ID:       ${trigger.id}`));
        console.log(chalk.dim(`  Event:    ${trigger.eventType}`));
        console.log(chalk.dim(`  Filter:   ${trigger.filterPattern}`));
        console.log(chalk.dim(`  Template: ${trigger.goalTemplate}`));
        break;
      }

      case "trigger:list": {
        const tListSlug = args[1];
        // Read from DB directly — TriggerManager cache only loads in daemon mode
        const triggers = engine.getDB().listTriggers(tListSlug);

        if (triggers.length === 0) {
          console.log(chalk.dim("No triggers found."));
          break;
        }

        for (const t of triggers) {
          const status = t.enabled ? chalk.green("●") : chalk.red("○");
          console.log(
            `${status} ${chalk.bold(t.eventType)} ${chalk.dim(`/${t.filterPattern}/`)} ${chalk.dim(`(${t.projectSlug})`)}` +
            `\n  → ${t.goalTemplate}` +
            `\n  ${chalk.dim(`ID: ${t.id}`)}`
          );
        }
        break;
      }

      case "trigger:remove": {
        const tRemoveId = args[1];
        if (!tRemoveId) {
          console.log(chalk.red("Usage: beercan trigger:remove <trigger-id>"));
          break;
        }
        engine.getEventManager().getTriggerManager().removeTrigger(tRemoveId);
        console.log(chalk.green(`✓ Trigger removed: ${tRemoveId}`));
        break;
      }

      // ── MCP Server Management ───────────────────────────────

      case "mcp:add": {
        const mcpProjSlug = args[1];
        const mcpName = args[2];
        const mcpCommand = args[3];
        const mcpArgs = args.slice(4);

        if (!mcpProjSlug || !mcpName || !mcpCommand) {
          console.log(chalk.red("Usage: beercan mcp:add <project> <name> <command> [args...]"));
          console.log(chalk.dim("Example: beercan mcp:add my-project filesystem npx @modelcontextprotocol/server-filesystem /tmp"));
          break;
        }

        const mcpProj = engine.getProject(mcpProjSlug);
        if (!mcpProj) {
          console.log(chalk.red(`Project not found: ${mcpProjSlug}`));
          break;
        }

        // Read or create mcp.json for this project
        const mcpDir = getProjectDir(mcpProjSlug);
        const mcpConfigPath = path.join(mcpDir, "mcp.json");
        let mcpConfig: { servers: any[] } = { servers: [] };

        if (fs.existsSync(mcpConfigPath)) {
          try {
            mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8"));
          } catch {
            // If corrupt, start fresh
          }
        }

        // Add or replace server config
        const existing = mcpConfig.servers.findIndex((s: any) => s.name === mcpName);
        const serverConfig = {
          name: mcpName,
          type: "stdio" as const,
          command: mcpCommand,
          args: mcpArgs,
          enabled: true,
        };

        if (existing >= 0) {
          mcpConfig.servers[existing] = serverConfig;
          console.log(chalk.yellow(`Updated existing MCP server: ${mcpName}`));
        } else {
          mcpConfig.servers.push(serverConfig);
        }

        fs.mkdirSync(mcpDir, { recursive: true });
        fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

        console.log(chalk.green(`✓ MCP server configured: ${mcpName}`));
        console.log(chalk.dim(`  Command: ${mcpCommand} ${mcpArgs.join(" ")}`));
        console.log(chalk.dim(`  Config:  ${mcpConfigPath}`));
        break;
      }

      case "mcp:list": {
        const mcpListSlug = args[1];
        if (!mcpListSlug) {
          console.log(chalk.red("Usage: beercan mcp:list <project>"));
          break;
        }

        const mcpListPath = path.join(getProjectDir(mcpListSlug), "mcp.json");
        if (!fs.existsSync(mcpListPath)) {
          console.log(chalk.dim("No MCP servers configured for this project."));
          break;
        }

        try {
          const config = JSON.parse(fs.readFileSync(mcpListPath, "utf-8"));
          for (const server of config.servers ?? []) {
            const status = server.enabled !== false ? chalk.green("●") : chalk.red("○");
            console.log(
              `${status} ${chalk.bold(server.name)} ${chalk.dim(`(${server.type})`)}` +
              `\n  ${chalk.dim(server.type === "stdio" ? `${server.command} ${(server.args ?? []).join(" ")}` : server.url ?? "")}`
            );
          }
        } catch {
          console.log(chalk.red("Invalid mcp.json config."));
        }
        break;
      }

      // ── Chat Mode ───────────────────────────────────────────

      case "chat": {
        const chatProject = args[1];

        const { createAnthropicClient } = await import("./client.js");
        const { ChatBridge } = await import("./chat/index.js");
        const { TerminalProvider } = await import("./chat/providers/terminal.js");

        const client = await createAnthropicClient();
        const bridge = new ChatBridge(engine, client);
        const terminal = new TerminalProvider();
        bridge.addProvider(terminal);

        if (chatProject) {
          const p = engine.getProject(chatProject);
          if (!p) {
            console.log(chalk.red(`Project not found: ${chatProject}`));
            break;
          }
          bridge.setDefaultProject("terminal", chatProject);
        } else {
          // Auto-select if there's only one project
          const projects = engine.listProjects();
          if (projects.length === 1) {
            bridge.setDefaultProject("terminal", projects[0].slug);
          }
        }

        await bridge.start();
        await new Promise(() => {}); // Keep alive
        break;
      }

      // ── Start (background daemon) ──────────────────────────

      case "start": {
        const { getConfig: gc } = await import("./config.js");
        const pidFile = path.join(gc().dataDir, "beercan.pid");

        // Check if already running
        if (fs.existsSync(pidFile)) {
          const existingPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
          try {
            process.kill(existingPid, 0); // Check if process exists
            console.log(chalk.yellow(`BeerCan is already running (PID ${existingPid}). Use ${chalk.cyan("beercan stop")} first.`));
            break;
          } catch {
            // Process doesn't exist — stale PID file, clean up
            fs.unlinkSync(pidFile);
          }
        }

        // Fork a background process
        const { fork } = await import("child_process");
        const child = fork(process.argv[1], ["_daemon"], {
          detached: true,
          stdio: "ignore",
        });

        child.unref();
        fs.writeFileSync(pidFile, String(child.pid));

        console.log(chalk.bold.blue("\n🍺 BeerCan started"));
        console.log(chalk.dim(`  PID: ${child.pid}`));
        console.log(chalk.dim(`  API: http://localhost:3939`));
        console.log(chalk.dim(`  Dashboard: http://localhost:3939/`));
        console.log(chalk.dim(`  Stop: beercan stop\n`));
        break;
      }

      // ── Stop ──────────────────────────────────────────────

      case "stop": {
        const { getConfig: gc2 } = await import("./config.js");
        const pidPath = path.join(gc2().dataDir, "beercan.pid");

        if (!fs.existsSync(pidPath)) {
          console.log(chalk.dim("BeerCan is not running."));
          break;
        }

        const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
        try {
          process.kill(pid, "SIGTERM");
          fs.unlinkSync(pidPath);
          console.log(chalk.green(`BeerCan stopped (PID ${pid}).`));
        } catch {
          fs.unlinkSync(pidPath);
          console.log(chalk.dim("BeerCan was not running (stale PID file cleaned up)."));
        }
        break;
      }

      // ── Internal daemon (called by start) ─────────────────

      case "_daemon": {
        const scheduler = engine.getScheduler();
        const eventManager = engine.getEventManager();

        // Write PID file (in case started directly)
        const { getConfig: gc3 } = await import("./config.js");
        const daemonPidFile = path.join(gc3().dataDir, "beercan.pid");
        if (!fs.existsSync(daemonPidFile)) {
          fs.writeFileSync(daemonPidFile, String(process.pid));
        }

        // Clean up PID file on exit
        const cleanPid = () => {
          try { fs.unlinkSync(daemonPidFile); } catch {}
        };
        process.on("exit", cleanPid);

        await startDaemon(engine, scheduler, eventManager);
        break;
      }

      // ── Legacy aliases ─────────────────────────────────────

      case "serve":
      case "daemon": {
        console.log(chalk.yellow(`"beercan ${command}" is deprecated. Use ${chalk.cyan("beercan start")} instead.`));
        console.log(chalk.dim("Starting in foreground mode...\n"));

        const scheduler2 = engine.getScheduler();
        const eventManager2 = engine.getEventManager();
        await startDaemon(engine, scheduler2, eventManager2);
        break;
      }

      // ── Help ────────────────────────────────────────────────

      default:
        console.log(chalk.bold("BeerCan") + chalk.dim(" — Autonomous agent system\n"));
        console.log(chalk.bold("Project Commands:"));
        console.log(chalk.cyan("  init <name> [--work-dir <path>]") + chalk.dim("       Create a new project"));
        console.log(chalk.cyan("  projects") + chalk.dim("                              List all projects"));
        console.log(chalk.cyan("  status") + chalk.dim("                                Overview of all projects & bloops"));
        console.log();
        console.log(chalk.bold("Bloop Commands:"));
        console.log(chalk.cyan("  run <project> [team] <goal>") + chalk.dim("           Run a bloop"));
        console.log(chalk.cyan("  history <project> [--status <s>]") + chalk.dim("      List past bloops"));
        console.log(chalk.cyan("  result <bloop-id>") + chalk.dim("                     Show full bloop result & tool calls"));
        console.log(chalk.cyan("  bootstrap [goal]") + chalk.dim("                      Self-improve the BeerCan codebase"));
        console.log();
        console.log(chalk.bold("Schedule Commands:"));
        console.log(chalk.cyan('  schedule:add <project> "<cron>" <goal>') + chalk.dim("  Add a cron schedule"));
        console.log(chalk.cyan("  schedule:list [project]") + chalk.dim("               List schedules"));
        console.log(chalk.cyan("  schedule:remove <id>") + chalk.dim("                  Remove a schedule"));
        console.log();
        console.log(chalk.bold("Trigger Commands:"));
        console.log(chalk.cyan("  trigger:add <project> <type> <filter> <goal>") + chalk.dim("  Add event trigger"));
        console.log(chalk.cyan("  trigger:list [project]") + chalk.dim("                List triggers"));
        console.log(chalk.cyan("  trigger:remove <id>") + chalk.dim("                   Remove a trigger"));
        console.log();
        console.log(chalk.bold("MCP Commands:"));
        console.log(chalk.cyan("  mcp:add <project> <name> <cmd> [args]") + chalk.dim("  Add MCP server"));
        console.log(chalk.cyan("  mcp:list <project>") + chalk.dim("                    List MCP servers"));
        console.log();
        console.log(chalk.bold("System:"));
        console.log(chalk.cyan("  start") + chalk.dim("                                 Start BeerCan (background daemon + API + chat bots)"));
        console.log(chalk.cyan("  stop") + chalk.dim("                                  Stop the background daemon"));
        console.log(chalk.cyan("  chat [project]") + chalk.dim("                        Interactive Skippy chat"));
        console.log();
        console.log(chalk.dim("Teams: auto (default, gatekeeper picks), solo, code_review, full_team, managed"));
        break;
    }
  } finally {
    // Don't close in daemon mode — it runs forever
    if (!["daemon", "serve", "_daemon", "start", "chat"].includes(command ?? "")) {
      await engine.close();
    }
  }
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err.message);
  process.exit(1);
});
