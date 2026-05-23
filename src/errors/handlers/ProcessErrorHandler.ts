import { ISystem } from "../../core/interfaces/ISystem";
import { ErrorReporter } from "../ErrorReporter";
import { LoggerManager } from "../../logger/LoggerManager";
import { BotError } from "../types/BotError";

const CRASH_THRESHOLD   = 5;
const CRASH_WINDOW_MS   = 60_000;

export class ProcessErrorHandler implements ISystem {
  readonly name = "error-handler";

  private readonly reporter: ErrorReporter;
  private readonly log      = LoggerManager.getLogger("ProcessErrorHandler");

  private errorTimestamps: number[] = [];
  private onCritical?: () => Promise<void>;

  constructor(reporter?: ErrorReporter) {
    this.reporter = reporter ?? new ErrorReporter(this.log);
  }

  onCriticalError(handler: () => Promise<void>): this {
    this.onCritical = handler;
    return this;
  }

  async initialize(): Promise<void> {
    process.on("uncaughtException",  this.handleUncaughtException.bind(this));
    process.on("unhandledRejection", this.handleUnhandledRejection.bind(this));
    this.log.info("Process error handlers registered.");
  }

  async destroy(): Promise<void> {
    process.removeListener("uncaughtException",  this.handleUncaughtException.bind(this));
    process.removeListener("unhandledRejection", this.handleUnhandledRejection.bind(this));
    this.log.info("Process error handlers removed.");
  }

  private handleUncaughtException(error: Error): void {
    const report = this.reporter.report(error, { source: "uncaughtException" });

    const isBotError    = error instanceof BotError;
    const isRecoverable = isBotError && (error as BotError).recoverable;

    if (!isRecoverable) {
      this.log.error("Unrecoverable uncaught exception — shutting down.", error);
      this.triggerCritical();
      return;
    }

    this.recordError();

    if (this.isCrashLooping()) {
      this.log.error(
        `Crash loop detected: ${CRASH_THRESHOLD} errors in ${CRASH_WINDOW_MS / 1000}s — shutting down.`,
        undefined,
        { reportId: report.id }
      );
      this.triggerCritical();
    }
  }

  private handleUnhandledRejection(reason: unknown): void {
    this.reporter.report(reason, { source: "unhandledRejection" });
    this.recordError();

    if (this.isCrashLooping()) {
      this.log.error("Crash loop detected via unhandledRejection — shutting down.");
      this.triggerCritical();
    }
  }

  private recordError(): void {
    const now = Date.now();
    this.errorTimestamps.push(now);
    this.errorTimestamps = this.errorTimestamps.filter(
      (t) => now - t < CRASH_WINDOW_MS
    );
  }

  private isCrashLooping(): boolean {
    return this.errorTimestamps.length >= CRASH_THRESHOLD;
  }

  private triggerCritical(): void {
    if (this.onCritical) {
      this.onCritical()
        .catch(() => {})
        .finally(() => process.exit(1));
    } else {
      process.exit(1);
    }
  }
}
