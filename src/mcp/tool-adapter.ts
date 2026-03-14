import type { ToolDefinition } from "../schemas.js";

/**
 * Convert an MCP tool definition to our ToolDefinition format.
 * Namespaces the tool name as `mcp_<serverName>__<toolName>` to avoid collisions.
 * Uses underscores because Anthropic's API only allows [a-zA-Z0-9_-] in tool names.
 */
export function mcpToolToDefinition(
  serverName: string,
  mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> }
): ToolDefinition {
  // Sanitize server name: replace non-alphanumeric with underscore
  const safeName = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeToolName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return {
    name: `mcp_${safeName}__${safeToolName}`,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name} from ${serverName}`,
    inputSchema: (mcpTool.inputSchema as Record<string, unknown>) ?? {
      type: "object",
      properties: {},
    },
  };
}

/**
 * Extract the server name and original tool name from a namespaced tool name.
 * e.g., "mcp_filesystem__read_file" → { server: "filesystem", tool: "read_file" }
 */
export function parseMcpToolName(namespacedName: string): { server: string; tool: string } | null {
  const match = namespacedName.match(/^mcp_([^_]+)__(.+)$/);
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}
