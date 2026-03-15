import { v4 as uuid } from "uuid";
import type { ChatProvider, ChatMessage, SendOpts } from "../types.js";

export class TelegramProvider implements ChatProvider {
  readonly name = "telegram";

  private bot: any = null;
  private handler: ((msg: ChatMessage) => Promise<void>) | null = null;

  constructor(private readonly token: string) {}

  async start(): Promise<void> {
    let Telegraf: any;
    try {
      // @ts-ignore — telegraf is an optional dependency
      const mod = await import("telegraf");
      Telegraf = mod.Telegraf;
    } catch {
      throw new Error(
        'Telegram provider requires the "telegraf" package. Install it with: npm install telegraf',
      );
    }

    this.bot = new Telegraf(this.token);

    this.bot.on("text", async (ctx: any) => {
      if (!this.handler) return;

      const msg: ChatMessage = {
        id: uuid(),
        channelId: String(ctx.message.chat.id),
        userId: String(ctx.message.from.id),
        text: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000).toISOString(),
        metadata: {
          username: ctx.message.from.username,
          firstName: ctx.message.from.first_name,
          lastName: ctx.message.from.last_name,
        },
      };

      try {
        await this.handler(msg);
      } catch (err) {
        await ctx.reply(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    await this.bot.launch();
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop("SIGTERM");
      this.bot = null;
    }
  }

  onMessage(handler: (msg: ChatMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendMessage(
    channelId: string,
    text: string,
    opts?: SendOpts,
  ): Promise<string> {
    if (!this.bot) throw new Error("Telegram bot not started");

    const extra =
      opts?.format === "markdown" ? { parse_mode: "MarkdownV2" as const } : {};

    const result = await this.bot.telegram.sendMessage(
      channelId,
      text,
      extra,
    );
    return String(result.message_id);
  }

  async editMessage(
    channelId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.bot) return;

    await this.bot.telegram
      .editMessageText(channelId, Number(messageId), undefined, text)
      .catch(() => {});
  }

  async sendTypingIndicator(channelId: string): Promise<void> {
    if (!this.bot) return;

    await this.bot.telegram
      .sendChatAction(channelId, "typing")
      .catch(() => {});
  }
}
