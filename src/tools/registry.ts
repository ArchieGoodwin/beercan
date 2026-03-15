import type { ToolDefinition } from "../schemas.js";

// ── Tool Handler Type ────────────────────────────────────────

export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ── Tool Registry ────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** List all registered tool names. */
  listToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool definitions filtered by an allow-list.
   * Pass ["*"] to get all tools.
   */
  getDefinitions(allowedTools: string[] = ["*"]): ToolDefinition[] {
    if (allowedTools.includes("*")) {
      return Array.from(this.tools.values()).map((t) => t.definition);
    }
    return allowedTools
      .map((name) => this.tools.get(name)?.definition)
      .filter(Boolean) as ToolDefinition[];
  }

  /**
   * Convert definitions to Anthropic API tool format.
   */
  toAnthropicTools(allowedTools: string[] = ["*"]): AnthropicTool[] {
    return this.getDefinitions(allowedTools).map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.inputSchema as any,
    }));
  }

  async execute(
    name: string,
    input: Record<string, unknown>
  ): Promise<{ output?: string; error?: string }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { error: `Unknown tool: ${name}` };
    }
    try {
      const output = await tool.handler(input);
      return { output };
    } catch (err: any) {
      return { error: err.message ?? String(err) };
    }
  }
}

// ── Anthropic Tool Type (subset) ─────────────────────────────

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}
