import { LoggerManager }                    from "../../logger/LoggerManager";
import { HealthCheckFn, OnDisconnectedFn }  from "./types/IReconnect";

const log = LoggerManager.getLogger("SessionHealthMonitor");

export interface SessionHealthMonitorOptions {
  /** Base interval between health checks (ms). Actual interval varies +/-20% to avoid robotic timing. */
  intervalMs:      number;
  /** Async function returning true if account is healthy. */
  healthCheck:     HealthCheckFn;
  /** Called when an account is found unhealthy. */
  onDisconnected:  OnDisconnectedFn;
  /** Returns the current list of accounts to monitor. */
  getAccounts:     () => string[];
}

/** Returns a delay with +/-20% jitter so health checks do not fire on a perfect clock. */
function withJitter(baseMs: number): number {
  const jitter = (Math.random() - 0.5) * 0.4 * baseMs;
  return Math.max(baseMs + jitter, 10_000);
}

export class SessionHealthMonitor {
  private timer:   ReturnType<typeof setTimeout> | null = null;
  private running  = false;
  private readonly opts: SessionHealthMonitorOptions;

  constructor(opts: SessionHealthMonitorOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.timer !== null) return;
    log.info(
      `SessionHealthMonitor started. Base interval: ${this.opts.intervalMs}ms (+/-20% jitter)`
    );
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info("SessionHealthMonitor stopped.");
  }

  /** Force an immediate health check outside the normal interval. */
  async checkNow(): Promise<void> {
    await this.tick();
  }

  private scheduleNext(): void {
    const delay = withJitter(this.opts.intervalMs);
    log.debug(`SessionHealthMonitor: next check in ${Math.round(delay / 1000)}s.`);
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.running) await this.tick();
      this.scheduleNext();
    }, delay);
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