import { v4 as uuid } from "uuid";
import type { ChatProvider, ChatMessage, SendOpts } from "../types.js";

export class WebSocketProvider implements ChatProvider {
  readonly name = "websocket";

  private wss: any = null;
  private clients = new Map<string, any>();
  private handler: ((msg: ChatMessage) => Promise<void>) | null = null;

  constructor(private readonly port: number = 3940) {}

  async start(): Promise<void> {
    let WebSocketServer: any;
    try {
      // @ts-ignore — ws is an optional dependency
      const mod = await import("ws");
      WebSocketServer = mod.WebSocketServer;
    } catch {
      throw new Error(
        'WebSocket provider requires the "ws" package. Install it with: npm install ws',
      );
    }

    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on("connection", (ws: any) => {
      const clientId = uuid();
      this.clients.set(clientId, ws);

      ws.on("message", async (data: any) => {
        if (!this.handler) return;

        let parsed: { text?: string; channelId?: string; userId?: string };
        try {
          parsed = JSON.parse(String(data));
        } catch {
          return;
        }

        if (!parsed.text) return;

        const msg: ChatMessage = {
          id: uuid(),
          channelId: parsed.channelId ?? clientId,
          userId: parsed.userId ?? clientId,
          text: parsed.text,
          timestamp: new Date().toISOString(),
        };

        try {
          await this.handler(msg);
        } catch (err) {
          const errorPayload = JSON.stringify({
            type: "error",
            text: err instanceof Error ? err.message : String(err),
          });
          ws.send(errorPayload);
        }
      });

      ws.on("close", () => {
        this.clients.delete(clientId);
      });
    });

    console.log(`WebSocket server listening on port ${this.port}`);
  }

  async stop(): Promise<void> {
    for (const ws of this.clients.values()) {
      ws.close();
    }
    this.clients.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss.close(() => resolve());
      });
      this.wss = null;
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
    const id = uuid();
    const payload = JSON.stringify({
      id,
      type: "message",
      text,
      format: opts?.format ?? "text",
    });

    const client = this.clients.get(channelId);
    if (client) {
      client.send(payload);
    } else {
      // Broadcast to all connected clients
      for (const ws of this.clients.values()) {
        ws.send(payload);
      }
    }

    return id;
  }

  async editMessage(
    channelId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    const payload = JSON.stringify({
      id: messageId,
      type: "edit",
      text,
    });

    const client = this.clients.get(channelId);
    if (client) {
      client.send(payload);
    } else {
      for (const ws of this.clients.values()) {
        ws.send(payload);
      }
    }
  }

  async sendTypingIndicator(channelId: string): Promise<void> {
    const payload = JSON.stringify({ type: "typing" });

    const client = this.clients.get(channelId);
    if (client) {
      client.send(payload);
    } else {
      for (const ws of this.clients.values()) {
        ws.send(payload);
      }
    }
  }
}
