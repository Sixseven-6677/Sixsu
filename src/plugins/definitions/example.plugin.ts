/**
 * Example Plugin — Sixsu Bot
 *
 * Demonstrates all Plugin System capabilities:
 *   ✓ Plugin manifest with metadata
 *   ✓ Lifecycle hooks: onLoad / onEnable / onDisable / onUnload
 *   ✓ Registering a command (auto-cleaned on disable)
 *   ✓ Subscribing to an event  (auto-cleaned on disable)
 *   ✓ Providing a service      (auto-cleaned on disable)
 *   ✓ Scheduling a recurring task (auto-cancelled on disable)
 *   ✓ Reading plugin config
 *
 * To create your own plugin, copy this file and:
 *   1. Change the manifest (name, version, description)
 *   2. Replace the command/event/service implementations
 *   3. Drop the file in src/plugins/definitions/
 *
 * The bot will detect the new file and load it automatically (hot-reload).
 */

import { IPlugin, PluginManifest } from "../types/IPlugin";
import { IPluginContext }          from "../types/IPluginContext";
import { ICommand }                from "../../commands/types/ICommand";
import { Context }                 from "../../context/Context";

/** Example service — exposed to other plugins via the service registry. */
export interface IGreeterService {
  greet(name: string): string;
}

class GreeterService implements IGreeterService {
  constructor(private readonly prefix: string) {}
  greet(name: string): string {
    return `${this.prefix} ${name}!`;
  }
}

/** Command registered by this plugin. */
const pingCommand: ICommand = {
  name:        "plugin-ping",
  description: "Pong! Registered by the example plugin.",
  category:    "example",
  async execute(ctx: Context): Promise<void> {
    await ctx.reply("🏓 pong — from example plugin!");
  },
};

export class ExamplePlugin implements IPlugin {
  readonly manifest: PluginManifest = {
    name:    "example",
    version: "1.0.0",
    description: "Example plugin — shows all plugin features.",
    author:      "Sixsu",
    dependencies: [],
    defaultConfig: {
      greeterPrefix: "Hello,",
      heartbeatIntervalMs: 60_000,
    },
  };

  private ctx?: IPluginContext;

  /**
   * onLoad — called once when the module is first loaded.
   * Store ctx; do NOT register commands here.
   */
  async onLoad(ctx: IPluginContext): Promise<void> {
    this.ctx = ctx;
    ctx.logger.info(`Example plugin loaded. (greeterPrefix="${ctx.getConfig("greeterPrefix")}")`);
  }

  /**
   * onEnable — register commands, events, services, tasks.
   * Everything registered via ctx is tracked and auto-cleaned on disable.
   */
  async onEnable(): Promise<void> {
    if (!this.ctx) return;
    const ctx = this.ctx;

    // ── Command ──────────────────────────────────────────────────────────
    ctx.registerCommand(pingCommand);

    // ── Service ──────────────────────────────────────────────────────────
    const prefix = ctx.getConfig<string>("greeterPrefix", "Hello,");
    ctx.provideService<IGreeterService>("greeter", new GreeterService(prefix));

    // ── Events ───────────────────────────────────────────────────────────
    ctx.on("user:message", (data) => {
      ctx.logger.debug("Received user:message event.", data as Record<string, unknown>);
    });

    // ── Recurring task ────────────────────────────────────────────────────
    const intervalMs = ctx.getConfig<number>("heartbeatIntervalMs", 60_000);
    ctx.scheduleRecurring({
      name:       "heartbeat",
      intervalMs,
      fn:         async () => {
        ctx.logger.debug("Example plugin heartbeat tick.");
      },
    });

    ctx.logger.info("Example plugin enabled.");
  }

  /** onDisable — optional custom cleanup beyond what ctx handles automatically. */
  async onDisable(): Promise<void> {
    this.ctx?.logger.info("Example plugin disabled.");
  }

  /** onUnload — release anything NOT tracked by the context. */
  async onUnload(): Promise<void> {
    this.ctx?.logger.info("Example plugin unloaded.");
    this.ctx = undefined;
  }
}

export default ExamplePlugin;
