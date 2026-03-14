import fs from "fs";
import path from "path";
import { EventBus, type BeerCanEvent } from "../event-bus.js";

// ── Filesystem Watcher Source ───────────────────────────────
// Watches directories for file changes and emits events.

export interface FilesystemWatchConfig {
  projectSlug: string;
  watchPaths: string[];
  /** Glob patterns to include (if empty, watch all) */
  includePatterns?: string[];
  /** Glob patterns to exclude */
  excludePatterns?: string[];
}

export class FilesystemSource {
  private bus: EventBus;
  private watchers: fs.FSWatcher[] = [];
  private configs: FilesystemWatchConfig[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  /** Add a watch configuration */
  addWatch(config: FilesystemWatchConfig): void {
    this.configs.push(config);
  }

  async start(): Promise<void> {
    for (const config of this.configs) {
      for (const watchPath of config.watchPaths) {
        if (!fs.existsSync(watchPath)) {
          console.warn(`[fs-watch] Path does not exist: ${watchPath}`);
          continue;
        }

        try {
          const watcher = fs.watch(
            watchPath,
            { recursive: true },
            (eventType, filename) => {
              if (!filename) return;

              // Check exclusion patterns
              if (this.shouldExclude(filename, config)) return;

              // Debounce rapid changes to same file
              const key = `${watchPath}:${filename}`;
              const existing = this.debounceTimers.get(key);
              if (existing) clearTimeout(existing);

              this.debounceTimers.set(
                key,
                setTimeout(() => {
                  this.emitFileEvent(config.projectSlug, watchPath, filename, eventType);
                  this.debounceTimers.delete(key);
                }, 500) // 500ms debounce
              );
            }
          );

          this.watchers.push(watcher);
          console.log(`[fs-watch] Watching: ${watchPath} for ${config.projectSlug}`);
        } catch (err: any) {
          console.warn(`[fs-watch] Failed to watch ${watchPath}: ${err.message}`);
        }
      }
    }
  }

  async stop(): Promise<void> {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private emitFileEvent(
    projectSlug: string,
    watchPath: string,
    filename: string,
    eventType: string
  ): void {
    const fullPath = path.join(watchPath, filename);
    const event: BeerCanEvent = {
      type: "file.changed",
      projectSlug,
      source: "filesystem",
      data: {
        eventType, // 'rename' or 'change'
        filename,
        fullPath,
        watchPath,
        exists: fs.existsSync(fullPath),
      },
      timestamp: new Date().toISOString(),
    };

    this.bus.publish(event);
  }

  private shouldExclude(filename: string, config: FilesystemWatchConfig): boolean {
    // Simple pattern matching (not full glob, but covers common cases)
    const excludes = config.excludePatterns ?? [
      "node_modules",
      ".git",
      ".DS_Store",
      "dist",
    ];

    for (const pattern of excludes) {
      if (filename.includes(pattern)) return true;
    }

    if (config.includePatterns && config.includePatterns.length > 0) {
      const ext = path.extname(filename);
      return !config.includePatterns.some(
        (p) => filename.endsWith(p) || ext === p
      );
    }

    return false;
  }
}
