import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("AdminStore");

// ─── MongoDB repo interface (loose coupling) ──────────────────────────────────

interface IBotAdminRepository {
  findAll(): Promise<string[]>;
  add(fbId: string, addedBy: string): Promise<void>;
  remove(fbId: string): Promise<boolean>;
}

// ─── AdminStore ───────────────────────────────────────────────────────────────

export class AdminStore {
  private readonly admins:  Set<string>;
  private readonly seedIds: string[];
  private repo: IBotAdminRepository | null = null;

  constructor(seedIds: string[] = []) {
    this.seedIds = seedIds;
    this.admins  = new Set(seedIds);
    log.info(`AdminStore initialised — ${this.admins.size} admin(s) (seed).`);
  }

  // ── MongoDB wiring (called after DB connects) ───────────────────────────────

  setRepository(repo: IBotAdminRepository): void {
    this.repo = repo;
    log.debug("AdminStore: MongoDB repository attached.");
  }

  /**
   * Load admins from MongoDB and merge with current in-memory set.
   * Called once after the DB connection is established.
   */
  async loadFromDatabase(): Promise<void> {
    if (!this.repo) return;

    try {
      const dbIds = await this.repo.findAll();

      // Persist seed IDs to MongoDB so they survive on subsequent restarts
      for (const id of this.seedIds) {
        if (!dbIds.includes(id)) {
          try {
            await this.repo.add(id, "system:seed");
          } catch {
            // May already exist — tolerate duplicate upsert errors
          }
        }
      }

      // Merge DB admins into in-memory set
      for (const id of dbIds) {
        this.admins.add(id);
      }

      log.info(`AdminStore: loaded from MongoDB — ${this.admins.size} admin(s) total.`);
    } catch (err) {
      log.warn("AdminStore: failed to load from MongoDB — using seed data.", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Mutations ───────────────────────────────────────────────────────────────

  add(id: string, addedBy = "system"): void {
    this.admins.add(id);

    if (this.repo) {
      this.repo.add(id, addedBy).catch((err: unknown) => {
        log.warn("AdminStore: MongoDB add failed — admin is still active in memory.", {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      log.debug("AdminStore: no repo attached — admin added in memory only.", { id });
    }

    log.info(`Admin added: ${id}`);
  }

  remove(id: string): boolean {
    const existed = this.admins.delete(id);

    if (existed) {
      if (this.repo) {
        this.repo.remove(id).catch((err: unknown) => {
          log.warn("AdminStore: MongoDB remove failed — admin is removed in memory.", {
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } else {
        log.debug("AdminStore: no repo attached — admin removed in memory only.", { id });
      }
      log.info(`Admin removed: ${id}`);
    }

    return existed;
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  has(id: string): boolean {
    return this.admins.has(id);
  }

  getAll(): string[] {
    return Array.from(this.admins);
  }

  size(): number {
    return this.admins.size;
  }
}
