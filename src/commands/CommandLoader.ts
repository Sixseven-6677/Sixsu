import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { CommandRegistry } from "./CommandRegistry";
import { isValidCommand } from "./types/ICommand";

const isTsNode = Boolean(
  process.env["TS_NODE_DEV"] ??
    (process as unknown as Record<symbol, unknown>)[
      Symbol.for("ts-node.register.instance")
    ]
);

const FILE_EXT = isTsNode ? ".ts" : ".js";

export class CommandLoader {
  private readonly registry: CommandRegistry;
  private readonly fileMap = new Map<string, string>();
  private watcher?: chokidar.FSWatcher;

  constructor(registry: CommandRegistry) {
    this.registry = registry;
  }

  async load(directory: string): Promise<void> {
    const absDir = path.resolve(directory);

    if (!fs.existsSync(absDir)) {
      throw new Error(`[CommandLoader] Directory not found: ${absDir}`);
    }

    const files = fs
      .readdirSync(absDir)
      .filter((f) => f.endsWith(FILE_EXT) && !f.startsWith("_"))
      .map((f) => path.join(absDir, f));

    for (const file of files) {
      this.loadFile(file);
    }

    console.log(
      `[CommandLoader] Loaded ${this.fileMap.size} command(s) from ${absDir}`
    );
  }

  watch(directory: string): void {
    const absDir = path.resolve(directory);
    const pattern = path.join(absDir, `*${FILE_EXT}`);

    this.watcher = chokidar.watch(pattern, {
      ignoreInitial: true,
      persistent: true,
    });

    this.watcher
      .on("add", (filePath) => {
        console.log(`[CommandLoader] New command file detected: ${path.basename(filePath)}`);
        this.loadFile(filePath);
      })
      .on("change", (filePath) => {
        console.log(`[CommandLoader] Command file changed: ${path.basename(filePath)}`);
        this.reloadFile(filePath);
      })
      .on("unlink", (filePath) => {
        console.log(`[CommandLoader] Command file removed: ${path.basename(filePath)}`);
        this.unloadFile(filePath);
      });

    console.log(`[CommandLoader] Watching for changes in ${absDir}`);
  }

  async stopWatching(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }

  private loadFile(filePath: string): void {
    try {
      const mod = this.requireFresh(filePath) as { command?: unknown };
      const command = mod.command;

      if (!isValidCommand(command)) {
        console.warn(
          `[CommandLoader] Skipping ${path.basename(filePath)}: no valid "command" export found.`
        );
        return;
      }

      this.registry.register(command);
      this.fileMap.set(filePath, command.name);
    } catch (err) {
      console.error(
        `[CommandLoader] Failed to load ${path.basename(filePath)}:`,
        err
      );
    }
  }

  private reloadFile(filePath: string): void {
    this.unloadFile(filePath);
    this.loadFile(filePath);
  }

  private unloadFile(filePath: string): void {
    const commandName = this.fileMap.get(filePath);
    if (commandName) {
      this.registry.unregister(commandName);
      this.fileMap.delete(filePath);
    }
    this.invalidateCache(filePath);
  }

  private requireFresh(filePath: string): unknown {
    this.invalidateCache(filePath);
    return require(filePath);
  }

  private invalidateCache(filePath: string): void {
    const resolved = require.resolve(filePath);
    delete require.cache[resolved];
  }

  getLoadedFiles(): string[] {
    return Array.from(this.fileMap.keys());
  }
}
