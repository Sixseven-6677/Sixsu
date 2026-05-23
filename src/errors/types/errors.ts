import { BotError, BotErrorOptions } from "./BotError";

type PartialOpts = Omit<BotErrorOptions, "code"> & { code?: string };

export class ConfigurationError extends BotError {
  constructor(message: string, opts: PartialOpts = {}) {
    super(message, {
      ...opts,
      code:        opts.code        ?? "ERR_CONFIGURATION",
      severity:    opts.severity    ?? "critical",
      recoverable: opts.recoverable ?? false,
    });
  }
}

export class DatabaseError extends BotError {
  constructor(message: string, opts: PartialOpts = {}) {
    super(message, {
      ...opts,
      code:        opts.code        ?? "ERR_DATABASE",
      severity:    opts.severity    ?? "high",
      recoverable: opts.recoverable ?? true,
    });
  }
}

export class FacebookApiError extends BotError {
  constructor(message: string, opts: PartialOpts = {}) {
    super(message, {
      ...opts,
      code:        opts.code        ?? "ERR_FACEBOOK_API",
      severity:    opts.severity    ?? "medium",
      recoverable: opts.recoverable ?? true,
    });
  }
}

export class CommandError extends BotError {
  constructor(message: string, opts: PartialOpts = {}) {
    super(message, {
      ...opts,
      code:        opts.code        ?? "ERR_COMMAND",
      severity:    opts.severity    ?? "low",
      recoverable: opts.recoverable ?? true,
    });
  }
}

export class ValidationError extends BotError {
  constructor(message: string, opts: PartialOpts = {}) {
    super(message, {
      ...opts,
      code:        opts.code        ?? "ERR_VALIDATION",
      severity:    opts.severity    ?? "low",
      recoverable: opts.recoverable ?? true,
    });
  }
}

export class PermissionError extends BotError {
  constructor(message: string, opts: PartialOpts = {}) {
    super(message, {
      ...opts,
      code:        opts.code        ?? "ERR_PERMISSION",
      severity:    opts.severity    ?? "low",
      recoverable: opts.recoverable ?? true,
    });
  }
}

export class NetworkError extends BotError {
  constructor(message: string, opts: PartialOpts = {}) {
    super(message, {
      ...opts,
      code:        opts.code        ?? "ERR_NETWORK",
      severity:    opts.severity    ?? "medium",
      recoverable: opts.recoverable ?? true,
    });
  }
}

export class ShutdownError extends BotError {
  constructor(message: string, opts: PartialOpts = {}) {
    super(message, {
      ...opts,
      code:        opts.code        ?? "ERR_SHUTDOWN",
      severity:    opts.severity    ?? "high",
      recoverable: opts.recoverable ?? false,
    });
  }
}
