import { RetryPolicyOptions } from "./types/IReconnect";

const DEFAULTS: Required<RetryPolicyOptions> = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs:  60_000,
  multiplier:  2,
  jitter:      true,
};

export class RetryPolicy {
  private readonly opts: Required<RetryPolicyOptions>;

  constructor(options: Partial<RetryPolicyOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * Compute delay for a given attempt index (0-based).
   * Formula: base * multiplier^attempt, capped, ±25% jitter.
   */
  computeDelay(attempt: number): number {
    const raw    = this.opts.baseDelayMs * Math.pow(this.opts.multiplier, attempt);
    const capped = Math.min(raw, this.opts.maxDelayMs);
    if (!this.opts.jitter) return Math.round(capped);

    // ±25% jitter to prevent thundering-herd
    const factor = 0.75 + Math.random() * 0.5;
    return Math.round(capped * factor);
  }

  shouldRetry(attempt: number): boolean {
    return attempt < this.opts.maxAttempts;
  }

  get maxAttempts(): number {
    return this.opts.maxAttempts;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
