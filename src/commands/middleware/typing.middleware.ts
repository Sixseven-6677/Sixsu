import { PipelineMiddleware } from "../types/ICommand";

export const typingMiddleware: PipelineMiddleware = async (
  ctx,
  _command,
  next
) => {
  await ctx.typingOn();
  await next();
};
