import { v4 as uuid } from "uuid";
import type { ChatProvider, ChatMessage, SendOpts } from "../types.js";

export class SlackProvider implements ChatProvider {
  readonly name = "slack";

  private app: any = null;
  private handler: ((msg: ChatMessage) => Promise<void>) | null = null;

  constructor(
    private readonly token: string,
    private readonly signingSecret: string,
    private readonly appToken?: string,
  ) {}

  async start(): Promise<void> {
    let App: any;
    try {
      // @ts-ignore — @slack/bolt is an optional dependency
      const mod = await import("@slack/bolt");
      App = mod.App;
    } catch {
      throw new Error(
        'Slack provider requires the "@slack/bolt" package. Install it with: npm install @slack/bolt',
      );
    }

    this.app = new App({
      token: this.token,
      signingSecret: this.signingSecret,
      socketMode: true,
      appToken: this.appToken,
    });

    this.app.message(async ({ message, say }: any) => {
      if (!this.handler) return;
      if (message.subtype) return; // ignore edits, joins, etc.

      const msg: ChatMessage = {
        id: uuid(),
        channelId: message.channel,
        userId: message.user,
        text: message.text ?? "",
        timestamp: new Date(Number(message.ts) * 1000).toISOString(),
        metadata: {
          threadTs: message.thread_ts,
          ts: message.ts,
        },
      };

      try {
        await this.handler(msg);
      } catch (err) {
        await say(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    await this.app.start();
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
  }

  onMessage(handler: (msg: ChatMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendMessage(
    channelId: string,
    text: string,
    _opts?: SendOpts,
  ): Promise<string> {
    if (!this.app) throw new Error("Slack app not started");

    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      mrkdwn: true,
    });

    return result.ts as string;
  }

  async editMessage(
    channelId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.app) return;

    await this.app.client.chat
      .update({
        channel: channelId,
        ts: messageId,
        text,
      })
      .catch(() => {});
  }

  async sendTypingIndicator(_channelId: string): Promise<void> {
    // Slack does not expose a direct "typing" indicator API for bots.
    // This is a no-op; responses appear as normal messages.
  }
}
