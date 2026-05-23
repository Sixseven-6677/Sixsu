import { IMiddleware } from "../types/IMiddleware";

export interface CooldownOptions {
  durationMs: number;
  message?: (remainingSeconds: number) => string;
}

export function createCooldownMiddleware(
  options: CooldownOptions
): IMiddleware {
  const store = new Map<string, number>();

  const CLEANUP_THRESHOLD = 2_000;

  return {
    name: "cooldown",
    handle: async (ctx, command, next) => {
      if (!command) {
        await next();
        return;
      }

      const key = `${ctx.user.id}:${command.name}`;
      const now = Date.now();
      const lastUsed = store.get(key) ?? 0;
      const remaining = options.durationMs - (now - lastUsed);

      if (remaining > 0) {
        const seconds = Math.ceil(remaining / 1000);
        const msg =
          options.message?.(seconds) ??
          `⏳ انتظر ${seconds} ثانية قبل استخدام هذا الأمر مرة أخرى.`;
        await ctx.reply(msg);
        return;
      }

      store.set(key, now);

      if (store.size > CLEANUP_THRESHOLD) {
        const cutoff = now - options.durationMs;
        for (const [k, ts] of store) {
          if (ts < cutoff) store.delete(k);
        }
      }

      await next();
    },
  };
}
