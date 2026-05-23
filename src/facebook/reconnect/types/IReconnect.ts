export enum ReconnectStatus {
  IDLE      = "IDLE",
  RETRYING  = "RETRYING",
  CONNECTED = "CONNECTED",
  FAILED    = "FAILED",
  BLOCKED   = "BLOCKED",
}

export interface RetryAttempt {
  attempt:  number;
  at:       Date;
  delayMs:  number;
  error:    string | null;
  success:  boolean;
}

export interface ReconnectRecord {
  accountId:     string;
  status:        ReconnectStatus;
  attempts:      RetryAttempt[];
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  blockedUntil:  Date | null;
  totalRuns:     number;
}

export interface RetryPolicyOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs:  number;
  multiplier:  number;
  jitter:      boolean;
}

export interface ReconnectManagerOptions {
  retry?:                  Partial<RetryPolicyOptions>;
  healthCheckIntervalMs?:  number;
  spamWindowMs?:           number;
  maxAttemptsPerWindow?:   number;
}

export type HealthCheckFn    = (accountId: string) => Promise<boolean>;
export type OnDisconnectedFn = (accountId: string) => void;
