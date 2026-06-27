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

/** Maximum number of retry attempts stored per account (prevents unbounded growth). */
const MAX_STORED_ATTEMPTS = 50;

/**
 * Circuit Breaker threshold.
 * After ONE complete runRetryLoop() failure (all maxAttempts exhausted),
 * the circuit opens (CIRCUIT_OPEN) and all future reconnect attempts are
 * blocked — both from health-monitor and from onPermanentFailure hooks —
 * until resetCircuit() is called explicitly (e.g. when new credentials arrive).
 *
 * This prevents the 1,304-reconnect loop where expired credentials caused
 * infinite cycles: MiraiTransport(5) → ReconnectManager(5) → health-monitor → repeat.
 */
const CIRCUIT_OPEN_AFTER_FAILURES = 1;

export class ReconnectManager implements ISystem {
  readonly name = "reconnect";

  private readonly auth:    AuthManager;
  private readonly session: SessionManager;
  private readonly policy:  RetryPolicy;
  private readonly guard:   ReconnectGuard;
  private readonly records  = new Map<string, ReconnectRecord>();

  /** Tracks how many complete runRetryLoop() cycles failed per account. */
  private readonly circuitFailures = new Map<string, number>();

  private monitor:      SessionHealthMonitor | null = null;
  private customCheck:  HealthCheckFn | null = null;
  /** Called after auth credentials are refreshed so the transport can re-connect MQTT. */
  private restartHook:  ((accountId: string) => Promise<void>) | null = null;
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

  /** Override the default health check (checks MQTT connectivity instead of just session). */
  setHealthCheck(fn: HealthCheckFn): this {
    this.customCheck = fn;
    return this;
  }

  /**
   * Register a callback that is invoked after credentials are successfully refreshed.
   * Use this to bridge the auth layer and the MQTT transport layer: without this hook,
   * ReconnectManager refreshes credentials but MQTT stays disconnected because
   * MiraiTransport is not aware of the credential refresh.
   */
  setRestartHook(fn: (accountId: string) => Promise<void>): this {
    this.restartHook = fn;
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

  async reconnect(accountId: string): Promise<boolean> {
    // ── Circuit breaker: block if OPEN ─────────────────────────────────────
    const record = this.records.get(accountId);
    if (record?.status === ReconnectStatus.CIRCUIT_OPEN) {
      log.warn(
        `[${accountId}] 🔴 Circuit OPEN — reconnect() blocked. ` +
        `Provide fresh credentials and call resetCircuit("${accountId}") to re-enable. ` +
        `[circuit-open]`,
        { circuitFailures: this.circuitFailures.get(accountId) ?? 0 },
      );
      return false;
    }

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

  /**
   * Manually reset the circuit breaker for an account.
   *
   * Call this after providing fresh credentials (e.g. email/password login
   * succeeded, or the user updated FB_APPSTATE). This clears the CIRCUIT_OPEN
   * status, resets the failure counter, and allows the health monitor and
   * reconnect() to attempt a fresh cycle.
   */
  resetCircuit(accountId: string): void {
    const prev = this.records.get(accountId)?.status ?? "NONE";
    this.circuitFailures.delete(accountId);
    this.guard.reset(accountId);
    this.setStatus(accountId, ReconnectStatus.IDLE);
    log.info(
      `[${accountId}] ✅ Circuit RESET (${prev} → IDLE). ` +
      `New reconnect cycle allowed. [circuit-reset]`,
    );
  }

  getRecord(accountId: string): ReconnectRecord | null {
    return this.records.get(accountId) ?? null;
  }

  getAllRecords(): ReconnectRecord[] {
    return Array.from(this.records.values());
  }

  summary(): { total: number; connected: number; failed: number; blocked: number; circuitOpen: number } {
    const all = this.getAllRecords();
    return {
      total:       all.length,
      connected:   all.filter((r) => r.status === ReconnectStatus.CONNECTED).length,
      failed:      all.filter((r) => r.status === ReconnectStatus.FAILED).length,
      blocked:     all.filter((r) => r.status === ReconnectStatus.BLOCKED).length,
      circuitOpen: all.filter((r) => r.status === ReconnectStatus.CIRCUIT_OPEN).length,
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
      if (record.attempts.length > MAX_STORED_ATTEMPTS) {
        record.attempts.splice(0, record.attempts.length - MAX_STORED_ATTEMPTS);
      }
      record.totalRuns += 1;

      if (success) {
        this.guard.reset(accountId);
        this.circuitFailures.delete(accountId);
        record.nextAttemptAt = null;
        this.setStatus(accountId, ReconnectStatus.CONNECTED);
        log.info(`[${accountId}] ✓ Reconnected successfully on attempt ${attempt + 1}. Circuit closed.`);
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

    // ── All attempts exhausted — trip the circuit breaker ──────────────────
    const failures = (this.circuitFailures.get(accountId) ?? 0) + 1;
    this.circuitFailures.set(accountId, failures);
    record.nextAttemptAt = null;

    if (failures >= CIRCUIT_OPEN_AFTER_FAILURES) {
      // Circuit OPEN: block all future reconnect attempts.
      // Prevents the health-monitor / onPermanentFailure loop that caused 1,304 reconnects.
      this.setStatus(accountId, ReconnectStatus.CIRCUIT_OPEN);
      log.error(
        `[${accountId}] 🔴 Circuit OPEN after ${failures} full retry cycle(s). ` +
        `All reconnect attempts are now blocked. ` +
        `Action required: provide fresh credentials, then call resetCircuit("${accountId}"). ` +
        `[circuit-open]`,
        {
          failureCycles:    failures,
          totalLoopAttempts: this.policy.maxAttempts * failures,
          hint: "Set FB_APPSTATE or FB_EMAIL+FB_PASSWORD and redeploy, then circuit auto-resets on next startup.",
        },
      );
    } else {
      this.setStatus(accountId, ReconnectStatus.FAILED);
      log.error(
        `[${accountId}] ✗ All ${this.policy.maxAttempts} reconnect attempts failed. ` +
        `Failure cycle ${failures}/${CIRCUIT_OPEN_AFTER_FAILURES}. ` +
        `Circuit will open after ${CIRCUIT_OPEN_AFTER_FAILURES} cycle(s). ` +
        `Manual intervention required.`,
      );
    }

    return false;
  }

  // ─── Login attempt ──────────────────────────────────────────────────────────

  private async attemptLogin(
    accountId: string
  ): Promise<{ success: boolean; error?: string }> {
    log.info(`[${accountId}] Attempting credential refresh…`);

    let sessionRestored = false;
    try {
      sessionRestored = await this.session.restoreSession(accountId);
      if (sessionRestored) {
        log.info(`[${accountId}] Auth: fresh cookies loaded from session store. [session-restore]`);
      }
    } catch (restoreErr) {
      log.warn(`[${accountId}] Session restore failed — falling back to env credentials.`, {
        error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
      });
    }

    if (!sessionRestored) {
      log.info(`[${accountId}] Auth: no session store data — loading from env/file provider.`);
      const result = await this.auth.login(accountId);
      if (!result.success) {
        return { success: false, error: result.error ?? "AuthManager returned failure" };
      }
      log.info(`[${accountId}] Auth login succeeded (env/file).`);
    }

    try {
      await this.session.saveSession(accountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[${accountId}] Session save failed after login: ${msg}`);
      return { success: false, error: `Session save failed: ${msg}` };
    }

    if (this.restartHook) {
      try {
        log.info(`[${accountId}] Invoking transport restart hook to reconnect MQTT...`);
        await this.restartHook(accountId);
        log.info(`[${accountId}] Transport restart hook completed.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[${accountId}] Transport restart hook threw: ${msg}`);
      }
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
        const record = this.records.get(accountId);

        // ── Circuit breaker: OPEN state — never auto-retry ─────────────────
        // This is the core fix for the 1,304-reconnect loop.
        // When credentials are expired, every health check was triggering a
        // new reconnect cycle even after ReconnectManager had already exhausted
        // all retry attempts. The CIRCUIT_OPEN status blocks all health-monitor
        // reconnects until new credentials are explicitly provided.
        if (record?.status === ReconnectStatus.CIRCUIT_OPEN) {
          log.warn(
            `[${accountId}] 🔴 Health monitor: circuit OPEN — skipping auto-reconnect. ` +
            `Provide fresh credentials and call resetCircuit(). [circuit-open]`,
          );
          return;
        }

        // If already retrying — skip, don't launch parallel reconnects
        if (record?.status === ReconnectStatus.RETRYING) {
          log.debug(`[${accountId}] Health check: already retrying — skip.`);
          return;
        }

        // ── Self-healing: BLOCKED state recovery ──────────────────────────────
        if (record?.status === ReconnectStatus.BLOCKED) {
          const stillBlocked = this.guard.blockedUntil(accountId) !== null;
          if (stillBlocked) {
            log.debug(`[${accountId}] Health check: blocked — waiting for window to expire.`);
            return;
          }
          log.info(
            `[${accountId}] Health check: block window expired — resetting BLOCKED → IDLE ` +
            `and scheduling reconnect. [self-healing]`
          );
          this.setStatus(accountId, ReconnectStatus.IDLE);
        }

        // ── FAILED state: trip the circuit immediately ─────────────────────
        // Prevents a FAILED account from being retried by health monitor.
        // The circuit will be properly managed on the next reconnect() call.
        if (record?.status === ReconnectStatus.FAILED) {
          log.warn(
            `[${accountId}] Health monitor: previous cycle FAILED — opening circuit to prevent loop. [circuit-open]`,
          );
          const failures = (this.circuitFailures.get(accountId) ?? 0) + 1;
          this.circuitFailures.set(accountId, failures);
          this.setStatus(accountId, ReconnectStatus.CIRCUIT_OPEN);
          return;
        }

        log.warn(`[${accountId}] Health monitor detected disconnection. Scheduling reconnect.`);

        this.reconnect(accountId).catch((err: unknown) => {
          log.error(
            `[${accountId}] Reconnect triggered by health monitor threw unexpectedly.`,
            err instanceof Error ? err : new Error(String(err))
          );
        });
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
      [ReconnectStatus.IDLE]:         "⚪",
      [ReconnectStatus.RETRYING]:     "🔄",
      [ReconnectStatus.CONNECTED]:    "🟢",
      [ReconnectStatus.FAILED]:       "🔴",
      [ReconnectStatus.BLOCKED]:      "🚫",
      [ReconnectStatus.CIRCUIT_OPEN]: "⛔",
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
