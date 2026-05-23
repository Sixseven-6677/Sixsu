import { v4 as uuidv4 } from "uuid";
import { ITask, TaskMeta, DelayedTaskOptions } from "./types/ITask";
import { safeRun } from "./TaskRunner";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("DelayedTask");

export class DelayedTask implements ITask {
  readonly id: string;
  readonly name: string;
  readonly meta: TaskMeta;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly options: DelayedTaskOptions;

  constructor(options: DelayedTaskOptions) {
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
      nextRunAt: new Date(Date.now() + options.delayMs),
      runCount: 0,
      errorCount: 0,
      lastError: null,
    };
  }

  start(): void {
    if (this.timer !== null) return;

    log.info(`Scheduling delayed task "${this.name}" in ${this.options.delayMs}ms.`);

    this.timer = setTimeout(async () => {
      this.meta.nextRunAt = null;
      await safeRun(this.meta, this.options.fn, this.options.onError);

      if (this.meta.status !== "cancelled") {
        this.meta.status = "completed";
      }

      this.timer = null;
      log.info(`Delayed task "${this.name}" [${this.id}] completed.`);
    }, this.options.delayMs);
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.meta.status = "cancelled";
    this.meta.nextRunAt = null;
    log.info(`Delayed task "${this.name}" [${this.id}] cancelled.`);
  }

  isActive(): boolean {
    return this.timer !== null;
  }
}
