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

export class Logger {
  private level: number;
  private fileStream: fs.WriteStream | null = null;

  constructor(level: LogLevel = "info", logFilePath?: string) {
    this.level = LEVELS[level];

    if (logFilePath) {
      const dir = path.dirname(logFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      this.fileStream = fs.createWriteStream(logFilePath, { flags: "a" });
    }
  }

  private write(level: LogLevel, component: string, message: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < this.level) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    const line = JSON.stringify(entry);

    // Always write to file if available
    this.fileStream?.write(line + "\n");

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
