import fs   from "fs";
import path from "path";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("PluginConfigStore");

/**
 * Per-plugin configuration storage.
 *
 * Config resolution order (highest wins):
 *   1. File config  — <configsDir>/<pluginName>/config.json
 *   2. Default config — PluginManifest.defaultConfig
 *
 * Example file path: src/plugins/definitions/my-plugin/config.json
 */
export class PluginConfigStore {
  private readonly configsDir: string;
  private readonly cache = new Map<string, Record<string, unknown>>();

  constructor(configsDir: string) {
    this.configsDir = configsDir;
  }

  load(
    pluginName: string,
    defaults: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const filePath = path.join(this.configsDir, pluginName, "config.json");
    let fileConfig: Record<string, unknown> = {};

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        fileConfig = JSON.parse(raw) as Record<string, unknown>;
        log.info(
          `Config loaded for plugin "${pluginName}" from ${filePath}.`
        );
      } catch (err) {
        log.warn(
          `Failed to parse config for plugin "${pluginName}": ` +
          `${(err as Error).message}`
        );
      }
    }

    const merged = { ...defaults, ...fileConfig };
    this.cache.set(pluginName, merged);
    return merged;
  }

  get<T = unknown>(pluginName: string, key: string, fallback?: T): T {
    const config = this.cache.get(pluginName) ?? {};
    const value  = config[key];
    return (value !== undefined ? value : fallback) as T;
  }

  getAll(pluginName: string): Record<string, unknown> {
    return { ...(this.cache.get(pluginName) ?? {}) };
  }

  evict(pluginName: string): void {
    this.cache.delete(pluginName);
  }
}
