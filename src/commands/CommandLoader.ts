import fs   from "fs";
import path from "path";
import chokidar       from "chokidar";
import { CommandRegistry } from "./CommandRegistry";
import { isValidCommand }  from "./types/ICommand";
import { LoggerManager }   from "../logger/LoggerManager";

const log = LoggerManager.getLogger("CommandLoader");

const isTsNode = Boolean(
  process.env["TS_NODE_DEV"] ??
    (process as unknown as Record<symbol, unknown>)[
      Symbol.for("ts-node.register.instance")
    ]
);

const FILE_EXT = isTsNode ? ".ts" : ".js";

export interface CommandLoaderOptions {
  /** Scan subdirectories recursively. Default: true. */
  recursive?: boolean;
}

export class CommandLoader {
  private readonly registry: CommandRegistry;
  private readonly recursive: boolean;
  private readonly fileMap = new Map<string, string>();
  private watcher?: chokidar.FSWatcher;

  constructor(registry: CommandRegistry, opts: CommandLoaderOptions = {}) {
    this.registry  = registry;
    this.recursive = opts.recursive ?? true;
  }

  async load(directory: string): Promise<void> {
    const absDir = path.resolve(directory);

    if (!fs.existsSync(absDir)) {
      throw new Error(`[CommandLoader] Directory not found: ${absDir}`);
    }

    const files = this.collectFiles(absDir);

    for (const file of files) {
      this.loadFile(file);
    }

    log.info(`Loaded ${this.fileMap.size} command(s) from ${absDir}` +
      (this.recursive ? " (recursive)" : ""));
  }

  watch(directory: string): void {
    const absDir = path.resolve(directory);
    const pattern = this.recursive
      ? path.join(absDir, "**", `*${FILE_EXT}`)
      : path.join(absDir, `*${FILE_EXT}`);

    this.watcher = chokidar.watch(pattern, {
      ignoreInitial: true,
      persistent:    true,
    });

    this.watcher
      .on("add", (filePath) => {
        log.info(`New command file: ${this.relName(filePath, absDir)}`);
        this.loadFile(filePath);
      })
      .on("change", (filePath) => {
        log.info(`Command changed — hot-reloading: ${this.relName(filePath, absDir)}`);
        this.reloadFile(filePath);
      })
      .on("unlink", (filePath) => {
        log.info(`Command removed: ${this.relName(filePath, absDir)}`);
        this.unloadFile(filePath);
      });

    log.info(`Watching for hot-reload in ${absDir}`);
  }

  async stopWatching(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }

  getLoadedFiles(): string[] {
    return Array.from(this.fileMap.keys());
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private collectFiles(dir: string): string[] {
    const result: string[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      log.warn(`Cannot read directory: ${dir}`);
      return result;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && this.recursive) {
        result.push(...this.collectFiles(full));
      } else if (
        entry.isFile() &&
        entry.name.endsWith(FILE_EXT) &&
        !entry.name.startsWith("_")
      ) {
        result.push(full);
      }
    }

    return result;
  }

  private loadFile(filePath: string): void {
    try {
      const mod     = this.requireFresh(filePath) as { command?: unknown };
      const command = mod.command;

      if (!isValidCommand(command)) {
        log.warn(`Skipping ${path.basename(filePath)}: no valid "command" export found.`);
        return;
      }

      this.registry.register(command);
      this.fileMap.set(filePath, command.name);
    } catch (err) {
      log.error(`Failed to load ${path.basename(filePath)}: ${(err as Error).message}`);
    }
  }

  private reloadFile(filePath: string): void {
    this.unloadFile(filePath);
    this.loadFile(filePath);
  }

  private unloadFile(filePath: string): void {
    const name = this.fileMap.get(filePath);
    if (name) {
      this.registry.unregister(name);
      this.fileMap.delete(filePath);
    }
    this.invalidateCache(filePath);
  }

  private requireFresh(filePath: string): unknown {
    this.invalidateCache(filePath);
    return require(filePath);
  }

  private invalidateCache(filePath: string): void {
    try {
      const resolved = require.resolve(filePath);
      delete require.cache[resolved];
    } catch {
      // file may not have been required yet
    }
  }

  private relName(filePath: string, baseDir: string): string {
    return path.relative(baseDir, filePath);
  }
}
