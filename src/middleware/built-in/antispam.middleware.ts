import { IMiddleware }  from "../types/IMiddleware";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("Middleware/AntiSpam");

export interface AntiSpamOptions {
  /** Max messages allowed within the window. */
  maxMessages: number;
  /** Sliding window duration in ms. */
  windowMs: number;
  /** Reply message when blocked. */
  message?: string;
  /** Silence the reply (just stop the chain). Default: false. */
  silent?: boolean;
}

interface UserRecord {
  /** Timestamps of recent messages within the sliding window. */
  timestamps: number[];
}

export function createAntiSpamMiddleware(opts: AntiSpamOptions): IMiddleware {
  const store       = new Map<string, UserRecord>();
  const CLEANUP_AT  = 500; // clean store when size exceeds this

  return {
    name:        "antispam",
    description: `Max ${opts.maxMessages} msgs per ${opts.windowMs}ms`,
    handle: async (ctx, _command, next) => {
      const userId = ctx.user.id;
      const now    = Date.now();

      // Retrieve or create the sliding-window record
      let record = store.get(userId);
      if (!record) {
        record = { timestamps: [] };
        store.set(userId, record);
      }

      // Prune timestamps outside the window
      record.timestamps = record.timestamps.filter(
        (t) => now - t < opts.windowMs
      );

      if (record.timestamps.length >= opts.maxMessages) {
        const oldest     = record.timestamps[0] ?? now;
        const resetInMs  = opts.windowMs - (now - oldest);
        const resetInSec = Math.ceil(resetInMs / 1000);

        log.warn(
          `AntiSpam blocked user ${userId} — ` +
          `${record.timestamps.length}/${opts.maxMessages} msgs in ${opts.windowMs}ms. ` +
          `Reset in ${resetInSec}s.`
        );

        if (!opts.silent) {
          const msg =
            opts.message ??
            `🚫 أرسلت رسائل كثيرة جداً. انتظر ${resetInSec} ثانية.`;
          await ctx.reply(msg);
        }

        return; // stop chain
      }

      // Record this message
      record.timestamps.push(now);

      // Periodic cleanup to prevent memory bloat
      if (store.size > CLEANUP_AT) {
        for (const [uid, rec] of store) {
          const active = rec.timestamps.filter((t) => now - t < opts.windowMs);
          if (active.length === 0) {
            store.delete(uid);
          } else {
            rec.timestamps = active;
          }
        }
        log.debug(`AntiSpam store cleaned. Remaining entries: ${store.size}`);
      }

      await next();
    },
  };
}
