import readline from "readline";
import chalk from "chalk";
import { v4 as uuid } from "uuid";
import type { ChatProvider, ChatMessage, SendOpts } from "../types.js";
import { pick } from "../skippy-phrases.js";

export class TerminalProvider implements ChatProvider {
  readonly name = "terminal";

  private rl: readline.Interface | null = null;
  private handler: ((msg: ChatMessage) => Promise<void>) | null = null;
  private currentProject: string | null = null;
  private completerFn: ((line: string) => [string[], string]) | null = null;

  /** Set a completer for tab-completion (call before start). */
  setCompleter(fn: (line: string) => [string[], string]): void {
    this.completerFn = fn;
  }

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.buildPrompt(),
      completer: this.completerFn ?? undefined,
    });

    console.log(chalk.bold.yellow("\n🍺 Skippy the Magnificent"));
    console.log(chalk.dim("  Elder AI | Beer Can | Your intellectual superior"));
    console.log(chalk.dim("  Type /help if you need hand-holding. Ctrl+C to leave my presence."));
    console.log(chalk.dim("  Use # for projects, @ for bloops, Tab to autocomplete.\n"));

    this.rl.on("line", async (line: string) => {
      const text = line.trim();
      if (!text) {
        this.showPrompt();
        return;
      }

      if (/^(exit|quit|bye|\/quit|\/exit)$/i.test(text)) {
        console.log(chalk.dim(pick("farewell")));
        process.exit(0);
      }

      if (!this.handler) {
        this.showPrompt();
        return;
      }

      const msg: ChatMessage = {
        id: uuid(),
        channelId: "terminal",
        userId: "local",
        text,
        timestamp: new Date().toISOString(),
      };

      try {
        await this.handler(msg);
      } catch (err) {
        console.error(
          chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`),
        );
      }

      this.showPrompt();
    });

    this.rl.on("close", () => {
      console.log(chalk.dim("\nFine, leave. See if I care. ...I don't."));
      process.exit(0);
    });

    this.showPrompt();
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  onMessage(handler: (msg: ChatMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendMessage(
    _channelId: string,
    text: string,
    _opts?: SendOpts,
  ): Promise<string> {
    // Clear current readline line before printing (prevents garbled output from background events)
    if (this.rl) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    console.log(this.renderMarkdown(text));
    // Re-show prompt after background message
    if (this.rl) {
      this.rl.prompt(true);
    }
    return uuid();
  }

  /** Convert markdown to terminal-styled text. */
  private renderMarkdown(text: string): string {
    return text
      // **bold** → chalk.bold
      .replace(/\*\*(.+?)\*\*/g, (_m, t) => chalk.bold(t))
      // `code` → chalk.cyan
      .replace(/`([^`]+)`/g, (_m, t) => chalk.cyan(t))
      // Remove any remaining markdown artifacts
      .replace(/^#+\s+/gm, "");
  }

  async editMessage(
    _channelId: string,
    _messageId: string,
    text: string,
  ): Promise<void> {
    const lastLine = text.split("\n").pop() ?? text;
    process.stdout.write(`\r${lastLine}`);
  }

  async sendTypingIndicator(_channelId: string): Promise<void> {
    process.stdout.write(chalk.dim(pick("thinking")));
  }

  /** Update the prompt to show current project context. */
  setProjectContext(projectSlug: string | null): void {
    this.currentProject = projectSlug;
    if (this.rl) {
      this.rl.setPrompt(this.buildPrompt());
    }
  }

  private buildPrompt(): string {
    if (this.currentProject) {
      return chalk.yellow("skippy") + chalk.dim(` [${this.currentProject}]`) + chalk.yellow("> ");
    }
    return chalk.yellow("skippy> ");
  }

  private showPrompt(): void {
    if (this.rl) {
      this.rl.prompt();
    } else {
      process.stdout.write(this.buildPrompt());
    }
  }
}
