import { IMiddleware }   from "../types/IMiddleware";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("Middleware/Lockdown");

// ─── MongoDB repo interface (loose coupling) ──────────────────────────────────

interface IGroupSettingsRepository {
  setLockdown(threadId: string, enabled: boolean): Promise<void>;
  getLockedThreadIds(): Promise<string[]>;
}

// ─── LockdownStore ────────────────────────────────────────────────────────────

export class LockdownStore {
  private readonly threads = new Map<string, boolean>();
  private repo: IGroupSettingsRepository | null = null;

  constructor() {
    log.info("LockdownStore initialized — no locked threads yet.");
  }

  // ── MongoDB wiring ──────────────────────────────────────────────────────────

  setRepository(repo: IGroupSettingsRepository): void {
    this.repo = repo;
    log.debug("LockdownStore: MongoDB repository attached.");
  }

  async loadFromDatabase(): Promise<void> {
    if (!this.repo) return;
    try {
      const lockedIds = await this.repo.getLockedThreadIds();
      for (const id of lockedIds) {
        this.threads.set(id, true);
      }
      log.info(`LockdownStore: loaded from MongoDB — ${lockedIds.length} locked thread(s).`);
    } catch (err) {
      log.warn("LockdownStore: failed to load from MongoDB — starting empty.", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  enable(threadId: string): void {
    this.threads.set(threadId, true);

    if (this.repo) {
      this.repo.setLockdown(threadId, true).catch((err: unknown) => {
        log.warn("LockdownStore: MongoDB enable failed — state active in memory.", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      log.debug("LockdownStore: no repo attached — lockdown active in memory only.", { threadId });
    }

    log.info("Lockdown enabled.", { threadId });
  }

  disable(threadId: string): void {
    this.threads.set(threadId, false);

    if (this.repo) {
      this.repo.setLockdown(threadId, false).catch((err: unknown) => {
        log.warn("LockdownStore: MongoDB disable failed — state updated in memory.", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      log.debug("LockdownStore: no repo attached — lockdown disabled in memory only.", { threadId });
    }

    log.info("Lockdown disabled.", { threadId });
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  isLocked(threadId: string): boolean {
    return this.threads.get(threadId) === true;
  }

  getLockedThreads(): string[] {
    const result: string[] = [];
    for (const [id, locked] of this.threads) {
      if (locked) result.push(id);
    }
    return result;
  }

  get lockedCount(): number {
    return this.getLockedThreads().length;
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export interface LockdownMiddlewareOptions {
  store: LockdownStore;
}

export function createLockdownMiddleware(opts: LockdownMiddlewareOptions): IMiddleware {
  return {
    name:        "lockdown",
    description: "Silently blocks non-admin commands when lockdown is active for a thread",
    handle: async (ctx, _command, next) => {
      if (!opts.store.isLocked(ctx.thread.id)) {
        await next();
        return;
      }

      // Admins bypass lockdown (ctx.hasRole("admin") now reflects AdminStore too)
      if (ctx.hasRole("admin")) {
        await next();
        return;
      }

      log.debug("Lockdown: blocked non-admin command.", {
        threadId: ctx.thread.id,
        userId:   ctx.user.id,
        cmd:      (ctx.message.text ?? "").slice(0, 60),
      });
    },
  };
}
