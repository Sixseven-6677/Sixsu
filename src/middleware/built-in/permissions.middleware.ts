import { Context } from "../../context/Context";
import { ICommand } from "../../commands/types/ICommand";
import { IMiddleware } from "../types/IMiddleware";

export type PermissionCheck = (
  ctx: Context,
  command: ICommand | null
) => boolean | Promise<boolean>;

export interface PermissionsOptions {
  allowlist?: string[];
  blocklist?: string[];
  check?: PermissionCheck;
  denyMessage?: string;
}

export function createPermissionsMiddleware(
  options: PermissionsOptions
): IMiddleware {
  const allowSet = options.allowlist ? new Set(options.allowlist) : null;
  const blockSet = options.blocklist ? new Set(options.blocklist) : null;
  const denyMsg =
    options.denyMessage ?? "🚫 ليس لديك صلاحية لاستخدام هذا الأمر.";

  return {
    name: "permissions",
    handle: async (ctx, command, next) => {
      const userId = ctx.user.id;

      if (blockSet?.has(userId)) {
        await ctx.reply(denyMsg);
        return;
      }

      if (allowSet && !allowSet.has(userId)) {
        await ctx.reply(denyMsg);
        return;
      }

      if (options.check) {
        const allowed = await options.check(ctx, command);
        if (!allowed) {
          await ctx.reply(denyMsg);
          return;
        }
      }

      await next();
    },
  };
}
