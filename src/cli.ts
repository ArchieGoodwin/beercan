#!/usr/bin/env node
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { BeerCanEngine, PRESET_TEAMS } from "./index.js";
import { getConfig, getProjectDir } from "./config.js";
import { startDaemon } from "./events/daemon.js";
import type { BloopEvent } from "./index.js";
import type { CryptoManager } from "./crypto/index.js";

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

// ── Setup ────────────────────────────────────────────────────

async function prompt(rl: import("readline").Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function runSetup(): Promise<void> {
  const readline = await import("readline");
  const os = await import("os");

  const dataDir = process.env.BEERCAN_DATA_DIR ?? path.join(os.default.homedir(), ".beercan");
  const envPath = path.join(dataDir, ".env");

  console.log(chalk.bold.yellow("\n🍺 BeerCan Setup\n"));
  console.log(chalk.dim("  I'll walk you through configuring BeerCan."));
  console.log(chalk.dim(`  Config saved to: ${envPath}`));
  console.log(chalk.dim("  Press Enter to keep existing values.\n"));

  // Load existing env if present
  const existing: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) existing[match[1]] = match[2];
    }
    console.log(chalk.dim("  Found existing config. Values shown as defaults.\n"));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Required
    const mask = (v?: string) => v ? v.slice(0, 12) + "..." : "";
    console.log(chalk.bold("1. Anthropic API Key") + chalk.red(" (required)"));
    console.log(chalk.dim("   Get one at: https://console.anthropic.com/\n"));
    const apiKey = (await prompt(rl, chalk.cyan(`   ANTHROPIC_API_KEY [${mask(existing.ANTHROPIC_API_KEY)}]: `))).trim()
      || existing.ANTHROPIC_API_KEY || "";

    if (!apiKey) {
      console.log(chalk.red("\n   API key is required. Aborting setup."));
      return;
    }

    // Optional — Models
    console.log(chalk.bold("\n2. Models") + chalk.dim(" (press Enter for defaults)"));
    const defaultModel = (await prompt(rl, chalk.cyan(`   Default model [${existing.BEERCAN_DEFAULT_MODEL || "claude-sonnet-4-6"}]: `))).trim()
      || existing.BEERCAN_DEFAULT_MODEL || "";
    const heavyModel = (await prompt(rl, chalk.cyan(`   Heavy model [${existing.BEERCAN_HEAVY_MODEL || "claude-opus-4-6"}]: `))).trim()
      || existing.BEERCAN_HEAVY_MODEL || "";

    // Optional — Cloudflare
    console.log(chalk.bold("\n3. Cloudflare Browser Rendering") + chalk.dim(" (optional, for web_fetch)"));
    const cfToken = (await prompt(rl, chalk.cyan(`   CLOUDFLARE_API_TOKEN [${mask(existing.CLOUDFLARE_API_TOKEN)}]: `))).trim()
      || existing.CLOUDFLARE_API_TOKEN || "";
    const cfAccount = (await prompt(rl, chalk.cyan(`   CLOUDFLARE_ACCOUNT_ID [${mask(existing.CLOUDFLARE_ACCOUNT_ID)}]: `))).trim()
      || existing.CLOUDFLARE_ACCOUNT_ID || "";

    // Optional — Security
    console.log(chalk.bold("\n4. API Security") + chalk.dim(" (optional, for REST API auth)"));
    const beercanApiKey = (await prompt(rl, chalk.cyan(`   BEERCAN_API_KEY [${mask(existing.BEERCAN_API_KEY)}]: `))).trim()
      || existing.BEERCAN_API_KEY || "";

    // Optional — Chat
    console.log(chalk.bold("\n5. Chat Providers") + chalk.dim(" (optional, for Telegram/Slack bots)"));
    const telegramToken = (await prompt(rl, chalk.cyan(`   BEERCAN_TELEGRAM_TOKEN [${mask(existing.BEERCAN_TELEGRAM_TOKEN)}]: `))).trim()
      || existing.BEERCAN_TELEGRAM_TOKEN || "";
    const slackToken = (await prompt(rl, chalk.cyan(`   BEERCAN_SLACK_TOKEN [${mask(existing.BEERCAN_SLACK_TOKEN)}]: `))).trim()
      || existing.BEERCAN_SLACK_TOKEN || "";
    const slackSecret = (await prompt(rl, chalk.cyan(`   BEERCAN_SLACK_SIGNING_SECRET [${mask(existing.BEERCAN_SLACK_SIGNING_SECRET)}]: `))).trim()
      || existing.BEERCAN_SLACK_SIGNING_SECRET || "";

    // Optional — Notifications
    console.log(chalk.bold("\n6. Notifications") + chalk.dim(" (optional)"));
    const webhookUrl = (await prompt(rl, chalk.cyan(`   BEERCAN_NOTIFY_WEBHOOK_URL [${existing.BEERCAN_NOTIFY_WEBHOOK_URL || ""}]: `))).trim()
      || existing.BEERCAN_NOTIFY_WEBHOOK_URL || "";

    // Build .env content
    const lines: string[] = [
      `# BeerCan Configuration`,
      `# Generated by: beercan setup`,
      ``,
      `ANTHROPIC_API_KEY=${apiKey}`,
    ];

    if (defaultModel) lines.push(`BEERCAN_DEFAULT_MODEL=${defaultModel}`);
    if (heavyModel) lines.push(`BEERCAN_HEAVY_MODEL=${heavyModel}`);
    if (cfToken) lines.push(``, `# Cloudflare Browser Rendering`, `CLOUDFLARE_API_TOKEN=${cfToken}`);
    if (cfAccount) lines.push(`CLOUDFLARE_ACCOUNT_ID=${cfAccount}`);
    if (beercanApiKey) lines.push(``, `# API Security`, `BEERCAN_API_KEY=${beercanApiKey}`);
    if (telegramToken) lines.push(``, `# Chat Providers`, `BEERCAN_TELEGRAM_TOKEN=${telegramToken}`);
    if (slackToken) lines.push(`BEERCAN_SLACK_TOKEN=${slackToken}`);
    if (slackSecret) lines.push(`BEERCAN_SLACK_SIGNING_SECRET=${slackSecret}`);
    if (webhookUrl) lines.push(``, `# Notifications`, `BEERCAN_NOTIFY_WEBHOOK_URL=${webhookUrl}`);

    lines.push(``);

    // Write
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(envPath, lines.join("\n"));

    console.log(chalk.bold.green("\n✓ Setup complete!\n"));
    console.log(chalk.dim(`  Config saved to: ${envPath}`));
    console.log(chalk.dim(`  Data directory:  ${dataDir}\n`));
    console.log(chalk.bold("Next steps:"));
    console.log(chalk.cyan("  beercan init my-project --work-dir ~/my-project"));
    console.log(chalk.cyan("  beercan start"));
    console.log(chalk.cyan("  beercan chat"));
    console.log();
  } finally {
    rl.close();
  }
}

async function runStop(): Promise<void> {
  const os = await import("os");
  const { execSync } = await import("child_process");
  const dataDir = process.env.BEERCAN_DATA_DIR ?? path.join(os.default.homedir(), ".beercan");
  const pidPath = path.join(dataDir, "beercan.pid");

  let stopped = false;

  // Try PID file first
  if (fs.existsSync(pidPath)) {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, "SIGTERM");
      console.log(chalk.green(`BeerCan stopped (PID ${pid}).`));
      stopped = true;
    } catch {
      // Process doesn't exist
    }
    fs.unlinkSync(pidPath);
  }

  // Also find any orphaned daemon processes (e.g., from stale PID file mismatch)
  try {
    const psOutput = execSync("ps -eo pid,command", { encoding: "utf-8" });
    const orphans = psOutput.split("\n")
      .filter((line) => line.includes("beercan") && line.includes("_daemon") && !line.includes("grep"))
      .map((line) => parseInt(line.trim().split(/\s+/)[0], 10))
      .filter((pid) => pid !== process.pid && !isNaN(pid));

    for (const pid of orphans) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(chalk.green(`Stopped orphaned daemon (PID ${pid}).`));
        stopped = true;
      } catch {}
    }
  } catch {}

  if (!stopped) {
    console.log(chalk.dim("BeerCan is not running."));
  }
}

// ── Config Command (no engine needed) ────────────────────────

async function runConfigCommand(args: string[]): Promise<void> {
  const os = await import("os");
  const dataDir = process.env.BEERCAN_DATA_DIR ?? path.join(os.default.homedir(), ".beercan");
  const envPath = path.join(dataDir, ".env");

  const sub = args[1];

  if (sub === "set" && args[2]) {
    // beercan config set KEY=VALUE
    const eqIdx = args[2].indexOf("=");
    if (eqIdx < 0) {
      console.log(chalk.red("Usage: beercan config set KEY=VALUE"));
      return;
    }
    const key = args[2].slice(0, eqIdx);
    const value = args[2].slice(eqIdx + 1);

    // Read existing
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
    const regex = new RegExp(`^${key}=.*$`, "m");

    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }

    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(envPath, content);
    console.log(chalk.green(`✓ ${key} set`));
    return;
  }

  if (sub === "get" && args[2]) {
    // beercan config get KEY
    if (!fs.existsSync(envPath)) {
      console.log(chalk.dim("No config file found."));
      return;
    }
    const content = fs.readFileSync(envPath, "utf-8");
    const match = content.match(new RegExp(`^${args[2]}=(.*)$`, "m"));
    if (match) {
      const val = match[1];
      const display = args[2].toLowerCase().includes("key") || args[2].toLowerCase().includes("secret")
        ? val.slice(0, 12) + "..."
        : val;
      console.log(`${args[2]}=${display}`);
    } else {
      console.log(chalk.dim(`${args[2]} is not set`));
    }
    return;
  }

  if (sub === "list" || !sub) {
    // beercan config list
    if (!fs.existsSync(envPath)) {
      console.log(chalk.dim("No config file. Run: beercan setup"));
      return;
    }
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim() || line.startsWith("#")) {
        console.log(chalk.dim(line));
        continue;
      }
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        const k = line.slice(0, eqIdx);
        const v = line.slice(eqIdx + 1);
        const masked = k.toLowerCase().includes("key") || k.toLowerCase().includes("secret") || k.toLowerCase().includes("token")
          ? v.slice(0, 12) + "..."
          : v;
        console.log(`${chalk.cyan(k)}=${masked}`);
      }
    }
    return;
  }

  console.log(chalk.bold("Config Commands:"));
  console.log(chalk.cyan("  beercan config list") + chalk.dim("                 Show all config"));
  console.log(chalk.cyan("  beercan config set KEY=VALUE") + chalk.dim("         Set a config value"));
  console.log(chalk.cyan("  beercan config get KEY") + chalk.dim("               Get a config value"));
  console.log(chalk.cyan("  beercan setup") + chalk.dim("                       Interactive wizard"));
}

// ── Tool Commands (no engine needed) ─────────────────────────

async function runToolCommand(command: string, args: string[]): Promise<void> {
  const config = getConfig();
  const toolsDir = path.join(config.dataDir, "tools");

  if (command === "tool:create") {
    const toolName = args[1];
    if (!toolName) {
      console.log(chalk.red("Usage: beercan tool:create <name>"));
      console.log(chalk.dim("Creates a tool template in ~/.beercan/tools/<name>.js"));
      return;
    }
    fs.mkdirSync(toolsDir, { recursive: true });
    const toolPath = path.join(toolsDir, `${toolName}.js`);
    if (fs.existsSync(toolPath)) {
      console.log(chalk.yellow(`Tool already exists: ${toolPath}`));
      return;
    }
    const template = `// BeerCan Custom Tool: ${toolName}
// Drop this file in ~/.beercan/tools/ and it will be auto-loaded.
// Agents can call this tool by name during bloop execution.

export const definition = {
  name: "${toolName}",
  description: "Describe what this tool does — agents read this to decide when to use it.",
  inputSchema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The input parameter",
      },
    },
    required: ["input"],
  },
};

export async function handler(params) {
  const { input } = params;

  // Your tool logic here
  // Return a string result that the agent will see
  return \`Tool ${toolName} received: \${input}\`;
}
`;
    fs.writeFileSync(toolPath, template);
    console.log(chalk.green(`✓ Tool template created: ${toolPath}`));
    console.log(chalk.dim("  Edit the file to add your logic, then restart BeerCan."));
  }

  if (command === "tool:list") {
    if (!fs.existsSync(toolsDir)) {
      console.log(chalk.dim("No custom tools. Create one with: beercan tool:create <name>"));
      return;
    }
    const toolFiles = fs.readdirSync(toolsDir).filter((f: string) => f.endsWith(".js") || f.endsWith(".mjs"));
    if (toolFiles.length === 0) {
      console.log(chalk.dim("No custom tools found in ~/.beercan/tools/"));
      return;
    }
    console.log(chalk.bold("Custom Tools:"));
    for (const f of toolFiles) {
      console.log(chalk.cyan(`  ${f.replace(/\.(js|mjs)$/, "")}`));
    }
    console.log(chalk.dim(`\n  Location: ${toolsDir}`));
  }

  if (command === "tool:remove") {
    const rmName = args[1];
    if (!rmName) {
      console.log(chalk.red("Usage: beercan tool:remove <name>"));
      return;
    }
    const rmPath = path.join(toolsDir, `${rmName}.js`);
    if (!fs.existsSync(rmPath)) {
      console.log(chalk.red(`Tool not found: ${rmName}`));
      return;
    }
    fs.unlinkSync(rmPath);
    console.log(chalk.green(`✓ Tool removed: ${rmName}`));
  }
}

// ── Skill Commands (no engine needed) ────────────────────────

async function runSkillCommand(command: string, args: string[]): Promise<void> {
  const config = getConfig();
  const skillsDir = path.join(config.dataDir, "skills");

  if (command === "skill:create") {
    const skillName = args[1];
    if (!skillName) {
      console.log(chalk.red("Usage: beercan skill:create <name>"));
      console.log(chalk.dim("Creates a skill template in ~/.beercan/skills/<name>.json"));
      return;
    }
    fs.mkdirSync(skillsDir, { recursive: true });
    const skillPath = path.join(skillsDir, `${skillName}.json`);
    if (fs.existsSync(skillPath)) {
      console.log(chalk.yellow(`Skill already exists: ${skillPath}`));
      return;
    }
    const template = {
      name: skillName,
      description: `Describe what the ${skillName} skill does`,
      triggers: ["keyword1", "keyword2"],
      instructions: [
        `Step-by-step instructions for agents using this skill:`,
        `1. First, do this`,
        `2. Then, do that`,
        `3. Finally, deliver the result`,
      ].join("\n"),
      requiredTools: [],
      config: {},
      enabled: true,
    };
    fs.writeFileSync(skillPath, JSON.stringify(template, null, 2));
    console.log(chalk.green(`✓ Skill template created: ${skillPath}`));
    console.log(chalk.dim("  Edit the file to define triggers, instructions, and config."));
  }

  if (command === "skill:list") {
    if (!fs.existsSync(skillsDir)) {
      console.log(chalk.dim("No skills. Create one with: beercan skill:create <name>"));
      return;
    }
    const files = fs.readdirSync(skillsDir).filter((f: string) => f.endsWith(".json"));
    if (files.length === 0) {
      console.log(chalk.dim("No skills found in ~/.beercan/skills/"));
      return;
    }
    console.log(chalk.bold("Skills:"));
    for (const f of files) {
      try {
        const skill = JSON.parse(fs.readFileSync(path.join(skillsDir, f), "utf-8"));
        const status = skill.enabled !== false ? chalk.green("●") : chalk.red("○");
        console.log(`  ${status} ${chalk.bold(skill.name)} — ${skill.description ?? ""}`);
        console.log(chalk.dim(`    Triggers: ${(skill.triggers ?? []).join(", ")}`));
      } catch {
        console.log(chalk.dim(`  ? ${f} (invalid JSON)`));
      }
    }
  }
}

// ── CLI Commands ─────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // ── Commands that don't need engine ────────────────────────

  if (command === "setup") {
    await runSetup();
    return;
  }

  if (command === "stop") {
    await runStop();
    return;
  }

  if (command === "config") {
    await runConfigCommand(args);
    return;
  }

  if (command === "tool:create" || command === "tool:list" || command === "tool:remove") {
    await runToolCommand(command, args);
    return;
  }

  if (command === "skill:create" || command === "skill:list") {
    await runSkillCommand(command, args);
    return;
  }

  // ── All other commands need the engine ─────────────────────

  // Suppress stdout during engine init for chat and start (prevents JSON log noise)
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  if (command === "chat" || command === "start") {
    process.stdout.write = (() => true) as any;
    process.stderr.write = (() => true) as any;
  }

  const engine = await new BeerCanEngine().init();

  if (command === "chat" || command === "start") {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }
  if (command === "chat") {
    const { getLogger: getLog } = await import("./core/logger.js");
    getLog().setQuiet(true);
  }

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
        const showAllProjects = args.includes("--all") || args.includes("-a");
        const showSystemOnly = args.includes("--system");
        let projects = engine.listProjects({ includeSystem: showAllProjects || showSystemOnly });
        if (showSystemOnly) projects = projects.filter(p => p.system);
        if (projects.length === 0) {
          console.log(chalk.dim("No projects yet. Run: beercan init <name>"));
          break;
        }
        for (const p of projects) {
          const sysTag = p.system ? chalk.cyan(" [system]") : "";
          console.log(
            chalk.bold(p.name) +
            chalk.dim(` (${p.slug})`) +
            sysTag +
            chalk.dim(` — ${p.description ?? "no description"}`)
          );
        }
        if (!showAllProjects && !showSystemOnly) {
          console.log(chalk.dim("\nUse --all to include system projects"));
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
          const showAllStatus = args.includes("--all") || args.includes("-a");
          const projects = engine.listProjects({ includeSystem: showAllStatus });
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
        const foreground = args.includes("--foreground") || args.includes("-f");

        // Check if already running (PID file or orphaned process)
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
        // Also check for orphaned daemon processes without PID file
        try {
          const { execSync: execSyncStart } = await import("child_process");
          const psOut = execSyncStart("ps -eo pid,command", { encoding: "utf-8" });
          const orphan = psOut.split("\n").find((l) =>
            l.includes("beercan") && l.includes("_daemon") && !l.includes("grep")
          );
          if (orphan) {
            const orphanPid = parseInt(orphan.trim().split(/\s+/)[0], 10);
            if (orphanPid && orphanPid !== process.pid) {
              console.log(chalk.yellow(`BeerCan daemon found running (PID ${orphanPid}) without PID file. Use ${chalk.cyan("beercan stop")} first.`));
              break;
            }
          }
        } catch {}

        // Gather startup info
        const pkgPath = new URL("../package.json", import.meta.url);
        let version = "?";
        try { version = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version; } catch {}

        const projects = engine.listProjects();
        const schedules = engine.getScheduler().listSchedules();
        const bloopStats = engine.getBloopStats();
        const skills = engine.getSkillManager().getEnabledSkills();
        const builtinToolCount = engine.getToolRegistry().listToolNames().length;
        const customToolsDir = path.join(gc().dataDir, "tools");
        const customTools = fs.existsSync(customToolsDir)
          ? fs.readdirSync(customToolsDir).filter((f: string) => f.endsWith(".js") || f.endsWith(".mjs"))
          : [];

        const printStartupInfo = (pid: number | string) => {
          console.log(chalk.bold.blue(`\n🍺 BeerCan v${version} started`));
          console.log(chalk.dim(`  PID:        ${pid}`));
          console.log(chalk.dim(`  Mode:       ${foreground ? "foreground" : "background"}`));
          console.log(chalk.dim(`  API:        http://localhost:3939`));
          console.log(chalk.dim(`  Dashboard:  http://localhost:3939/`));
          console.log(chalk.dim(`  Projects:   ${projects.length}`));
          console.log(chalk.dim(`  Schedules:  ${schedules.length}${schedules.length > 0 ? ` (${schedules.filter(s => s.enabled).length} active)` : ""}`));
          console.log(chalk.dim(`  Bloops:     ${bloopStats.total} total (${bloopStats.completed} completed, ${bloopStats.failed} failed)`));
          console.log(chalk.dim(`  Skills:     ${skills.length} active`));
          console.log(chalk.dim(`  Tools:      ${builtinToolCount} built-in + ${customTools.length} custom`));
          if (schedules.length > 0) {
            console.log(chalk.dim(`\n  Active schedules:`));
            for (const s of schedules.filter(s => s.enabled)) {
              console.log(chalk.dim(`    ${chalk.cyan(s.cronExpression)} ${s.projectSlug} — ${s.goal.slice(0, 50)}`));
            }
          }
          if (skills.length > 0) {
            console.log(chalk.dim(`\n  Active skills:`));
            for (const s of skills) {
              console.log(chalk.dim(`    ${chalk.cyan(s.name)} — ${s.description.slice(0, 50)}`));
            }
          }
          if (customTools.length > 0) {
            console.log(chalk.dim(`\n  Custom tools:`));
            for (const t of customTools) {
              console.log(chalk.dim(`    ${chalk.cyan(t.replace(/\.(js|mjs)$/, ""))}`));
            }
          }
        };

        if (foreground) {
          // ── Foreground mode: run daemon in this process with live logs ──
          fs.writeFileSync(pidFile, String(process.pid));
          const cleanPid = () => { try { fs.unlinkSync(pidFile); } catch {} };
          process.on("exit", cleanPid);

          printStartupInfo(process.pid);
          console.log(chalk.dim(`\n  Stop: Ctrl+C\n`));

          // Tail the log file in real-time
          const logFile = gc().logFile ?? path.join(gc().dataDir, "beercan.log");
          let logTail: any = null;
          if (fs.existsSync(logFile)) {
            const { spawn } = await import("child_process");
            logTail = spawn("tail", ["-f", logFile], { stdio: ["ignore", "inherit", "inherit"] });
          } else {
            // Watch for log file creation then start tailing
            const logDir = path.dirname(logFile);
            const watcher = fs.watch(logDir, (_, filename) => {
              if (filename === path.basename(logFile) && fs.existsSync(logFile)) {
                watcher.close();
                import("child_process").then(({ spawn }) => {
                  logTail = spawn("tail", ["-f", logFile], { stdio: ["ignore", "inherit", "inherit"] });
                });
              }
            });
          }

          const scheduler = engine.getScheduler();
          const eventManager = engine.getEventManager();
          await startDaemon(engine, scheduler, eventManager);
          if (logTail) logTail.kill();
        } else {
          // ── Background mode: fork and detach ──
          const { fork } = await import("child_process");
          const child = fork(process.argv[1], ["_daemon"], {
            detached: true,
            stdio: "ignore",
          });

          child.unref();
          fs.writeFileSync(pidFile, String(child.pid));

          printStartupInfo(child.pid!);
          console.log(chalk.dim(`\n  Stop: beercan stop\n`));
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

      // ── Encryption Commands ────────────────────────────────

      case "crypto:status": {
        const { CryptoManager, isEncrypted } = await import("./crypto/index.js");
        const cfg = getConfig();
        console.log(chalk.bold("Encryption Status\n"));
        console.log(`  Enabled:  ${cfg.encryptionEnabled ? chalk.green("yes") : chalk.dim("no")}`);
        console.log(`  Mode:     ${cfg.encryptionMode}`);
        if (cfg.encryptionMode === "keyfile") {
          const kf = cfg.encryptionKeyfile ?? path.join(cfg.dataDir, "master.key");
          console.log(`  Keyfile:  ${fs.existsSync(kf) ? chalk.green(kf) : chalk.red(kf + " (not found)")}`);
        }
        const cryptoJson = path.join(cfg.dataDir, "crypto.json");
        console.log(`  Config:   ${fs.existsSync(cryptoJson) ? chalk.green(cryptoJson) : chalk.dim("not configured")}`);

        // Check if DB has any encrypted data
        const rawDb = (await import("better-sqlite3")).default;
        const dbPath = path.join(cfg.dataDir, "orchestrator.db");
        if (fs.existsSync(dbPath)) {
          const raw = new rawDb(dbPath);
          const sample = raw.prepare("SELECT goal FROM loops LIMIT 1").get() as any;
          raw.close();
          if (sample && isEncrypted(sample.goal)) {
            console.log(`  Database: ${chalk.green("encrypted data detected")}`);
          } else if (sample) {
            console.log(`  Database: ${chalk.yellow("plaintext data")}`);
          } else {
            console.log(`  Database: ${chalk.dim("empty")}`);
          }
        }
        break;
      }

      case "crypto:encrypt": {
        const cfg = getConfig();
        if (!cfg.encryptionEnabled) {
          console.error(chalk.red("Encryption is not enabled. Set BEERCAN_ENCRYPTION_ENABLED=true first."));
          break;
        }
        const { encryptDatabase } = await import("./crypto/migration.js");
        const rawDb = (await import("better-sqlite3")).default;
        const dbFile = path.join(cfg.dataDir, "orchestrator.db");
        const db2 = new rawDb(dbFile);
        // Ensure _crypto_state table exists
        db2.exec("CREATE TABLE IF NOT EXISTS _crypto_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

        const { CryptoManager: CM } = await import("./crypto/index.js");
        let cm: CryptoManager;
        if (cfg.encryptionMode === "keyfile") {
          const kf = cfg.encryptionKeyfile ?? path.join(cfg.dataDir, "master.key");
          cm = CM.fromKeyfile(kf);
        } else {
          const pass = cfg.encryptionPassphrase;
          if (!pass) {
            console.error(chalk.red("BEERCAN_ENCRYPTION_PASSPHRASE not set."));
            db2.close();
            break;
          }
          cm = CM.fromPassphrase(pass, cfg.dataDir);
        }

        console.log(chalk.dim("Encrypting database..."));
        const result = encryptDatabase(db2, cm);
        cm.destroy();
        db2.close();

        console.log(chalk.green(`✓ Encrypted ${result.rowsEncrypted} rows across ${result.tablesProcessed} tables.`));
        if (result.rowsSkipped > 0) {
          console.log(chalk.dim(`  Skipped ${result.rowsSkipped} already-encrypted rows.`));
        }
        break;
      }

      case "crypto:decrypt": {
        const cfg = getConfig();
        const { decryptDatabase } = await import("./crypto/migration.js");
        const rawDb = (await import("better-sqlite3")).default;
        const dbFile = path.join(cfg.dataDir, "orchestrator.db");
        const db2 = new rawDb(dbFile);

        const { CryptoManager: CM } = await import("./crypto/index.js");
        let cm: CryptoManager;
        if (cfg.encryptionMode === "keyfile") {
          const kf = cfg.encryptionKeyfile ?? path.join(cfg.dataDir, "master.key");
          cm = CM.fromKeyfile(kf);
        } else {
          const pass = cfg.encryptionPassphrase;
          if (!pass) {
            console.error(chalk.red("BEERCAN_ENCRYPTION_PASSPHRASE not set."));
            db2.close();
            break;
          }
          cm = CM.fromPassphrase(pass, cfg.dataDir);
        }

        console.log(chalk.dim("Decrypting database..."));
        const result = decryptDatabase(db2, cm);
        cm.destroy();
        db2.close();

        console.log(chalk.green(`✓ Decrypted ${result.rowsEncrypted} rows across ${result.tablesProcessed} tables.`));
        break;
      }

      case "crypto:setup": {
        const { KeyManager } = await import("./crypto/index.js");
        const readline = await import("readline");
        const cfg = getConfig();
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

        console.log(chalk.bold("Encryption Setup\n"));
        const mode = await ask("Key mode (passphrase/keyfile) [passphrase]: ");
        const chosenMode = mode.trim() === "keyfile" ? "keyfile" : "passphrase";

        if (chosenMode === "keyfile") {
          const kfPath = path.join(cfg.dataDir, "master.key");
          KeyManager.generateKeyfile(kfPath, cfg.dataDir);
          console.log(chalk.green(`\n✓ Keyfile generated: ${kfPath}`));
          console.log(chalk.dim("Add to .env: BEERCAN_ENCRYPTION_ENABLED=true"));
          console.log(chalk.dim("             BEERCAN_ENCRYPTION_MODE=keyfile"));
        } else {
          const pass = await ask("Enter passphrase: ");
          if (!pass.trim()) {
            console.error(chalk.red("Passphrase cannot be empty."));
            rl.close();
            break;
          }
          KeyManager.fromPassphrase(pass.trim(), cfg.dataDir);
          console.log(chalk.green("\n✓ Passphrase configured."));
          console.log(chalk.dim("Add to .env: BEERCAN_ENCRYPTION_ENABLED=true"));
          console.log(chalk.dim("             BEERCAN_ENCRYPTION_PASSPHRASE=<your passphrase>"));
        }
        rl.close();
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
        console.log(chalk.bold("Tools & MCP:"));
        console.log(chalk.cyan("  tool:create <name>") + chalk.dim("                    Create a custom tool template"));
        console.log(chalk.cyan("  tool:list") + chalk.dim("                             List custom tools"));
        console.log(chalk.cyan("  tool:remove <name>") + chalk.dim("                    Remove a custom tool"));
        console.log(chalk.cyan("  mcp:add <project> <name> <cmd> [args]") + chalk.dim("  Add MCP server"));
        console.log(chalk.cyan("  mcp:list <project>") + chalk.dim("                    List MCP servers"));
        console.log();
        console.log(chalk.bold("Encryption:"));
        console.log(chalk.cyan("  crypto:setup") + chalk.dim("                          Configure encryption (passphrase or keyfile)"));
        console.log(chalk.cyan("  crypto:status") + chalk.dim("                         Show encryption status"));
        console.log(chalk.cyan("  crypto:encrypt") + chalk.dim("                        Encrypt existing database"));
        console.log(chalk.cyan("  crypto:decrypt") + chalk.dim("                        Decrypt database to plaintext"));
        console.log();
        console.log(chalk.bold("System:"));
        console.log(chalk.cyan("  setup") + chalk.dim("                                 First-time setup (API keys, config)"));
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
  const msg = String(err?.message ?? err);
  if (msg.includes("anthropicApiKey") || msg.includes("ANTHROPIC_API_KEY") || msg.includes("Required")) {
    console.error(chalk.red("\nMissing API key.") + " Run " + chalk.cyan("beercan setup") + " to configure BeerCan.\n");
  } else {
    console.error(chalk.red("Fatal:"), msg);
  }
  process.exit(1);
});
