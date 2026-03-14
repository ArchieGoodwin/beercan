import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { ToolRegistry, type ToolHandler } from "../tools/registry.js";
import { mcpToolToDefinition, parseMcpToolName } from "./tool-adapter.js";
import { getProjectDir } from "../config.js";

// ── MCP Server Config Schema ────────────────────────────────

export const MCPServerConfigSchema = z.object({
  name: z.string(),
  type: z.enum(["stdio", "http"]),
  command: z.string().optional(),   // for stdio
  args: z.array(z.string()).optional(), // for stdio
  env: z.record(z.string()).optional(), // for stdio
  url: z.string().optional(),       // for http
  enabled: z.boolean().default(true),
});
export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>;

export const MCPProjectConfigSchema = z.object({
  servers: z.array(MCPServerConfigSchema),
});
export type MCPProjectConfig = z.infer<typeof MCPProjectConfigSchema>;

// ── MCP Connection ──────────────────────────────────────────

interface MCPConnection {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: string[]; // namespaced tool names registered from this server
}

// ── MCP Manager ─────────────────────────────────────────────

export class MCPManager {
  private connections = new Map<string, MCPConnection>();
  private currentProject: string | null = null;

  /**
   * Connect to all MCP servers configured for a project.
   * Reads config from `~/.beercan/projects/<slug>/mcp.json`.
   */
  async connectAll(projectSlug: string, registry: ToolRegistry): Promise<void> {
    // If already connected to this project, skip
    if (this.currentProject === projectSlug && this.connections.size > 0) {
      return;
    }

    // Disconnect previous project's servers
    await this.disconnectAll();
    this.currentProject = projectSlug;

    const config = this.loadConfig(projectSlug);
    if (!config || config.servers.length === 0) return;

    for (const serverConfig of config.servers) {
      if (!serverConfig.enabled) continue;

      try {
        await this.connectServer(serverConfig, registry);
      } catch (err: any) {
        console.warn(`[mcp] Failed to connect to ${serverConfig.name}: ${err.message}`);
      }
    }
  }

  /** Connect to a single MCP server and register its tools */
  private async connectServer(
    config: MCPServerConfig,
    registry: ToolRegistry
  ): Promise<void> {
    if (config.type === "stdio") {
      await this.connectStdio(config, registry);
    } else if (config.type === "http") {
      // HTTP transport — future implementation
      // For now, log a warning
      console.warn(`[mcp] HTTP transport not yet implemented for ${config.name}. Use stdio.`);
    }
  }

  /** Connect via stdio transport (spawns a local process) */
  private async connectStdio(
    config: MCPServerConfig,
    registry: ToolRegistry
  ): Promise<void> {
    if (!config.command) {
      throw new Error(`Stdio server ${config.name} requires 'command'`);
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
    });

    const client = new Client(
      { name: "beercan", version: "0.1.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    // Discover and register tools
    const toolsResult = await client.listTools();
    const registeredTools: string[] = [];

    for (const mcpTool of toolsResult.tools) {
      const definition = mcpToolToDefinition(config.name, mcpTool);

      // Create handler that delegates to MCP server
      const handler: ToolHandler = async (input) => {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: input,
        });

        // MCP returns content as array of content blocks
        if (Array.isArray(result.content)) {
          return result.content
            .map((block: any) => {
              if (block.type === "text") return block.text;
              return JSON.stringify(block);
            })
            .join("\n");
        }

        return JSON.stringify(result.content);
      };

      registry.register(definition, handler);
      registeredTools.push(definition.name);
    }

    this.connections.set(config.name, {
      name: config.name,
      client,
      transport,
      tools: registeredTools,
    });

    console.log(
      `[mcp] Connected to ${config.name}: ${registeredTools.length} tools registered`
    );
  }

  /** Disconnect all MCP servers */
  async disconnectAll(): Promise<void> {
    for (const [name, conn] of this.connections) {
      try {
        await conn.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.connections.clear();
    this.currentProject = null;
  }

  /** List active connections */
  listConnections(): Array<{ name: string; tools: string[] }> {
    return Array.from(this.connections.values()).map((c) => ({
      name: c.name,
      tools: c.tools,
    }));
  }

  /** Load MCP config for a project */
  private loadConfig(projectSlug: string): MCPProjectConfig | null {
    const configPath = path.join(getProjectDir(projectSlug), "mcp.json");
    if (!fs.existsSync(configPath)) return null;

    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return MCPProjectConfigSchema.parse(raw);
    } catch (err: any) {
      console.warn(`[mcp] Invalid config at ${configPath}: ${err.message}`);
      return null;
    }
  }
}
