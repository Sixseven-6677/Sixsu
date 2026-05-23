import { IMiddleware }  from "../types/IMiddleware";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("Middleware/Banned");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BanEntry {
  userId:    string;
  reason?:   string;
  bannedAt:  Date;
  /** null = permanent ban */
  expiresAt: Date | null;
  bannedBy?: string;
}

export interface BanOptions {
  reason?:      string;
  /** Duration in ms. Omit for a permanent ban. */
  durationMs?:  number;
  bannedBy?:    string;
}

export interface BanStoreSummary {
  total:     number;
  active:    number;
  permanent: number;
  temporary: number;
  expired:   number;
}

// ─── BanStore ─────────────────────────────────────────────────────────────────

export class BanStore {
  private readonly bans = new Map<string, BanEntry>();

  /** Ban a user. Overwrites any existing ban. */
  ban(userId: string, opts: BanOptions = {}): BanEntry {
    const entry: BanEntry = {
      userId,
      reason:    opts.reason,
      bannedAt:  new Date(),
      expiresAt: opts.durationMs ? new Date(Date.now() + opts.durationMs) : null,
      bannedBy:  opts.bannedBy,
    };

    this.bans.set(userId, entry);

    const expiry = entry.expiresAt
      ? `expires: ${entry.expiresAt.toISOString()}`
      : "permanent";
    log.info(
      `Banned user ${userId} — reason: "${opts.reason ?? "none"}" | ${expiry}` +
      (opts.bannedBy ? ` | by: ${opts.bannedBy}` : "")
    );

    return entry;
  }

  /** Remove a ban. Returns true if the user was banned. */
  unban(userId: string): boolean {
    const had = this.bans.has(userId);
    if (had) {
      this.bans.delete(userId);
      log.info(`Unbanned user ${userId}.`);
    }
    return had;
  }

  /**
   * Check if a user is currently banned.
   * Automatically removes expired bans.
   */
  isBanned(userId: string): boolean {
    const entry = this.bans.get(userId);
    if (!entry) return false;

    if (entry.expiresAt && Date.now() >= entry.expiresAt.getTime()) {
      this.bans.delete(userId);
      log.info(`Temporary ban expired — user ${userId} is now free.`);
      return false;
    }

    return true;
  }

  /** Get the ban entry (null if not banned or ban expired). */
  getEntry(userId: string): BanEntry | null {
    if (!this.isBanned(userId)) return null;
    return this.bans.get(userId) ?? null;
  }

  /** All current bans (expired ones are automatically purged). */
  getAll(): BanEntry[] {
    const now = Date.now();
    const active: BanEntry[] = [];

    for (const [userId, entry] of this.bans) {
      if (entry.expiresAt && now >= entry.expiresAt.getTime()) {
        this.bans.delete(userId);
      } else {
        active.push(entry);
      }
    }

    return active;
  }

  /** Summary statistics. */
  summary(): BanStoreSummary {
    const all     = Array.from(this.bans.values());
    const now     = Date.now();
    const active  = all.filter(
      (e) => !e.expiresAt || now < e.expiresAt.getTime()
    );
    const expired  = all.length - active.length;
    const permanent = active.filter((e) => !e.expiresAt).length;
    const temporary = active.filter((e) => !!e.expiresAt).length;

    return {
      total:    all.length,
      active:   active.length,
      permanent,
      temporary,
      expired,
    };
  }

  /** Remove all expired bans from storage. */
  purgeExpired(): number {
    const now     = Date.now();
    let   removed = 0;
    for (const [userId, entry] of this.bans) {
      if (entry.expiresAt && now >= entry.expiresAt.getTime()) {
        this.bans.delete(userId);
        removed++;
      }
    }
    if (removed > 0) {
      log.info(`Purged ${removed} expired ban(s).`);
    }
    return removed;
  }

  /** Total number of entries (including expired). */
  get size(): number {
    return this.bans.size;
  }
}

// ─── Middleware factory ────────────────────────────────────────────────────────

export interface BannedMiddlewareOptions {
  store: BanStore;
  /** Custom reply when banned. Receives the BanEntry. */
  message?: (entry: BanEntry) => string;
  /** Don't reply — silently drop the message. Default: false. */
  silent?: boolean;
}

export function createBannedMiddleware(opts: BannedMiddlewareOptions): IMiddleware {
  return {
    name:        "banned",
    description: "Blocks banned users from executing any command",
    handle: async (ctx, _command, next) => {
      const entry = opts.store.getEntry(ctx.user.id);

      if (!entry) {
        await next();
        return;
      }

      // User is banned — build reason text
      const reason = entry.reason ? ` السبب: ${entry.reason}.` : "";
      const expiry = entry.expiresAt
        ? ` انتهاء الحظر: ${entry.expiresAt.toLocaleString()}.`
        : " الحظر دائم.";

      log.warn(
        `Banned user ${ctx.user.id} tried to use bot — blocked.` +
        (entry.reason ? ` Reason: ${entry.reason}` : "")
      );

      if (!opts.silent) {
        const msg =
          opts.message?.(entry) ??
          `🚫 أنت محظور من استخدام البوت.${reason}${expiry}`;
        await ctx.reply(msg);
      }

      // Do not call next() — chain stops here
    },
  };
}
