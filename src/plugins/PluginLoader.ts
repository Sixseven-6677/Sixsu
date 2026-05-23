import fs   from "fs";
import path from "path";
import chokidar          from "chokidar";
import { IPlugin, isValidPlugin } from "./types/IPlugin";
import { LoggerManager }          from "../logger/LoggerManager";

const log = LoggerManager.getLogger("PluginLoader");

const isTsNode = Boolean(
  process.env["TS_NODE_DEV"] ??
    (process as unknown as Record<symbol, unknown>)[
      Symbol.for("ts-node.register.instance")
    ]
);

const FILE_EXT = isTsNode ? ".ts" : ".js";

export type OnPluginLoad   = (plugin: IPlugin, filePath: string) => Promise<void>;
export type OnPluginUnload = (name: string) => Promise<void>;

/**
 * Discovers, loads, and hot-reloads plugin files from a directory.
 *
 * Supports two export styles:
 *   export default class MyPlugin implements IPlugin { ... }   (class — instantiated)
 *   export default new MyPlugin()                              (instance — used as-is)
 *   export const plugin = new MyPlugin()                       (named instance)
 */
export class PluginLoader {
  private readonly fileToName = new Map<string, string>();
  private watcher?: chokidar.FSWatcher;

  private onLoadHandler?:   OnPluginLoad;
  private onUnloadHandler?: OnPluginUnload;

  setHandlers(onLoad: OnPluginLoad, onUnload: OnPluginUnload): void {
    this.onLoadHandler   = onLoad;
    this.onUnloadHandler = onUnload;
  }

  async loadFromDir(directory: string): Promise<void> {
    const absDir = path.resolve(directory);

    if (!fs.existsSync(absDir)) {
      log.warn(
        `Plugins directory not found: "${absDir}" — ` +
        `no plugins auto-loaded. Create the directory to use plugins.`
      );
      return;
    }

    const files = this.collectFiles(absDir);
    for (const file of files) {
      await this.loadFile(file);
    }

    log.info(`Loaded ${this.fileToName.size} plugin(s) from "${absDir}".`);
  }

  watch(directory: string): void {
    const absDir  = path.resolve(directory);
    const pattern = path.join(absDir, "**", `*${FILE_EXT}`);

    this.watcher = chokidar.watch(pattern, {
      ignoreInitial: true,
      persistent:    true,
    });

    this.watcher
      .on("add", async (fp) => {
        log.info(`New plugin file detected: ${path.relative(absDir, fp)}`);
        await this.loadFile(fp);
      })
      .on("change", async (fp) => {
        log.info(`Plugin changed — hot-reloading: ${path.relative(absDir, fp)}`);
        await this.reloadFile(fp);
      })
      .on("unlink", async (fp) => {
        log.info(`Plugin file removed: ${path.relative(absDir, fp)}`);
        await this.unloadFile(fp);
      });

    log.info(`Watching for plugin hot-reload in "${absDir}".`);
  }

  async stopWatching(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async loadFile(filePath: string): Promise<void> {
    try {
      const mod = this.requireFresh(filePath) as {
        default?: unknown;
        plugin?:  unknown;
      };

      const raw    = mod.default ?? mod.plugin;
      const plugin = this.resolvePlugin(raw, filePath);

      if (!plugin) return;

      this.fileToName.set(filePath, plugin.manifest.name);
      await this.onLoadHandler?.(plugin, filePath);
    } catch (err) {
      log.error(
        `Failed to load plugin from "${path.basename(filePath)}": ` +
        `${(err as Error).message}`
      );
    }
  }

  private async reloadFile(filePath: string): Promise<void> {
    await this.unloadFile(filePath);
    await this.loadFile(filePath);
  }

  private async unloadFile(filePath: string): Promise<void> {
    const name = this.fileToName.get(filePath);
    if (name) {
      await this.onUnloadHandler?.(name);
      this.fileToName.delete(filePath);
    }
    this.invalidateCache(filePath);
  }

  private resolvePlugin(raw: unknown, filePath: string): IPlugin | null {
    const base = path.basename(filePath);

    if (typeof raw === "function") {
      try {
        const instance = new (raw as new () => IPlugin)();
        if (isValidPlugin(instance)) return instance;
      } catch {
        // not a no-arg constructor — fall through
      }
    }

    if (isValidPlugin(raw)) return raw;

    log.warn(
      `Skipping "${base}": no valid default/plugin export found. ` +
      `Export a class (default export) or an IPlugin instance.`
    );
    return null;
  }

  private requireFresh(filePath: string): unknown {
    this.invalidateCache(filePath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(filePath);
  }

  private invalidateCache(filePath: string): void {
    try {
      const resolved = require.resolve(filePath);
      delete require.cache[resolved];
    } catch {
      /* not yet required */
    }
  }

  private collectFiles(dir: string): string[] {
    const result: string[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      log.warn(`Cannot read plugins directory: "${dir}".`);
      return result;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...this.collectFiles(full));
      } else if (
        entry.isFile()                    &&
        entry.name.endsWith(FILE_EXT)     &&
        !entry.name.startsWith("_")
      ) {
        result.push(full);
      }
    }

    return result;
  }
}
