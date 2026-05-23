import { randomUUID } from "crypto";
import { BotError, ErrorSeverity } from "./types/BotError";
import { ILogger } from "../logger/types/ILogger";
import { LoggerManager } from "../logger/LoggerManager";

export interface ErrorReport {
  id:          string;
  timestamp:   string;
  code:        string;
  name:        string;
  message:     string;
  severity:    ErrorSeverity;
  recoverable: boolean;
  context?:    Record<string, unknown>;
  stack?:      string;
  cause?:      string;
  process: {
    pid:    number;
    uptime: number;
    memory: NodeJS.MemoryUsage;
  };
}

export class ErrorReporter {
  private readonly log: ILogger;

  constructor(log?: ILogger) {
    this.log = log ?? LoggerManager.getLogger("ErrorReporter");
  }

  report(error: unknown, extra?: Record<string, unknown>): ErrorReport {
    const report = this.build(error, extra);
    this.emit(report);
    return report;
  }

  private build(error: unknown, extra?: Record<string, unknown>): ErrorReport {
    const id        = randomUUID().slice(0, 8).toUpperCase();
    const timestamp = new Date().toISOString();

    if (error instanceof BotError) {
      return {
        id,
        timestamp,
        code:        error.code,
        name:        error.name,
        message:     error.message,
        severity:    error.severity,
        recoverable: error.recoverable,
        context:     extra ? { ...error.context, ...extra } : error.context,
        stack:       error.stack,
        cause:       error.cause?.message,
        process:     this.processInfo(),
      };
    }

    const err = error instanceof Error ? error : new Error(String(error));
    return {
      id,
      timestamp,
      code:        "ERR_UNKNOWN",
      name:        err.name,
      message:     err.message,
      severity:    "high",
      recoverable: false,
      context:     extra,
      stack:       err.stack,
      process:     this.processInfo(),
    };
  }

  private emit(report: ErrorReport): void {
    const meta: Record<string, unknown> = {
      reportId:  report.id,
      code:      report.code,
      severity:  report.severity,
      recoverable: report.recoverable,
    };

    if (report.context) meta["context"] = report.context;

    switch (report.severity) {
      case "low":
      case "medium":
        this.log.warn(`[${report.id}] ${report.name}: ${report.message}`, meta);
        break;
      case "high":
      case "critical":
        this.log.error(
          `[${report.id}] ${report.name}: ${report.message}`,
          report.stack ? Object.assign(new Error(report.message), { stack: report.stack }) : undefined,
          meta
        );
        break;
    }
  }

  private processInfo(): ErrorReport["process"] {
    return {
      pid:    process.pid,
      uptime: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
    };
  }
}

export const errorReporter = new ErrorReporter();
