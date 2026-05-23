import { ILogger, LogEntry, LogLevel, LOG_LEVEL_PRIORITY } from "./types/ILogger";
import { ITransport } from "./types/ITransport";

function toError(value: unknown): Error | undefined {
  if (value instanceof Error) return value;
  if (value !== undefined && value !== null) {
    return new Error(String(value));
  }
  return undefined;
}

export class Logger implements ILogger {
  private readonly transports:  ITransport[];
  private readonly minPriority: number;
  private readonly ctx?:        string;

  constructor(
    transports: ITransport[],
    minLevel: LogLevel = LogLevel.INFO,
    context?: string
  ) {
    this.transports  = transports;
    this.minPriority = LOG_LEVEL_PRIORITY[minLevel];
    this.ctx         = context;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write(LogLevel.DEBUG, message, undefined, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write(LogLevel.INFO, message, undefined, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write(LogLevel.WARN, message, undefined, meta);
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown>): void {
    this.write(LogLevel.ERROR, message, toError(error), meta);
  }

  child(context: string): ILogger {
    return new Logger(this.transports, this.resolveLevel(), context);
  }

  close(): void {
    for (const transport of this.transports) {
      transport.close?.();
    }
  }

  private write(
    level: LogLevel,
    message: string,
    error?: Error,
    meta?: Record<string, unknown>
  ): void {
    if (LOG_LEVEL_PRIORITY[level] < this.minPriority) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context:   this.ctx,
      meta,
      error,
    };

    for (const transport of this.transports) {
      try {
        transport.write(entry);
      } catch {
        /* transport failures must never crash the app */
      }
    }
  }

  private resolveLevel(): LogLevel {
    for (const [level, priority] of Object.entries(LOG_LEVEL_PRIORITY) as [LogLevel, number][]) {
      if (priority === this.minPriority) return level;
    }
    return LogLevel.INFO;
  }
}
