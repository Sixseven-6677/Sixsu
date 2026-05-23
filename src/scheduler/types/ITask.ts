export type TaskStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskMeta {
  id: string;
  name: string;
  status: TaskStatus;
  createdAt: Date;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  runCount: number;
  errorCount: number;
  lastError: string | null;
}

export interface ITask {
  readonly id: string;
  readonly name: string;
  readonly meta: TaskMeta;

  start(): void;
  cancel(): void;
  isActive(): boolean;
}

export type TaskFn = () => Promise<void> | void;

export interface DelayedTaskOptions {
  id?: string;
  name: string;
  delayMs: number;
  fn: TaskFn;
  onError?: (err: unknown) => void;
}

export interface RecurringTaskOptions {
  id?: string;
  name: string;
  intervalMs: number;
  fn: TaskFn;
  runImmediately?: boolean;
  maxRuns?: number;
  onError?: (err: unknown) => void;
}
