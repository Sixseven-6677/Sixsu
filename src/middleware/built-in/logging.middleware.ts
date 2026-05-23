import { IMiddleware } from "../types/IMiddleware";

export interface LogInfo {
  commandName: string;
  userId: string;
  args: string[];
  durationMs: number;
}

export interface LoggingOptions {
  onSuccess?: (info: LogInfo) => void;
  onError?: (info: LogInfo, error: unknown) => void;
}

export function createLoggingMiddleware(
  options: LoggingOptions = {}
): IMiddleware {
  return {
    name: "logging",
    handle: async (ctx, command, next) => {
      const start = Date.now();
      const cmdName = command?.name ?? "(no-command)";

      try {
        await next();

        const info: LogInfo = {
          commandName: cmdName,
          userId: ctx.user.id,
          args: ctx.args,
          durationMs: Date.now() - start,
        };

        options.onSuccess
          ? options.onSuccess(info)
          : console.log(
              `[Log] "${info.commandName}" | user:${info.userId} | args:[${info.args.join(", ")}] | ${info.durationMs}ms`
            );
      } catch (err) {
        const info: LogInfo = {
          commandName: cmdName,
          userId: ctx.user.id,
          args: ctx.args,
          durationMs: Date.now() - start,
        };

        options.onError
          ? options.onError(info, err)
          : console.error(
              `[Log] ERROR "${info.commandName}" | user:${info.userId} | ${info.durationMs}ms`,
              err
            );

        throw err;
      }
    },
  };
}
