import path from "path";
import { ISystem }                  from "../core/interfaces/ISystem";
import { IPlugin }                  from "./types/IPlugin";
import { PluginStatus, PluginEntry } from "./types/PluginStatus";
import { PluginRegistry }           from "./PluginRegistry";
import { PluginLoader }             from "./PluginLoader";
import { PluginEventBus }           from "./PluginEventBus";
import { PluginServiceRegistry }    from "./PluginServiceRegistry";
import { PluginConfigStore }        from "./PluginConfigStore";
import { PluginContext }            from "./PluginContext";
import {
  PluginDependencyError,
  PluginCircularDependencyError,
} from "./errors/PluginErrors";
import { CommandRegistry }  from "../commands/CommandRegistry";
import { TaskScheduler }    from "../scheduler/TaskScheduler";
import { LoggerManager }    from "../logger/LoggerManager";

const log = LoggerManager.getLogger("PluginManager");

export interface PluginManagerOptions {
  commandRegistry: CommandRegistry;
  scheduler:       TaskScheduler;
  /** Directory to scan for plugin files. */
  pluginsDir:      string;
  /** Directory to look for <pluginName>/config.json files. Defaults to pluginsDir. */
  configsDir?:     string;
  /** Watch for file changes and hot-reload. Default: true. */
  watch?:          boolean;
}

/**
 * Orchestrates the full plugin lifecycle:
 *   discover → load → enable → (running) → disable → unload
 *
 * Implements ISystem so Bot manages its startup/shutdown order.
 * Depends on "scheduler" being ready before plugins are enabled.
 */
export class PluginManager implements ISystem {
  readonly name         = "plugin-manager";
  readonly dependencies = ["scheduler"];

  private readonly registry:        PluginRegistry;
  private readonly loader:          PluginLoader;
  private readonly eventBus:        PluginEventBus;
  private readonly serviceRegistry: PluginServiceRegistry;
  private readonly configStore:     PluginConfigStore;
  private readonly commandRegistry: CommandRegistry;
  private readonly scheduler:       TaskScheduler;
  private readonly pluginsDir:      string;
  private readonly enableWatch:     boolean;

  constructor(opts: PluginManagerOptions) {
    this.commandRegistry = opts.commandRegistry;
    this.scheduler       = opts.scheduler;
    this.pluginsDir      = path.resolve(opts.pluginsDir);
    this.enableWatch     = opts.watch ?? true;

    const configsDir     = opts.configsDir
      ? path.resolve(opts.configsDir)
      : this.pluginsDir;

    this.eventBus        = new PluginEventBus();
    this.serviceRegistry = new PluginServiceRegistry();
    this.configStore     = new PluginConfigStore(configsDir);
    this.registry        = new PluginRegistry();
    this.loader          = new PluginLoader();

    this.loader.setHandlers(
      (plugin, fp) => this.loadPlugin(plugin, fp),
      (name)       => this.unloadPlugin(name),
    );
  }

  // ── ISystem ───────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    log.info(`Loading plugins from: "${this.pluginsDir}"`);
    await this.loader.loadFromDir(this.pluginsDir);

    const enableOrder = this.resolveEnableOrder();
    for (const name of enableOrder) {
      await this.enablePlugin(name);
    }

    if (this.enableWatch) {
      this.loader.watch(this.pluginsDir);
    }

    const enabled = this.registry.getEnabled();
    log.info(
      `PluginManager ready. ` +
      `${enabled.length} plugin(s) enabled` +
      (enabled.length > 0 ? `: [${enabled.join(", ")}]` : ".")
    );
  }

  async destroy(): Promise<void> {
    await this.loader.stopWatching();

    const enabled = [...this.registry.getEnabled()].reverse();
    for (const name of enabled) {
      await this.safeDisable(name);
      await this.safeUnload(name);
    }

    this.eventBus.clear();
    log.info("PluginManager destroyed.");
  }

  // ── Public Plugin Control ─────────────────────────────────────────────────

  async loadPlugin(plugin: IPlugin, filePath?: string): Promise<void> {
    const { name, version, defaultConfig } = plugin.manifest;

    if (this.registry.has(name)) {
      log.warn(`Plugin "${name}" is already registered — skipping.`);
      return;
    }

    log.info(`Loading plugin: ${name} v${version}`);
    this.registry.add(plugin, filePath);
    this.registry.transition(name, PluginStatus.LOADING);

    try {
      this.configStore.load(name, defaultConfig ?? {});

      const ctx = new PluginContext(
        name,
        LoggerManager.getLogger(`Plugin:${name}`),
        this.commandRegistry,
        this.scheduler,
        this.eventBus,
        this.serviceRegistry,
        this.configStore,
      );

      await plugin.onLoad(ctx);
      this.registry.setContext(name, ctx);
      this.registry.transition(name, PluginStatus.LOADED);

      log.info(`Plugin loaded: ${name} v${version}`);
    } catch (err) {
      this.registry.markFailed(name, err instanceof Error ? err : new Error(String(err)));
      log.error(`Failed to load plugin "${name}".`, err);
    }
  }

  async enablePlugin(name: string): Promise<void> {
    const status = this.registry.getStatus(name);

    if (status !== PluginStatus.LOADED && status !== PluginStatus.DISABLED) {
      log.warn(
        `Cannot enable "${name}": current status is "${status ?? "unknown"}".`
      );
      return;
    }

    const plugin = this.registry.getPlugin(name);

    for (const dep of plugin.manifest.dependencies ?? []) {
      if (this.registry.getStatus(dep) !== PluginStatus.ENABLED) {
        throw new PluginDependencyError(name, dep);
      }
    }

    this.registry.transition(name, PluginStatus.ENABLING);

    try {
      await plugin.onEnable?.();
      this.registry.transition(name, PluginStatus.ENABLED);
      log.info(`Plugin enabled: ${name}`);
    } catch (err) {
      this.registry.markFailed(name, err instanceof Error ? err : new Error(String(err)));
      log.error(`Failed to enable plugin "${name}".`, err);
    }
  }

  async disablePlugin(name: string): Promise<void> {
    if (this.registry.getStatus(name) !== PluginStatus.ENABLED) return;

    this.registry.transition(name, PluginStatus.DISABLING);

    const plugin = this.registry.getPlugin(name);

    try {
      await plugin.onDisable?.();

      // Dispose context — removes all commands, events, services, tasks
      this.registry.getContext(name)?.dispose();

      this.registry.transition(name, PluginStatus.DISABLED);
      log.info(`Plugin disabled: ${name}`);
    } catch (err) {
      this.registry.markFailed(name, err instanceof Error ? err : new Error(String(err)));
      log.error(`Failed to disable plugin "${name}".`, err);
    }
  }

  async unloadPlugin(name: string): Promise<void> {
    const status = this.registry.getStatus(name);
    if (!status || status === PluginStatus.UNLOADED) return;

    if (status === PluginStatus.ENABLED) {
      await this.disablePlugin(name);
    }

    this.registry.transition(name, PluginStatus.UNLOADING);

    const plugin = this.registry.getPlugin(name);

    try {
      await plugin.onUnload();
      this.configStore.evict(name);
      this.registry.transition(name, PluginStatus.UNLOADED);
      this.registry.remove(name);
      log.info(`Plugin unloaded: ${name}`);
    } catch (err) {
      this.registry.markFailed(name, err instanceof Error ? err : new Error(String(err)));
      log.error(`Failed to unload plugin "${name}".`, err);
    }
  }

  // ── Status ────────────────────────────────────────────────────────────────

  getPluginStatus(): PluginEntry[] {
    return this.registry.getAll();
  }

  getEnabledPlugins(): string[] {
    return this.registry.getEnabled();
  }

  getEventBus(): PluginEventBus {
    return this.eventBus;
  }

  getServiceRegistry(): PluginServiceRegistry {
    return this.serviceRegistry;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async safeDisable(name: string): Promise<void> {
    await this.disablePlugin(name).catch((err: unknown) => {
      log.error(`Error disabling plugin "${name}" during shutdown.`, err);
    });
  }

  private async safeUnload(name: string): Promise<void> {
    await this.unloadPlugin(name).catch((err: unknown) => {
      log.error(`Error unloading plugin "${name}" during shutdown.`, err);
    });
  }

  /**
   * Topologically sorts loaded plugins by declared dependencies.
   * Returns names in the order they should be enabled (dependencies first).
   * Throws PluginCircularDependencyError on cycles.
   */
  private resolveEnableOrder(): string[] {
    const loaded = this.registry
      .getAll()
      .filter((e) => e.status === PluginStatus.LOADED)
      .map((e) => e.pluginName);

    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (name: string, chain: string[]): void => {
      if (visited.has(name)) return;

      if (chain.includes(name)) {
        throw new PluginCircularDependencyError(name, [...chain, name]);
      }

      const plugin = this.registry.getPlugin(name);

      for (const dep of plugin.manifest.dependencies ?? []) {
        if (!this.registry.has(dep)) {
          log.warn(
            `Plugin "${name}" declares dependency on "${dep}" which is not loaded. ` +
            `"${name}" will be skipped.`
          );
          return;
        }
        visit(dep, [...chain, name]);
      }

      visited.add(name);
      result.push(name);
    };

    for (const name of loaded) {
      visit(name, []);
    }

    return result;
  }
}
