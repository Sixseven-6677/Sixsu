import { ISystem }                 from "../../core/interfaces/ISystem";
import { AuthManager }             from "../auth/AuthManager";
import { SessionManager }          from "../session/SessionManager";
import { RetryPolicy }             from "./RetryPolicy";
import { ReconnectGuard }          from "./ReconnectGuard";
import { SessionHealthMonitor }    from "./SessionHealthMonitor";
import {
  ReconnectRecord,
  ReconnectStatus,
  RetryAttempt,
  ReconnectManagerOptions,
  HealthCheckFn,
} from "./types/IReconnect";
import { LoggerManager }           from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("ReconnectManager");

const HEALTH_CHECK_INTERVAL_MS = 30_000;

export class ReconnectManager implements ISystem {
  readonly name = "reconnect";

  private readonly auth:    AuthManager;
  private readonly session: SessionManager;
  private readonly policy:  RetryPolicy;
  private readonly guard:   ReconnectGuard;
  private readonly records  = new Map<string, ReconnectRecord>();

  private monitor:     SessionHealthMonitor | null = null;
  private customCheck: HealthCheckFn | null = null;
  private readonly opts: Required<ReconnectManagerOptions>;

  constructor(
    auth:    AuthManager,
    session: SessionManager,
    options: ReconnectManagerOptions = {}
  ) {
    this.auth    = auth;
    this.session = session;

    this.opts = {
      retry:                 options.retry                 ?? {},
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS,
      spamWindowMs:          options.spamWindowMs          ?? 60_000,
      maxAttemptsPerWindow:  options.maxAttemptsPerWindow  ?? 3,
    };

    this.policy = new RetryPolicy(this.opts.retry);
    this.guard  = new ReconnectGuard({
      windowMs:             this.opts.spamWindowMs,
      maxAttemptsPerWindow: this.opts.maxAttemptsPerWindow,
    });
  }

  /** Override the default health check (just checks isAuthenticated). */
  setHealthCheck(fn: HealthCheckFn): this {
    this.customCheck = fn;
    return this;
  }

  async initialize(): Promise<void> {
    log.info("ReconnectManager initialized.");
    this.startMonitor();
  }

  async destroy(): Promise<void> {
    this.monitor?.stop();
    this.monitor = null;
    this.records.clear();
    log.info("ReconnectManager destroyed.");
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Trigger a reconnect for a specific account immediately.
   * Respects the guard — blocked accounts are skipped.
   */
  async reconnect(accountId: string): Promise<boolean> {
    if (!this.guard.isAllowed(accountId)) {
      const until = this.guard.blockedUntil(accountId);
      log.warn(
        `Reconnect for "${accountId}" is blocked` +
        (until ? ` until ${until.toISOString()}.` : ".")
      );
      this.setStatus(accountId, ReconnectStatus.BLOCKED);
      return false;
    }

    return this.runRetryLoop(accountId);
  }

  getRecord(accountId: string): ReconnectRecord | null {
    return this.records.get(accountId) ?? null;
  }

  getAllRecords(): ReconnectRecord[] {
    return Array.from(this.records.values());
  }

  summary(): { total: number; connected: number; failed: number; blocked: number } {
    const all = this.getAllRecords();
    return {
      total:     all.length,
      connected: all.filter((r) => r.status === ReconnectStatus.CONNECTED).length,
      failed:    all.filter((r) => r.status === ReconnectStatus.FAILED).length,
      blocked:   all.filter((r) => r.status === ReconnectStatus.BLOCKED).length,
    };
  }

  // ─── Core retry loop ────────────────────────────────────────────────────────

  private async runRetryLoop(accountId: string): Promise<boolean> {
    this.setStatus(accountId, ReconnectStatus.RETRYING);

    const record   = this.ensureRecord(accountId);
    let   attempt  = 0;

    log.info(`[${accountId}] Starting reconnect. Max attempts: ${this.policy.maxAttempts}`);

    while (this.policy.shouldRetry(attempt)) {
      const delayMs = attempt === 0 ? 0 : this.policy.computeDelay(attempt - 1);

      if (delayMs > 0) {
        log.info(
          `[${accountId}] Attempt ${attempt + 1}/${this.policy.maxAttempts} — waiting ${delayMs}ms before retry.`
        );
        await this.policy.sleep(delayMs);
      }

      this.guard.record(accountId);

      // Re-check guard after sleep (may have been blocked by then)
      if (!this.guard.isAllowed(accountId)) {
        log.warn(`[${accountId}] Guard blocked during retry loop.`);
        this.setStatus(accountId, ReconnectStatus.BLOCKED);
        return false;
      }

      log.info(`[${accountId}] Attempt ${attempt + 1}/${this.policy.maxAttempts}...`);
      record.lastAttemptAt = new Date();

      const { success, error } = await this.attemptLogin(accountId);

      const entry: RetryAttempt = {
        attempt: attempt + 1,
        at:      new Date(),
        delayMs,
        error:   error ?? null,
        success,
      };

      record.attempts.push(entry);
      record.totalRuns += 1;

      if (success) {
        this.guard.reset(accountId);
        record.nextAttemptAt = null;
        this.setStatus(accountId, ReconnectStatus.CONNECTED);
        log.info(`[${accountId}] ✓ Reconnected successfully on attempt ${attempt + 1}.`);
        return true;
      }

      log.warn(
        `[${accountId}] ✗ Attempt ${attempt + 1} failed: ${error ?? "unknown error"}`
      );

      attempt++;

      if (this.policy.shouldRetry(attempt)) {
        const nextDelay     = this.policy.computeDelay(attempt - 1);
        record.nextAttemptAt = new Date(Date.now() + nextDelay);
      }
    }

    // All attempts exhausted
    this.setStatus(accountId, ReconnectStatus.FAILED);
    record.nextAttemptAt = null;

    log.error(
      `[${accountId}] ✗ All ${this.policy.maxAttempts} reconnect attempts failed. ` +
      `Manual intervention required.`
    );

    return false;
  }

  // ─── Login attempt ──────────────────────────────────────────────────────────

  private async attemptLogin(
    accountId: string
  ): Promise<{ success: boolean; error?: string }> {
    log.info(`[${accountId}] Attempting login via AuthManager...`);

    const result = await this.auth.login(accountId);

    if (!result.success) {
      return { success: false, error: result.error ?? "AuthManager returned failure" };
    }

    log.info(`[${accountId}] Login succeeded. Saving session...`);

    try {
      await this.session.saveSession(accountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[${accountId}] Session save failed after login: ${msg}`);
      return { success: false, error: `Session save failed: ${msg}` };
    }

    return { success: true };
  }

  // ─── Health monitor ─────────────────────────────────────────────────────────

  private startMonitor(): void {
    this.monitor = new SessionHealthMonitor({
      intervalMs: this.opts.healthCheckIntervalMs,

      healthCheck: this.customCheck ?? (async (id) => {
        const sessionStatus = this.session.validate(id);
        return sessionStatus.valid;
      }),

      onDisconnected: (accountId) => {
        log.warn(`[${accountId}] Health monitor detected disconnection.`);
        // Only trigger if not already retrying or blocked
        const record = this.records.get(accountId);
        if (
          record &&
          (record.status === ReconnectStatus.RETRYING ||
           record.status === ReconnectStatus.BLOCKED)
        ) {
          return;
        }
        void this.reconnect(accountId);
      },

      getAccounts: () => this.auth.getAuthenticatedAccounts(),
    });

    this.monitor.start();
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private setStatus(accountId: string, status: ReconnectStatus): void {
    const record = this.ensureRecord(accountId);
    record.status = status;

    const emoji: Record<ReconnectStatus, string> = {
      [ReconnectStatus.IDLE]:      "⚪",
      [ReconnectStatus.RETRYING]:  "🔄",
      [ReconnectStatus.CONNECTED]: "🟢",
      [ReconnectStatus.FAILED]:    "🔴",
      [ReconnectStatus.BLOCKED]:   "🚫",
    };

    log.info(`[${accountId}] Status → ${emoji[status]} ${status}`);
  }

  private ensureRecord(accountId: string): ReconnectRecord {
    if (!this.records.has(accountId)) {
      this.records.set(accountId, {
        accountId,
        status:        ReconnectStatus.IDLE,
        attempts:      [],
        lastAttemptAt: null,
        nextAttemptAt: null,
        blockedUntil:  null,
        totalRuns:     0,
      });
    }
    return this.records.get(accountId)!;
  }
}
