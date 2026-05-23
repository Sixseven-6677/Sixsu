import { Context }     from "../../context/Context";
import { ICommand }    from "../../commands/types/ICommand";
import { IMiddleware } from "../types/IMiddleware";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("Middleware/Permissions");

export type PermissionCheck = (
  ctx:     Context,
  command: ICommand | null
) => boolean | Promise<boolean>;

export interface PermissionsOptions {
  /** IDs of users who are admins — can run adminOnly commands. */
  adminIds?: string[];
  /** Only these users can use the bot. If empty/undefined, all users allowed. */
  allowlist?: string[];
  /** These users can NEVER use the bot. Checked before allowlist. */
  blocklist?: string[];
  /** Custom async permission check. Runs after built-in checks. */
  check?: PermissionCheck;
  /** Reply sent when access is denied. */
  denyMessage?: string;
}

export function createPermissionsMiddleware(opts: PermissionsOptions): IMiddleware {
  const adminSet  = opts.adminIds  ? new Set(opts.adminIds)  : null;
  const allowSet  = opts.allowlist ? new Set(opts.allowlist) : null;
  const blockSet  = opts.blocklist ? new Set(opts.blocklist) : null;
  const denyMsg   = opts.denyMessage ?? "🚫 ليس لديك صلاحية لاستخدام هذا الأمر.";
  const adminMsg  = "🔒 هذا الأمر مخصص للمشرفين فقط.";

  return {
    name:        "permissions",
    description: "Checks allowlist, blocklist, adminOnly flag, and custom permission check",
    handle: async (ctx, command, next) => {
      const userId = ctx.user.id;

      // 1. Blocklist — always denied, no reply context needed
      if (blockSet?.has(userId)) {
        log.warn(`Permissions: user ${userId} is in blocklist — blocked.`);
        await ctx.reply(denyMsg);
        return;
      }

      // 2. Allowlist — only specific users may interact
      if (allowSet && !allowSet.has(userId)) {
        log.warn(`Permissions: user ${userId} not in allowlist — blocked.`);
        await ctx.reply(denyMsg);
        return;
      }

      // 3. Admin-only command check
      if (command?.adminOnly) {
        const isAdmin = adminSet?.has(userId) ?? false;
        if (!isAdmin) {
          log.warn(
            `Permissions: user ${userId} tried admin-only command "${command.name}" — denied.`
          );
          await ctx.reply(adminMsg);
          return;
        }
      }

      // 4. Custom check
      if (opts.check) {
        const allowed = await opts.check(ctx, command);
        if (!allowed) {
          log.warn(
            `Permissions: user ${userId} failed custom check ` +
            `for "${command?.name ?? "(no-command)"}".`
          );
          await ctx.reply(denyMsg);
          return;
        }
      }

      await next();
    },
  };
}
