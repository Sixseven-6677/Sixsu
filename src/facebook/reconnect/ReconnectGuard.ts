import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("ReconnectGuard");

interface GuardWindow {
  count:       number;
  windowStart: number;
  blockedUntil: number | null;
}

export interface ReconnectGuardOptions {
  /** Time window to count attempts in (ms). Default: 60 000 */
  windowMs:            number;
  /** Max attempts allowed per window before blocking. Default: 3 */
  maxAttemptsPerWindow: number;
  /** How long to block the account after spam is detected (ms). Default: 5 min */
  blockDurationMs:     number;
}

const GUARD_DEFAULTS: Required<ReconnectGuardOptions> = {
  windowMs:             60_000,
  maxAttemptsPerWindow: 3,
  blockDurationMs:      5 * 60_000,
};

export class ReconnectGuard {
  private readonly windows = new Map<string, GuardWindow>();
  private readonly opts:    Required<ReconnectGuardOptions>;

  constructor(options: Partial<ReconnectGuardOptions> = {}) {
    this.opts = { ...GUARD_DEFAULTS, ...options };
  }

  /**
   * Returns true if the account is allowed to attempt reconnect right now.
   */
  isAllowed(accountId: string): boolean {
    const now    = Date.now();
    const window = this.ensure(accountId);

    // Still blocked?
    if (window.blockedUntil !== null && now < window.blockedUntil) {
      const remainSec = Math.ceil((window.blockedUntil - now) / 1000);
      log.warn(
        `ReconnectGuard: "${accountId}" is blocked for ${remainSec}s more.`
      );
      return false;
    }

    // Reset window if expired
    if (now - window.windowStart > this.opts.windowMs) {
      window.count       = 0;
      window.windowStart = now;
      window.blockedUntil = null;
    }

    // Count check
    if (window.count >= this.opts.maxAttemptsPerWindow) {
      window.blockedUntil = now + this.opts.blockDurationMs;
      log.warn(
        `ReconnectGuard: "${accountId}" exceeded ${this.opts.maxAttemptsPerWindow} ` +
        `attempts/window. Blocked for ${this.opts.blockDurationMs / 1000}s.`
      );
      return false;
    }

    return true;
  }

  /** Call this right before each attempt to record it. */
  record(accountId: string): void {
    const window = this.ensure(accountId);
    const now    = Date.now();

    if (now - window.windowStart > this.opts.windowMs) {
      window.count       = 0;
      window.windowStart = now;
      window.blockedUntil = null;
    }

    window.count += 1;
  }

  /** Reset guard state for an account (e.g. after successful reconnect). */
  reset(accountId: string): void {
    this.windows.delete(accountId);
  }

  /** Returns null if not blocked, or the Date it unblocks. */
  blockedUntil(accountId: string): Date | null {
    const w = this.windows.get(accountId);
    if (!w?.blockedUntil) return null;
    if (Date.now() >= w.blockedUntil) return null;
    return new Date(w.blockedUntil);
  }

  private ensure(accountId: string): GuardWindow {
    if (!this.windows.has(accountId)) {
      this.windows.set(accountId, {
        count:        0,
        windowStart:  Date.now(),
        blockedUntil: null,
      });
    }
    return this.windows.get(accountId)!;
  }
}
