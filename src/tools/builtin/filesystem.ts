import fs from "fs";
import path from "path";
import type { ToolDefinition } from "../../schemas.js";
import type { ToolHandler } from "../registry.js";

// ── Read File ────────────────────────────────────────────────

export const readFileDefinition: ToolDefinition = {
  name: "read_file",
  description: "Read the contents of a file at the given path.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative file path to read",
      },
    },
    required: ["path"],
  },
};

export const readFileHandler: ToolHandler = async (input) => {
  const filePath = input.path as string;
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
};

// ── Write File ───────────────────────────────────────────────

export const writeFileDefinition: ToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file. Creates parent directories if needed. Overwrites existing files. " +
    "For large files (>4000 chars), write the first section with write_file then use append_file for the rest.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative file path to write",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
};

export const writeFileHandler: ToolHandler = async (input) => {
  const filePath = input.path as string;
  const content = input.content as string;

  if (content == null || typeof content !== "string" || content.length === 0) {
    throw new Error(
      "'content' parameter was empty or missing. This usually means the content was too large for a single tool call and got truncated. " +
      "YOU MUST USE A DIFFERENT APPROACH — do NOT retry write_file with the same large content. Instead:\n" +
      "1. BEST: Use exec_command with a Python/Node script that generates and writes the file, e.g.:\n" +
      "   exec_command({ command: \"python3 generate_html.py\", cwd: \"...\" })\n" +
      "2. OR: Write a small script file first, then exec_command to run it.\n" +
      "3. OR: Break the content into sections <3000 chars each — write_file for the first, append_file for each additional section.\n" +
      "Do NOT attempt to pass the full content in write_file again — it WILL fail the same way."
    );
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, content, "utf-8");
  return `Written ${content.length} chars to ${filePath}`;
};

// ── Append File ─────────────────────────────────────────────

export const appendFileDefinition: ToolDefinition = {
  name: "append_file",
  description:
    "Append content to a file. Creates the file if it doesn't exist. Use this to write large files in chunks — " +
    "call write_file for the first section, then append_file for each subsequent section.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative file path to append to",
      },
      content: {
        type: "string",
        description: "Content to append to the file",
      },
    },
    required: ["path", "content"],
  },
};

export const appendFileHandler: ToolHandler = async (input) => {
  const filePath = input.path as string;
  const content = input.content as string;

  if (content == null || typeof content !== "string") {
    throw new Error("'content' parameter is required and must be a non-empty string.");
  }

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.appendFileSync(filePath, content, "utf-8");
  const totalSize = fs.statSync(filePath).size;
  return `Appended ${content.length} chars to ${filePath} (total file size: ${totalSize} bytes)`;
};

// ── List Directory ───────────────────────────────────────────

export const listDirDefinition: ToolDefinition = {
  name: "list_directory",
  description:
    "List files and directories at the given path. Returns names with type indicators (/ for dirs).",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list",
      },
      recursive: {
        type: "boolean",
        description: "If true, list recursively (max 3 levels deep)",
      },
    },
    required: ["path"],
  },
};

export const listDirHandler: ToolHandler = async (input) => {
  const dirPath = input.path as string;
  const recursive = (input.recursive as boolean) ?? false;

  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const entries = listRecursive(dirPath, recursive ? 3 : 1, 0);
  return entries.join("\n");
};

function listRecursive(
  dir: string,
  maxDepth: number,
  currentDepth: number
): string[] {
  if (currentDepth >= maxDepth) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const result: string[] = [];
  const indent = "  ".repeat(currentDepth);

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      result.push(`${indent}${entry.name}/`);
      result.push(
        ...listRecursive(
          path.join(dir, entry.name),
          maxDepth,
          currentDepth + 1
        )
      );
    } else {
      result.push(`${indent}${entry.name}`);
    }
  }

  return result;
}

// ── Execute Shell Command ────────────────────────────────────

export const execDefinition: ToolDefinition = {
  name: "exec_command",
  description:
    "Execute a shell command and return stdout/stderr. Use for running scripts, builds, tests, git operations, etc.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      cwd: {
        type: "string",
        description: "Working directory for the command (optional)",
      },
    },
    required: ["command"],
  },
};

export const execHandler: ToolHandler = async (input) => {
  const { execSync } = await import("child_process");
  const command = input.command as string;
  const cwd = (input.cwd as string) || process.cwd();

  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return output || "(no output)";
  } catch (err: any) {
    return `EXIT ${err.status ?? "?"}\nSTDOUT: ${err.stdout ?? ""}\nSTDERR: ${err.stderr ?? ""}`;
  }
};
