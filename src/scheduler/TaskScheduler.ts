import { ISystem } from "../core/interfaces/ISystem";
import { ITask, DelayedTaskOptions, RecurringTaskOptions, TaskMeta } from "./types/ITask";
import { DelayedTask } from "./DelayedTask";
import { RecurringTask } from "./RecurringTask";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("TaskScheduler");

export class TaskScheduler implements ISystem {
  readonly name = "scheduler";

  private readonly tasks = new Map<string, ITask>();

  async initialize(): Promise<void> {
    log.info("TaskScheduler initialized.");
  }

  async destroy(): Promise<void> {
    let cancelled = 0;
    for (const task of this.tasks.values()) {
      if (task.isActive()) {
        task.cancel();
        cancelled++;
      }
    }
    this.tasks.clear();
    log.info(`TaskScheduler destroyed. Cancelled ${cancelled} active task(s).`);
  }

  delay(options: DelayedTaskOptions): DelayedTask {
    const task = new DelayedTask(options, () => this.evict(task.id));
    this.register(task);
    task.start();
    return task;
  }

  recur(options: RecurringTaskOptions): RecurringTask {
    const task = new RecurringTask(options, () => this.evict(task.id));
    this.register(task);
    task.start();
    return task;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      log.warn(`Cancel called for unknown task id: ${id}`);
      return false;
    }
    task.cancel();
    this.tasks.delete(id);
    return true;
  }

  get(id: string): ITask | undefined {
    return this.tasks.get(id);
  }

  list(): TaskMeta[] {
    return Array.from(this.tasks.values()).map((t) => ({ ...t.meta }));
  }

  active(): TaskMeta[] {
    return this.list().filter((m) => m.status !== "cancelled" && m.status !== "completed");
  }

  stats(): { total: number; active: number; failed: number } {
    const all = this.list();
    return {
      total:  all.length,
      active: all.filter((m) => m.status === "idle" || m.status === "running").length,
      failed: all.filter((m) => m.status === "failed").length,
    };
  }

  /**
   * Called by tasks when they complete naturally (maxRuns reached / delayed task done).
   * Removes the task from the registry so completed tasks don't accumulate.
   */
  private evict(id: string): void {
    if (this.tasks.delete(id)) {
      log.info(`Task [${id}] completed and evicted from registry.`);
    }
  }

  private register(task: ITask): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task with id "${task.id}" is already registered.`);
    }
    this.tasks.set(task.id, task);
    log.info(`Task registered: "${task.name}" [${task.id}]`);
  }
}
