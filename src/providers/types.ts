// ── LLM Provider Abstraction Types ──────────────────────────
// Provider-agnostic types for multi-backend LLM support.

// ── Content Blocks ──────────────────────────────────────────

export interface LLMTextBlock {
  type: "text";
  text: string;
}

export interface LLMToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface LLMToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
}

export type LLMContentBlock = LLMTextBlock | LLMToolUseBlock | LLMToolResultBlock;
export type LLMResponseBlock = LLMTextBlock | LLMToolUseBlock;

// ── Messages ────────────────────────────────────────────────

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMContentBlock[];
}

// ── Tools ───────────────────────────────────────────────────

export interface LLMTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LLMToolChoice = "auto" | "none" | { type: "tool"; name: string };

// ── Request / Response ──────────────────────────────────────

export interface LLMRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  toolChoice?: LLMToolChoice;
}

export interface LLMRequestOptions {
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: LLMResponseBlock[];
  usage: { inputTokens: number; outputTokens: number };
  stopReason: "end_turn" | "tool_use" | "max_tokens" | string;
}

// ── Provider Interface ──────────────────────────────────────

export interface LLMProvider {
  readonly providerName: string;
  createMessage(request: LLMRequest, options?: LLMRequestOptions): Promise<LLMResponse>;
}
