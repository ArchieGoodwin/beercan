// ── OpenAI Provider ──────────────────────────────────────────
// Wraps the OpenAI SDK (or compatible APIs) for the LLMProvider interface.
// Supports: OpenAI, LM Studio, Ollama, OpenRouter, and other OpenAI-compatible endpoints.

import type {
  LLMProvider, LLMRequest, LLMRequestOptions, LLMResponse,
  LLMMessage, LLMContentBlock, LLMResponseBlock, LLMTool, LLMToolChoice,
} from "./types.js";

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
  /** Name shown in logs */
  name?: string;
}

export class OpenAIProvider implements LLMProvider {
  readonly providerName: string;
  private clientPromise: Promise<any>;

  constructor(private options: OpenAIProviderOptions) {
    this.providerName = options.name ?? (options.baseURL ? "openai-compatible" : "openai");
    // Lazy-load the OpenAI SDK
    this.clientPromise = this.initClient();
  }

  private async initClient(): Promise<any> {
    try {
      // Dynamic import — openai is an optional dependency
      const mod = await (Function('return import("openai")')() as Promise<any>);
      const OpenAI = mod.default ?? mod.OpenAI;
      return new OpenAI({
        apiKey: this.options.apiKey,
        ...(this.options.baseURL ? { baseURL: this.options.baseURL } : {}),
      });
    } catch {
      throw new Error(
        `OpenAI SDK not installed. Run: npm install openai`
      );
    }
  }

  async createMessage(request: LLMRequest, options?: LLMRequestOptions): Promise<LLMResponse> {
    const client = await this.clientPromise;

    // Build OpenAI messages: system prompt becomes first message
    const messages: any[] = [
      { role: "system", content: request.system },
      ...request.messages.flatMap(toOpenAIMessages),
    ];

    // Build tools
    const tools = request.tools?.map(toOpenAITool);
    const toolChoice = request.toolChoice ? toOpenAIToolChoice(request.toolChoice) : undefined;

    const params: any = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages,
    };
    if (tools && tools.length > 0) {
      params.tools = tools;
      if (toolChoice) params.tool_choice = toolChoice;
    }

    const response = await client.chat.completions.create(
      params,
      options?.signal ? { signal: options.signal } : undefined,
    );

    const choice = response.choices?.[0];
    if (!choice) {
      return {
        content: [{ type: "text", text: "" }],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    }

    // Convert response
    const content: LLMResponseBlock[] = [];

    // Text content
    if (choice.message?.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    // Tool calls
    if (choice.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          // Some local models produce malformed JSON — wrap as text
          content.push({ type: "text", text: `Tool call parse error: ${tc.function.arguments}` });
          continue;
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    // Ensure at least one content block
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }

    // Map finish_reason
    const finishReason = choice.finish_reason;
    const stopReason = finishReason === "stop" ? "end_turn"
      : finishReason === "tool_calls" ? "tool_use"
      : finishReason === "length" ? "max_tokens"
      : finishReason ?? "end_turn";

    return {
      content,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      stopReason,
    };
  }
}

// ── Format Converters ───────────────────────────────────────

/**
 * Convert a single LLMMessage to one or more OpenAI messages.
 * Key difference: Anthropic puts tool_results as user content blocks,
 * OpenAI uses separate { role: "tool" } messages.
 */
function toOpenAIMessages(msg: LLMMessage): any[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  const blocks = msg.content as LLMContentBlock[];

  // Assistant messages: split text + tool_use into OpenAI format
  if (msg.role === "assistant") {
    const textParts = blocks.filter(b => b.type === "text").map(b => (b as any).text).join("");
    const toolCalls = blocks.filter(b => b.type === "tool_use").map(b => ({
      id: (b as any).id,
      type: "function",
      function: {
        name: (b as any).name,
        arguments: JSON.stringify((b as any).input),
      },
    }));

    const result: any = { role: "assistant" };
    if (textParts) result.content = textParts;
    else result.content = null;
    if (toolCalls.length > 0) result.tool_calls = toolCalls;
    return [result];
  }

  // User messages: tool_result blocks become separate {role: "tool"} messages
  const results: any[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if (block.type === "tool_result") {
      // Flush accumulated text first
      if (textParts.length > 0) {
        results.push({ role: "user", content: textParts.join("\n") });
        textParts.length = 0;
      }
      results.push({
        role: "tool",
        tool_call_id: block.toolUseId,
        content: block.content,
      });
    } else if (block.type === "text") {
      textParts.push(block.text);
    }
  }

  if (textParts.length > 0) {
    results.push({ role: "user", content: textParts.join("\n") });
  }

  return results.length > 0 ? results : [{ role: "user", content: "" }];
}

function toOpenAITool(tool: LLMTool): any {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOpenAIToolChoice(choice: LLMToolChoice): any {
  if (choice === "auto") return "auto";
  if (choice === "none") return "none";
  return { type: "function", function: { name: choice.name } };
}
