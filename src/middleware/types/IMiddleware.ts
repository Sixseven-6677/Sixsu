import { Context }  from "../../context/Context";
import { ICommand } from "../../commands/types/ICommand";

export type NextFn = () => Promise<void>;

export type MiddlewareFn = (
  ctx:     Context,
  command: ICommand | null,
  next:    NextFn
) => Promise<void>;

export interface IMiddleware {
  readonly name:         string;
  readonly description?: string;
  readonly handle:       MiddlewareFn;
}

export function toMiddlewareFn(
  middleware: IMiddleware | MiddlewareFn
): MiddlewareFn {
  if (typeof middleware === "function") return middleware;
  return (ctx, command, next) => middleware.handle(ctx, command, next);
}
