export interface ChatMessage {
  id: string;
  channelId: string;
  userId: string;
  text: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface SendOpts {
  format?: "text" | "markdown";
  replyTo?: string;
}

export interface ChatProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: ChatMessage) => Promise<void>): void;
  sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<string>;
  editMessage(channelId: string, messageId: string, text: string): Promise<void>;
  sendTypingIndicator?(channelId: string): Promise<void>;
}

export type ChatIntent =
  | { type: "run_bloop"; projectSlug: string; goal: string; team?: string }
  | { type: "check_status" }
  | { type: "list_projects" }
  | { type: "bloop_history"; projectSlug?: string }
  | { type: "bloop_result"; bloopId: string }
  | { type: "cancel_job"; jobId: string }
  | { type: "create_project"; name: string; workDir?: string }
  | { type: "switch_project"; projectSlug: string }
  | { type: "add_schedule"; projectSlug: string; cron: string; goal: string }
  | { type: "list_schedules"; projectSlug?: string }
  | { type: "read_file"; filePath: string }
  | { type: "list_skills" }
  | { type: "help" }
  | { type: "conversation"; text: string };
