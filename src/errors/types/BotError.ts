export type ErrorSeverity = "low" | "medium" | "high" | "critical";

export interface BotErrorOptions {
  code:         string;
  severity?:    ErrorSeverity;
  recoverable?: boolean;
  context?:     Record<string, unknown>;
  cause?:       Error;
}

export class BotError extends Error {
  readonly code:        string;
  readonly severity:    ErrorSeverity;
  readonly recoverable: boolean;
  readonly context?:    Record<string, unknown>;
  readonly timestamp:   Date;
  readonly cause?: Error;

  constructor(message: string, options: BotErrorOptions) {
    super(message);

    this.name        = this.constructor.name;
    this.code        = options.code;
    this.severity    = options.severity    ?? "medium";
    this.recoverable = options.recoverable ?? true;
    this.context     = options.context;
    this.cause       = options.cause;
    this.timestamp   = new Date();

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name:        this.name,
      code:        this.code,
      message:     this.message,
      severity:    this.severity,
      recoverable: this.recoverable,
      context:     this.context,
      timestamp:   this.timestamp.toISOString(),
      stack:       this.stack,
      cause:       this.cause?.message,
    };
  }
}
