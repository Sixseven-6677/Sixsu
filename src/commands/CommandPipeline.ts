import { Context }         from "../context/Context";
import { CommandRegistry } from "./CommandRegistry";
import { MiddlewareChain } from "../middleware/MiddlewareChain";
import { IMiddleware, MiddlewareFn } from "../middleware/types/IMiddleware";
import { LoggerManager }  from "../logger/LoggerManager";

const log = LoggerManager.getLogger("CommandPipeline");

export type NotFoundHandler = (ctx: Context) => Promise<void>;

export class CommandPipeline {
  private readonly registry:         CommandRegistry;
  private readonly chain:            MiddlewareChain;
  private readonly prefix:           string;
  private notFoundHandler?:          NotFoundHandler;

  constructor(registry: CommandRegistry, prefix = "") {
    this.registry = registry;
    this.chain    = new MiddlewareChain();
    this.prefix   = prefix;
  }

  use(middleware: MiddlewareFn | IMiddleware): this {
    this.chain.use(middleware);
    return this;
  }

  onNotFound(handler: NotFoundHandler): this {
    this.notFoundHandler = handler;
    return this;
  }

  async run(ctx: Context): Promise<void> {
    let rawName = ctx.commandName;

    // Strip prefix
    if (this.prefix) {
      if (!rawName.startsWith(this.prefix)) return;
      rawName = rawName.slice(this.prefix.length);
    }

    if (!rawName) return;

    const command = this.registry.resolve(rawName);

    if (!command) {
      await this.notFoundHandler?.(ctx);
      return;
    }

    // Validate minimum required args
    if (
      command.minArgs !== undefined &&
      ctx.args.length < command.minArgs
    ) {
      const usage = command.usage ?? `${this.prefix}${command.name}`;
      await ctx.reply(
        `❌ هذا الأمر يتطلب ${command.minArgs} مُدخل/مُدخلات على الأقل.\n` +
        `📌 الاستخدام: ${usage}`
      );
      return;
    }

    // Validate maximum allowed args
    if (
      command.maxArgs !== undefined &&
      ctx.args.length > command.maxArgs
    ) {
      const usage = command.usage ?? `${this.prefix}${command.name}`;
      await ctx.reply(
        `❌ هذا الأمر يقبل ${command.maxArgs} مُدخل/مُدخلات كحدٍّ أقصى.\n` +
        `📌 الاستخدام: ${usage}`
      );
      return;
    }

    // Run middleware chain → execute with error boundary
    await this.chain.execute(ctx, command, async (_ctx, cmd) => {
      try {
        await cmd!.execute(_ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Command "${cmd!.name}" threw an error: ${message}`, err instanceof Error ? err : undefined);
        await _ctx
          .reply("⚠️ حدث خطأ أثناء تنفيذ الأمر. يُرجى المحاولة مجدداً.")
          .catch(() => {});
      }
    });
  }
}
