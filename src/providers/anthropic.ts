// ── Anthropic Provider ───────────────────────────────────────
// Wraps the @anthropic-ai/sdk for the LLMProvider interface.

import type {
  LLMProvider, LLMRequest, LLMRequestOptions, LLMResponse,
  LLMMessage, LLMContentBlock, LLMTool, LLMToolChoice,
} from "./types.js";

export class AnthropicProvider implements LLMProvider {
  readonly providerName = "anthropic";
  private client: any; // Anthropic SDK instance

  constructor(client: any) {
    this.client = client;
  }

  async createMessage(request: LLMRequest, options?: LLMRequestOptions): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages.map(toAnthropicMessage),
      tools: request.tools?.map(toAnthropicTool),
      tool_choice: request.toolChoice ? toAnthropicToolChoice(request.toolChoice) : undefined,
    }, options?.signal ? { signal: options.signal } : undefined);

    return {
      content: response.content.map(fromAnthropicBlock),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
      stopReason: response.stop_reason === "end_turn" ? "end_turn"
        : response.stop_reason === "tool_use" ? "tool_use"
        : response.stop_reason === "max_tokens" ? "max_tokens"
        : response.stop_reason ?? "end_turn",
    };
  }
}

// ── Format Converters ───────────────────────────────────────

function toAnthropicMessage(msg: LLMMessage): any {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  const blocks = (msg.content as LLMContentBlock[]).map((block) => {
    if (block.type === "tool_result") {
      return { type: "tool_result", tool_use_id: block.toolUseId, content: block.content };
    }
    if (block.type === "tool_use") {
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    }
    return block; // text blocks pass through
  });

  return { role: msg.role, content: blocks };
}

function toAnthropicTool(tool: LLMTool): any {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toAnthropicToolChoice(choice: LLMToolChoice): any {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  return { type: "tool", name: choice.name };
}

function fromAnthropicBlock(block: any): any {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  return { type: "text", text: "" };
}
