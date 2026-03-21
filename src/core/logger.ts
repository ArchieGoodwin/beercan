import fs from "fs";
import path from "path";

// ── Structured Logger ───────────────────────────────────────
// JSON lines to stdout + optional file. Replaces scattered console.log.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

// ── Sensitive Field Patterns ─────────────────────────────────
// Fields whose values should be redacted when log sanitization is active.
const SENSITIVE_FIELDS = new Set([
  "goal", "result", "content", "messages", "systemPrompt", "system_prompt",
  "toolCalls", "tool_calls", "extraContext", "extra_context",
  "eventData", "event_data", "goalTemplate", "goal_template",
  "filterData", "filter_data", "passphrase", "password",
]);

// Regex patterns for API keys/tokens that should always be redacted.
const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]+/g,      // Anthropic API keys
  /sk-[a-zA-Z0-9]{20,}/g,         // OpenAI-style keys
  /xoxb-[a-zA-Z0-9-]+/g,          // Slack bot tokens
  /xoxp-[a-zA-Z0-9-]+/g,          // Slack user tokens
  /Bearer\s+[a-zA-Z0-9._~+/-]+=*/g, // Bearer tokens
];

export class Logger {
  private level: number;
  private fileStream: fs.WriteStream | null = null;
  private quiet = false;
  private sanitizeEnabled = false;

  constructor(level: LogLevel = "info", logFilePath?: string) {
    this.level = LEVELS[level];

    if (logFilePath) {
      const dir = path.dirname(logFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.fileStream = fs.createWriteStream(logFilePath, { flags: "a" });
    }
  }

  /** Enable or disable log sanitization (redacts sensitive fields). */
  setSanitize(enabled: boolean): void {
    this.sanitizeEnabled = enabled;
  }

  /** Suppress console output (file-only). Used in chat mode. */
  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
  }

  private write(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < this.level) return;

    const sanitizedData = this.sanitizeEnabled && data ? Logger.sanitize(data) : data;
    const sanitizedMessage = this.sanitizeEnabled ? Logger.sanitizeString(message) : message;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message: sanitizedMessage,
      ...(sanitizedData && Object.keys(sanitizedData).length > 0 ? { data: sanitizedData } : {}),
    };

    const line = JSON.stringify(entry);

    // Always write to file if available
    this.fileStream?.write(line + "\n");

    if (this.quiet) return;

    // Write to stderr for warn/error, stdout for others
    if (level === "error" || level === "warn") {
      process.stderr.write(line + "\n");
    } else if (LEVELS[level] >= this.level) {
      process.stdout.write(line + "\n");
    }
  }

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.write("debug", component, message, data);
  }

  info(component: string, message: string, data?: Record<string, unknown>): void {
    this.write("info", component, message, data);
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.write("warn", component, message, data);
  }

  error(component: string, message: string, data?: Record<string, unknown>): void {
    this.write("error", component, message, data);
  }

  close(): void {
    this.fileStream?.end();
    this.fileStream = null;
  }

  /** Deep-walk a data object and redact sensitive fields. */
  static sanitize(data: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_FIELDS.has(key)) {
        result[key] = "[REDACTED]";
      } else if (typeof value === "string") {
        result[key] = Logger.sanitizeString(value);
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          typeof item === "object" && item !== null
            ? Logger.sanitize(item as Record<string, unknown>)
            : typeof item === "string" ? Logger.sanitizeString(item) : item
        );
      } else if (typeof value === "object" && value !== null) {
        result[key] = Logger.sanitize(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /** Scrub known secret patterns from a string. */
  static sanitizeString(str: string): string {
    let result = str;
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, "[REDACTED:key]");
    }
    return result;
  }
}

/** Global logger instance — set once in BeerCanEngine */
let _logger: Logger | null = null;

export function setGlobalLogger(logger: Logger): void {
  _logger = logger;
}

export function getLogger(): Logger {
  if (!_logger) {
    _logger = new Logger("info");
  }
  return _logger;
}
