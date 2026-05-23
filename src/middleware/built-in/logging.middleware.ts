import { IMiddleware }  from "../types/IMiddleware";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("Middleware/Log");

export interface LoggingOptions {
  /** Log the command name and user on entry (before execution). Default: false. */
  logEntry?: boolean;
}

export function createLoggingMiddleware(opts: LoggingOptions = {}): IMiddleware {
  return {
    name:        "logging",
    description: "Logs command execution time and result",
    handle: async (ctx, command, next) => {
      const cmdName = command?.name ?? "(no-command)";
      const userId  = ctx.user.id;
      const start   = Date.now();

      if (opts.logEntry) {
        log.debug(`→ [${cmdName}] user:${userId} args:[${ctx.args.join(", ")}]`);
      }

      let stopped = false;
      try {
        let nextCalled = false;
        await next();
        nextCalled = true;
        stopped = !nextCalled;
      } catch (err) {
        const ms  = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`✗ [${cmdName}] user:${userId} | ${ms}ms | error: ${msg}`);
        throw err;
      }

      const ms = Date.now() - start;
      if (stopped) {
        log.debug(`⊘ [${cmdName}] user:${userId} | ${ms}ms | stopped by middleware`);
      } else {
        log.info(`✓ [${cmdName}] user:${userId} args:[${ctx.args.join(", ")}] | ${ms}ms`);
      }
    },
  };
}
