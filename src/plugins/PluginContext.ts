import {
  IPluginContext,
  IDisposable,
  PluginEventHandler,
} from "./types/IPluginContext";
import { ICommand }                               from "../commands/types/ICommand";
import { DelayedTaskOptions, RecurringTaskOptions } from "../scheduler/types/ITask";
import { ILogger }                                from "../logger/types/ILogger";
import { CommandRegistry }                        from "../commands/CommandRegistry";
import { TaskScheduler }                          from "../scheduler/TaskScheduler";
import { PluginEventBus }                         from "./PluginEventBus";
import { PluginServiceRegistry }                  from "./PluginServiceRegistry";
import { PluginConfigStore }                      from "./PluginConfigStore";
import { PluginServiceError }                     from "./errors/PluginErrors";

function toDisposable(fn: () => void): IDisposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      fn();
    },
  };
}

/**
 * Sandboxed API surface given to each plugin.
 *
 * Every registration (command, event listener, service, task) is tracked.
 * Calling dispose() — done automatically by PluginManager on disable/unload —
 * removes everything the plugin registered with zero manual cleanup needed.
 */
export class PluginContext implements IPluginContext {
  readonly pluginName: string;
  readonly logger:     ILogger;

  private readonly disposables: IDisposable[]              = [];
  private readonly ownedHandlers = new Set<PluginEventHandler>();
  private disposed = false;

  constructor(
    pluginName:              string,
    logger:                  ILogger,
    private readonly commandRegistry:  CommandRegistry,
    private readonly scheduler:        TaskScheduler,
    private readonly eventBus:         PluginEventBus,
    private readonly serviceRegistry:  PluginServiceRegistry,
    private readonly configStore:      PluginConfigStore,
  ) {
    this.pluginName = pluginName;
    this.logger     = logger;
  }

  // ── Config ─────────────────────────────────────────────────────────────

  getConfig<T = unknown>(key: string, fallback?: T): T {
    return this.configStore.get<T>(this.pluginName, key, fallback);
  }

  // ── Commands ───────────────────────────────────────────────────────────

  registerCommand(command: ICommand): IDisposable {
    this.guard();
    this.commandRegistry.register(command);
    const d = toDisposable(() => this.commandRegistry.unregister(command.name));
    this.disposables.push(d);
    return d;
  }

  // ── Events ─────────────────────────────────────────────────────────────

  emit(event: string, data?: unknown): void {
    void this.eventBus.emit(event, data);
  }

  on(event: string, handler: PluginEventHandler): IDisposable {
    this.guard();
    this.ownedHandlers.add(handler);
    const off = this.eventBus.on(event, handler);
    const d   = toDisposable(() => {
      off();
      this.ownedHandlers.delete(handler);
    });
    this.disposables.push(d);
    return d;
  }

  // ── Services ────────────────────────────────────────────────────────────

  provideService<T>(name: string, service: T): IDisposable {
    this.guard();
    const unregister = this.serviceRegistry.provide(name, service, this.pluginName);
    const d = toDisposable(unregister);
    this.disposables.push(d);
    return d;
  }

  consumeService<T>(name: string): T | undefined {
    return this.serviceRegistry.consume<T>(name);
  }

  requireService<T>(name: string): T {
    const svc = this.serviceRegistry.consume<T>(name);
    if (svc === undefined) throw new PluginServiceError(this.pluginName, name);
    return svc;
  }

  // ── Scheduling ──────────────────────────────────────────────────────────

  scheduleRecurring(options: Omit<RecurringTaskOptions, "id">): IDisposable {
    this.guard();
    const task = this.scheduler.recur({
      ...options,
      name: `[${this.pluginName}] ${options.name}`,
    });
    const d = toDisposable(() => {
      if (task.isActive()) this.scheduler.cancel(task.id);
    });
    this.disposables.push(d);
    return d;
  }

  scheduleDelayed(options: Omit<DelayedTaskOptions, "id">): IDisposable {
    this.guard();
    const task = this.scheduler.delay({
      ...options,
      name: `[${this.pluginName}] ${options.name}`,
    });
    const d = toDisposable(() => {
      if (task.isActive()) this.scheduler.cancel(task.id);
    });
    this.disposables.push(d);
    return d;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Dispose all tracked resources.
   * Called by PluginManager after onDisable() / onUnload().
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }

    this.disposables.length = 0;
    this.ownedHandlers.clear();
  }

  private guard(): void {
    if (this.disposed) {
      throw new Error(
        `PluginContext for "${this.pluginName}" has already been disposed.`
      );
    }
  }
}
