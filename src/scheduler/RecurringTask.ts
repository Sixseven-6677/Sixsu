import { v4 as uuidv4 } from "uuid";
import { ITask, TaskMeta, RecurringTaskOptions } from "./types/ITask";
import { safeRun } from "./TaskRunner";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("RecurringTask");

export class RecurringTask implements ITask {
  readonly id: string;
  readonly name: string;
  readonly meta: TaskMeta;

  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly options: RecurringTaskOptions;

  constructor(options: RecurringTaskOptions) {
    this.id = options.id ?? uuidv4();
    this.name = options.name;
    this.options = options;

    const now = new Date();
    this.meta = {
      id: this.id,
      name: this.name,
      status: "idle",
      createdAt: now,
      lastRunAt: null,
      nextRunAt: options.runImmediately
        ? now
        : new Date(Date.now() + options.intervalMs),
      runCount: 0,
      errorCount: 0,
      lastError: null,
    };
  }

  start(): void {
    if (this.timer !== null) return;

    log.info(
      `Starting recurring task "${this.name}" every ${this.options.intervalMs}ms.` +
        (this.options.maxRuns !== undefined
          ? ` Max runs: ${this.options.maxRuns}.`
          : "")
    );

    if (this.options.runImmediately) {
      void this.tick();
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
  }

  cancel(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.meta.status = "cancelled";
    this.meta.nextRunAt = null;
    log.info(`Recurring task "${this.name}" [${this.id}] cancelled.`);
  }

  isActive(): boolean {
    return this.timer !== null;
  }

  private async tick(): Promise<void> {
    if (this.meta.status === "cancelled") return;

    await safeRun(this.meta, this.options.fn, this.options.onError);

    const { maxRuns } = this.options;
    if (maxRuns !== undefined && this.meta.runCount >= maxRuns) {
      log.info(
        `Recurring task "${this.name}" reached maxRuns (${maxRuns}). Stopping.`
      );
      this.cancel();
      this.meta.status = "completed";
      return;
    }

    if (this.timer !== null) {
      this.meta.nextRunAt = new Date(Date.now() + this.options.intervalMs);
      this.meta.status = "idle";
    }
  }
}
