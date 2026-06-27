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
 * After ONE complete runRetryLoop() failure cycle (all maxAttempts exhausted),
 * the circuit opens — blocking all reconnect attempts until resetCircuit() is
 * called (after new credentials arrive).
 *
 * Root cause this fixes: 1,304-reconnect loop where expired credentials caused
 * MiraiTransport(6) → ReconnectManager(5) → health-monitor → repeat forever.
 */
const CIRCUIT_OPEN_AFTER_FAILURES = 1;

/**
 * How long to wait for MQTT connectivity after transport.restart().
 *
 * restart() calls doLogin() which resolves after the FIRST login attempt
 * (success OR fail), then MiraiTransport schedules retries internally.
 * Without this poll, attemptLogin always returned { success: true } even
 * when the login failed — making the circuit breaker never fire.
 *
 * Poll interval = 1s, total window = VERIFY_CONNECT_MS.
 */
const VERIFY_CONNECT_MS    = 30_000;
const VERIFY_POLL_INTERVAL = 1_000;

export class ReconnectManager implements ISystem {
  readonly name = "reconnect";

  private readonly auth:    AuthManager;
  private readonly session: SessionManager;
  private readonly policy:  RetryPolicy;
  private readonly guard:   ReconnectGuard;
  private readonly records  = new Map<string, ReconnectRecord>();

  /** Tracks how many complete runRetryLoop() failure cycles have occurred per account. */
  private readonly circuitFailures = new Map<string, number>();

  private monitor:      SessionHealthMonitor | null = null;
  private customCheck:  HealthCheckFn | null = null;
  /** Called after credentials refresh — bridges auth layer to MQTT transport. */
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

  setHealthCheck(fn: HealthCheckFn): this {
    this.customCheck = fn;
    return this;
  }

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
    // ── Circuit breaker guard ──────────────────────────────────────────────
    const record = this.records.get(accountId);
    if (record?.status === ReconnectStatus.CIRCUIT_OPEN) {
      log.warn(
        `[${accountId}] ⛔ Circuit OPEN — reconnect() blocked. ` +
        `Provide fresh credentials and call resetCircuit("${accountId}") to re-enable. ` +
        `[circuit-open]`,
        { circuitFailures: this.circuitFailures.get(accountId) ?? 0 },
      );
      return false;
    }

    // ── Spam guard (entry-point only) ──────────────────────────────────────
    // The guard is checked once at entry. We do NOT call guard.record() inside
    // runRetryLoop — each attempt there takes ≥30s (MQTT poll), so 3 attempts
    // in 60s exhausts maxAttemptsPerWindow and causes premature BLOCKED status
    // before the circuit breaker can fire.
    if (!this.guard.isAllowed(accountId)) {
      const until = this.guard.blockedUntil(accountId);
      log.warn(
        `[${accountId}] Reconnect is spam-guarded` +
        (until ? ` until ${until.toISOString()}.` : ".")
      );
      this.setStatus(accountId, ReconnectStatus.BLOCKED);
      return false;
    }
    this.guard.record(accountId);

    return this.runRetryLoop(accountId);
  }

  /**
   * Reset the circuit breaker for an account after new credentials are provided.
   *
   * Call this when:
   *  - User updated FB_APPSTATE
   *  - EmailPasswordProvider successfully obtained fresh cookies
   *  - AuthPipeline completed a successful stage
   *
   * Clears CIRCUIT_OPEN, resets the failure counter, and allows health-monitor
   * and reconnect() to attempt a fresh cycle.
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

  summary(): {
    total:       number;
    connected:   number;
    failed:      number;
    blocked:     number;
    circuitOpen: number;
  } {
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

    const record  = this.ensureRecord(accountId);
    let   attempt = 0;

    log.info(
      `[${accountId}] Starting reconnect cycle. Max attempts: ${this.policy.maxAttempts}`,
    );

    while (this.policy.shouldRetry(attempt)) {
      const delayMs = attempt === 0 ? 0 : this.policy.computeDelay(attempt - 1);

      if (delayMs > 0) {
        log.info(
          `[${accountId}] Attempt ${attempt + 1}/${this.policy.maxAttempts} ` +
          `— waiting ${delayMs}ms before retry.`
        );
        await this.policy.sleep(delayMs);
      }

      // Note: guard.record() is intentionally NOT called here.
      // Calling it once per attempt (each taking ≥30s) exhausts maxAttemptsPerWindow
      // and causes premature BLOCKED status before the circuit can open.
      // The entry-point guard in reconnect() is sufficient for spam protection.

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
        log.info(
          `[${accountId}] ✓ Reconnected on attempt ${attempt + 1}. ` +
          `Circuit closed. [circuit-closed]`,
        );
        return true;
      }

      log.warn(
        `[${accountId}] ✗ Attempt ${attempt + 1} failed: ${error ?? "unknown"}`
      );
      attempt++;

      if (this.policy.shouldRetry(attempt)) {
        const nextDelay      = this.policy.computeDelay(attempt - 1);
        record.nextAttemptAt = new Date(Date.now() + nextDelay);
      }
    }

    // ── All attempts exhausted → trip the circuit ──────────────────────────
    const failures = (this.circuitFailures.get(accountId) ?? 0) + 1;
    this.circuitFailures.set(accountId, failures);
    record.nextAttemptAt = null;

    if (failures >= CIRCUIT_OPEN_AFTER_FAILURES) {
      this.setStatus(accountId, ReconnectStatus.CIRCUIT_OPEN);
      log.error(
        `[${accountId}] ⛔ Circuit OPEN after ${failures} full retry cycle(s). ` +
        `ALL reconnect attempts are now BLOCKED. ` +
        `Action: provide fresh credentials (update FB_APPSTATE or set FB_EMAIL+FB_PASSWORD), ` +
        `then redeploy — the circuit resets automatically on startup. ` +
        `[circuit-open]`,
        {
          failureCycles:      failures,
          totalLoginAttempts: this.policy.maxAttempts * failures,
        },
      );
    } else {
      this.setStatus(accountId, ReconnectStatus.FAILED);
      log.error(
        `[${accountId}] ✗ All ${this.policy.maxAttempts} attempts failed. ` +
        `Failure cycle ${failures}/${CIRCUIT_OPEN_AFTER_FAILURES}. ` +
        `Circuit opens after next failure.`,
      );
    }

    return false;
  }

  // ─── Login attempt ──────────────────────────────────────────────────────────

  private async attemptLogin(
    accountId: string
  ): Promise<{ success: boolean; error?: string }> {
    log.info(`[${accountId}] Attempting credential refresh…`);

    // ── Step 0: Try fallback providers (email/password) first ─────────────
    //
    // ROOT CAUSE FIX: AppStateProvider.load() reads FB_APPSTATE from env and
    // returns the cookies without any liveness validation — never throws, even
    // when the Facebook session is expired. This means auth.login() always
    // "succeeds" with expired cookies, so EmailPasswordProvider (registered as
    // fallback) is never reached through the normal auth.login() path.
    //
    // In the reconnect context we already know the AppState is likely expired
    // (that's why we're reconnecting). Call loginFallbackOnly() to bypass the
    // main provider and go straight to email/password for fresh cookies.
    let sessionRestored = false;

    if (this.auth.hasFallbacks(accountId)) {
      log.info(
        `[${accountId}] Reconnect: trying email/password fallback first — ` +
        `AppState env cookies are likely expired. [fallback-first]`,
      );
      const fbResult = await this.auth.loginFallbackOnly(accountId);
      if (fbResult.success) {
        log.info(
          `[${accountId}] Email/password login succeeded — fresh cookies obtained. ` +
          `[email-password-ok]`,
        );
        sessionRestored = true; // credentials injected — skip restoreSession + auth.login()
      } else {
        log.warn(
          `[${accountId}] Email/password fallback failed: ${fbResult.error ?? "unknown"}. ` +
          `Falling back to session store / env cookies.`,
        );
      }
    }

    // ── Step 1: restore session or fall back to env ────────────────────────
    if (!sessionRestored) {
      try {
        sessionRestored = await this.session.restoreSession(accountId);
        if (sessionRestored) {
          log.info(`[${accountId}] Auth: fresh cookies from session store. [session-restore]`);
        }
      } catch (restoreErr) {
        log.warn(`[${accountId}] Session restore failed — falling back to env.`, {
          error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
        });
      }
    }

    if (!sessionRestored) {
      log.info(`[${accountId}] Auth: no session data — loading from env/file provider.`);
      const result = await this.auth.login(accountId);
      if (!result.success) {
        return { success: false, error: result.error ?? "AuthManager returned failure" };
      }
    }

    // ── Step 2: persist session ────────────────────────────────────────────
    try {
      await this.session.saveSession(accountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[${accountId}] Session save failed: ${msg}`);
      return { success: false, error: `Session save failed: ${msg}` };
    }

    // ── Step 3: invoke transport restart (starts doLogin async) ───────────
    if (this.restartHook) {
      try {
        log.info(`[${accountId}] Invoking transport restart hook…`);
        await this.restartHook(accountId);
        log.info(`[${accountId}] Restart hook returned. Verifying MQTT connectivity…`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[${accountId}] Transport restart hook threw: ${msg}`);
        return { success: false, error: `Restart hook threw: ${msg}` };
      }
    }

    // ── Step 4: verify actual MQTT connectivity ────────────────────────────
    //
    // restartHook → transport.restart() → doLogin() resolves after the FIRST
    // attempt (success OR fail), then schedules retries internally. Without this
    // poll, attemptLogin always returned { success: true } even on failure —
    // making the circuit breaker never fire (root cause of the 1,304-loop).
    //
    // Poll every 1s for up to VERIFY_CONNECT_MS. If MQTT connects → success.
    // If not → return { success: false } → runRetryLoop increments failure count.
    if (this.customCheck) {
      const deadline  = Date.now() + VERIFY_CONNECT_MS;
      let   connected = false;

      log.info(
        `[${accountId}] Polling MQTT connectivity (max ${VERIFY_CONNECT_MS / 1000}s)…`,
      );

      while (Date.now() < deadline) {
        await new Promise<void>(r => setTimeout(r, VERIFY_POLL_INTERVAL));
        connected = await this.customCheck(accountId);
        if (connected) break;
      }

      if (!connected) {
        log.warn(
          `[${accountId}] ✗ MQTT not connected after ${VERIFY_CONNECT_MS / 1000}s. ` +
          `Credentials are likely expired. [verify-failed]`,
        );
        return {
          success: false,
          error:   `MQTT not connected after ${VERIFY_CONNECT_MS / 1000}s poll`,
        };
      }

      log.info(`[${accountId}] ✓ MQTT connectivity verified. [verify-ok]`);
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

        // ── Circuit breaker: OPEN → never auto-retry ───────────────────────
        // Core fix for the 1,304-reconnect loop.
        // With expired credentials, every health-check triggered a new reconnect
        // cycle even after all retry attempts were exhausted. CIRCUIT_OPEN blocks
        // all health-monitor reconnects until new credentials and resetCircuit().
        if (record?.status === ReconnectStatus.CIRCUIT_OPEN) {
          log.warn(
            `[${accountId}] ⛔ Health monitor: circuit OPEN — not retrying. ` +
            `Update credentials and redeploy, or call resetCircuit(). [circuit-open]`,
          );
          return;
        }

        // If already retrying — don't launch parallel reconnect
        if (record?.status === ReconnectStatus.RETRYING) {
          log.debug(`[${accountId}] Health check: already retrying — skip.`);
          return;
        }

        // ── BLOCKED state recovery after guard window expires ──────────────
        if (record?.status === ReconnectStatus.BLOCKED) {
          const stillBlocked = this.guard.blockedUntil(accountId) !== null;
          if (stillBlocked) {
            log.debug(`[${accountId}] Health check: guard-blocked — waiting.`);
            return;
          }
          log.info(
            `[${accountId}] Health check: guard window expired — BLOCKED → IDLE. [self-healing]`,
          );
          this.setStatus(accountId, ReconnectStatus.IDLE);
        }

        // ── FAILED state → trip circuit immediately ────────────────────────
        // Prevents health monitor from re-triggering a reconnect on an account
        // that has already exhausted all its retry attempts.
        if (record?.status === ReconnectStatus.FAILED) {
          const failures = (this.circuitFailures.get(accountId) ?? 0) + 1;
          this.circuitFailures.set(accountId, failures);
          this.setStatus(accountId, ReconnectStatus.CIRCUIT_OPEN);
          log.error(
            `[${accountId}] ⛔ Health monitor: FAILED → CIRCUIT_OPEN. ` +
            `Prevented retry loop. [circuit-open]`,
            { failureCycles: failures },
          );
          return;
        }

        log.warn(`[${accountId}] Health monitor: disconnected — scheduling reconnect.`);
        this.reconnect(accountId).catch((err: unknown) => {
          log.error(
            `[${accountId}] Health-monitor reconnect threw.`,
            err instanceof Error ? err : new Error(String(err)),
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
