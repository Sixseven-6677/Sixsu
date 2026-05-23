import { TaskFn, TaskMeta } from "./types/ITask";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("TaskRunner");

export async function safeRun(
  meta: TaskMeta,
  fn: TaskFn,
  onError?: (err: unknown) => void
): Promise<void> {
  meta.status = "running";
  meta.lastRunAt = new Date();
  meta.runCount += 1;

  try {
    await fn();
    meta.status = "idle";
  } catch (err) {
    meta.errorCount += 1;
    meta.lastError = err instanceof Error ? err.message : String(err);
    meta.status = "failed";

    log.error(`Task "${meta.name}" [${meta.id}] failed.`, err);

    try {
      onError?.(err);
    } catch (handlerErr) {
      log.error(`Task "${meta.name}" onError handler itself threw.`, handlerErr);
    }
  }
}
