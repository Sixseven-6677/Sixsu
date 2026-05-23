import { LoggerManager }                    from "../../logger/LoggerManager";
import { HealthCheckFn, OnDisconnectedFn }  from "./types/IReconnect";

const log = LoggerManager.getLogger("SessionHealthMonitor");

export interface SessionHealthMonitorOptions {
  /** How often to poll for health (ms). Default: 30 000 */
  intervalMs:      number;
  /** Async function returning true if account is healthy. */
  healthCheck:     HealthCheckFn;
  /** Called when an account is found unhealthy. */
  onDisconnected:  OnDisconnectedFn;
  /** Returns the current list of accounts to monitor. */
  getAccounts:     () => string[];
}

export class SessionHealthMonitor {
  private timer:   ReturnType<typeof setInterval> | null = null;
  private running  = false;
  private readonly opts: SessionHealthMonitorOptions;

  constructor(opts: SessionHealthMonitorOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.timer !== null) return;

    log.info(
      `SessionHealthMonitor started. Interval: ${this.opts.intervalMs}ms`
    );

    this.timer = setInterval(() => {
      if (!this.running) void this.tick();
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("SessionHealthMonitor stopped.");
  }

  /** Force an immediate health check outside the normal interval. */
  async checkNow(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    this.running = true;
    const accounts = this.opts.getAccounts();

    for (const id of accounts) {
      try {
        const healthy = await this.opts.healthCheck(id);
        if (!healthy) {
          log.warn(`Health check FAILED for account: ${id}`);
          this.opts.onDisconnected(id);
        } else {
          log.info(`Health check OK for account: ${id}`);
        }
      } catch (err) {
        log.error(`Health check threw for account "${id}".`, err);
        this.opts.onDisconnected(id);
      }
    }

    this.running = false;
  }
}
