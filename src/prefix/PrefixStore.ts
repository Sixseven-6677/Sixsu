import { config }        from "../config/env";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("PrefixStore");

interface IBotConfigRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class PrefixStore {
  private _prefix: string;
  private repo: IBotConfigRepository | null = null;

  constructor() {
    this._prefix = config.bot.prefix ?? "/";
  }

  get(): string {
    return this._prefix;
  }

  set(newPrefix: string): void {
    this._prefix = newPrefix;

    if (this.repo) {
      this.repo.set("prefix", newPrefix).catch((err: unknown) => {
        log.warn("PrefixStore: MongoDB set failed — value updated in memory only.", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      log.debug("PrefixStore: no repo attached — prefix updated in memory only.", { prefix: newPrefix });
    }
  }

  /**
   * Wire MongoDB repository after DB connects.
   * Loads the stored prefix from DB — overrides env value if present.
   * Seeds DB with current value when no DB entry exists yet.
   */
  async loadFromDatabase(repo: IBotConfigRepository): Promise<void> {
    this.repo = repo;

    try {
      const stored = await repo.get("prefix");

      if (stored && stored.length > 0) {
        this._prefix = stored;
        log.info(`PrefixStore: prefix loaded from MongoDB: "${stored}"`);
      } else {
        await repo.set("prefix", this._prefix);
        log.info(`PrefixStore: prefix seeded to MongoDB: "${this._prefix}"`);
      }
    } catch (err) {
      log.warn("PrefixStore: MongoDB load failed — using env value.", {
        prefix: this._prefix,
        error:  err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const prefixStore = new PrefixStore();
