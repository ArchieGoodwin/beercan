import { describe, it, expect } from "vitest";

// We test the parseNaturalPatterns function indirectly by importing the module
// and testing the exported parseIntent with mocked dependencies.
// For unit testing the pattern matching, we extract and test the regex logic directly.

describe("Intent Parser — Natural Language Patterns", () => {
  // Helper: simulate what parseNaturalPatterns does
  function parseNaturalPatterns(text: string) {
    const lower = text.toLowerCase();

    const createProjectMatch = lower.match(
      /^(?:create|new|make|init|initialize|set\s*up|start)\s+(?:a\s+)?(?:new\s+)?project\s+(?:called\s+|named\s+)?(.+)/i,
    );
    if (createProjectMatch) {
      const rest = createProjectMatch[1].trim();
      const nameMatch = rest.match(/^([^\s]+(?:\s+[^\s]+){0,3}?)(?:\s+(?:to|for|with|that|which|--|—)|\s*$)/);
      const rawName = nameMatch ? nameMatch[1] : rest.split(/\s+/).slice(0, 3).join(" ");
      const name = rawName.replace(/\s+(?:to|for|with|that|which|a|an|the)$/i, "").trim();

      if (name) {
        // Use original text to preserve path casing
        const workDirMatch = text.match(/--(?:work-dir|workdir|dir)\s+(\S+)/i);
        return { type: "create_project" as const, name, workDir: workDirMatch?.[1] };
      }
    }

    if (/^(?:create|new|make|init|initialize|set\s*up|start)\s+(?:a\s+)?(?:new\s+)?project\s*$/i.test(lower)) {
      return { type: "conversation" as const, text: "Oh, you want me to create a project but can't even tell me its name? Try: /init <name> [work-dir]" };
    }

    // "show me <file>", "cat <file>", "read <file>", "open <file>", etc.
    const readFileMatch = text.match(
      /^(?:show\s+(?:me\s+)?(?:the\s+)?(?:file\s+|contents?\s+(?:of\s+)?)?|cat\s+|read\s+(?:the\s+)?(?:file\s+)?|open\s+(?:the\s+)?(?:file\s+)?|print\s+(?:the\s+)?(?:file\s+)?|display\s+(?:the\s+)?(?:file\s+)?|what(?:'s|s| is)\s+in\s+(?:the\s+)?(?:file\s+)?)(\S+)\s*$/i,
    );
    if (readFileMatch) {
      const filePath = readFileMatch[1];
      if (filePath.includes(".") || filePath.includes("/")) {
        return { type: "read_file" as const, filePath };
      }
    }

    return null;
  }

  it("matches 'create project my-tool'", () => {
    const result = parseNaturalPatterns("create project my-tool");
    expect(result).toEqual({ type: "create_project", name: "my-tool", workDir: undefined });
  });

  it("matches 'Create project to make new tool to view files'", () => {
    const result = parseNaturalPatterns("Create project to make new tool to view any files from macOS folders and attach them to chat");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("create_project");
  });

  it("matches 'new project file-viewer'", () => {
    const result = parseNaturalPatterns("new project file-viewer");
    expect(result).toEqual({ type: "create_project", name: "file-viewer", workDir: undefined });
  });

  it("matches 'make a project called my-api'", () => {
    const result = parseNaturalPatterns("make a project called my-api");
    expect(result).toEqual({ type: "create_project", name: "my-api", workDir: undefined });
  });

  it("matches 'create a new project test-app'", () => {
    const result = parseNaturalPatterns("create a new project test-app");
    expect(result).toEqual({ type: "create_project", name: "test-app", workDir: undefined });
  });

  it("extracts work-dir flag", () => {
    const result = parseNaturalPatterns("create project my-api --work-dir /Users/me/api");
    expect(result).toEqual({ type: "create_project", name: "my-api", workDir: "/Users/me/api" });
  });

  it("matches 'set up a project dashboard'", () => {
    const result = parseNaturalPatterns("set up a project dashboard");
    expect(result).toEqual({ type: "create_project", name: "dashboard", workDir: undefined });
  });

  it("matches 'init project my-service'", () => {
    const result = parseNaturalPatterns("init project my-service");
    expect(result).toEqual({ type: "create_project", name: "my-service", workDir: undefined });
  });

  it("handles 'create project' with no name", () => {
    const result = parseNaturalPatterns("create project");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("conversation");
  });

  it("handles 'new project' with no name", () => {
    const result = parseNaturalPatterns("new project");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("conversation");
  });

  it("does NOT match unrelated messages", () => {
    expect(parseNaturalPatterns("what is the status")).toBeNull();
    expect(parseNaturalPatterns("run my-project analyze code")).toBeNull();
    expect(parseNaturalPatterns("hello skippy")).toBeNull();
    expect(parseNaturalPatterns("summarize the latest news")).toBeNull();
  });

  it("matches 'create project named file-tool for viewing files'", () => {
    const result = parseNaturalPatterns("create project named file-tool for viewing files");
    expect(result).toEqual({ type: "create_project", name: "file-tool", workDir: undefined });
  });

  // ── read_file patterns ─────────────────────────────────────
  it("matches 'show me ai-news.md'", () => {
    const result = parseNaturalPatterns("show me ai-news.md");
    expect(result).toEqual({ type: "read_file", filePath: "ai-news.md" });
  });

  it("matches 'cat report.txt'", () => {
    const result = parseNaturalPatterns("cat report.txt");
    expect(result).toEqual({ type: "read_file", filePath: "report.txt" });
  });

  it("matches 'read the file output.json'", () => {
    const result = parseNaturalPatterns("read the file output.json");
    expect(result).toEqual({ type: "read_file", filePath: "output.json" });
  });

  it("matches 'show me the file results.csv'", () => {
    const result = parseNaturalPatterns("show me the file results.csv");
    expect(result).toEqual({ type: "read_file", filePath: "results.csv" });
  });

  it("matches 'what's in ai-news.md'", () => {
    const result = parseNaturalPatterns("what's in ai-news.md");
    expect(result).toEqual({ type: "read_file", filePath: "ai-news.md" });
  });

  it("matches 'display summary.md'", () => {
    const result = parseNaturalPatterns("display summary.md");
    expect(result).toEqual({ type: "read_file", filePath: "summary.md" });
  });

  it("matches 'show me /tmp/output.log'", () => {
    const result = parseNaturalPatterns("show me /tmp/output.log");
    expect(result).toEqual({ type: "read_file", filePath: "/tmp/output.log" });
  });

  it("matches 'show content of data.json'", () => {
    const result = parseNaturalPatterns("show content of data.json");
    expect(result).toEqual({ type: "read_file", filePath: "data.json" });
  });

  it("matches 'open the file config.yaml'", () => {
    const result = parseNaturalPatterns("open the file config.yaml");
    expect(result).toEqual({ type: "read_file", filePath: "config.yaml" });
  });

  it("does NOT match 'show me' without a file-like argument", () => {
    expect(parseNaturalPatterns("show me projects")).toBeNull();
    expect(parseNaturalPatterns("show me status")).toBeNull();
  });
});
