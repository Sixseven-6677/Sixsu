import { PipelineMiddleware } from "../types/ICommand";

export const loggingMiddleware: PipelineMiddleware = async (
  ctx,
  command,
  next
) => {
  const start = Date.now();
  console.log(
    `[Command] "${command.name}" | user: ${ctx.user.id} | args: [${ctx.args.join(", ")}]`
  );

  await next();

  const elapsed = Date.now() - start;
  console.log(`[Command] "${command.name}" completed in ${elapsed}ms`);
};
