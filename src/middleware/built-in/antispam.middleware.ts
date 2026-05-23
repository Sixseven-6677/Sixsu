import { IMiddleware } from "../types/IMiddleware";

export interface AntiSpamOptions {
  maxMessages: number;
  windowMs: number;
  message?: string;
}

interface UserWindow {
  count: number;
  windowStart: number;
}

export function createAntiSpamMiddleware(
  options: AntiSpamOptions
): IMiddleware {
  const store = new Map<string, UserWindow>();

  return {
    name: "antispam",
    handle: async (ctx, _command, next) => {
      const userId = ctx.user.id;
      const now = Date.now();
      const entry = store.get(userId);

      if (!entry || now - entry.windowStart > options.windowMs) {
        store.set(userId, { count: 1, windowStart: now });
        await next();
        return;
      }

      entry.count += 1;

      if (entry.count > options.maxMessages) {
        const msg =
          options.message ??
          `🚫 أرسلت رسائل كثيرة جداً. انتظر قليلاً.`;
        await ctx.reply(msg);
        return;
      }

      await next();
    },
  };
}
