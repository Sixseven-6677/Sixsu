import { Context } from "../context/Context";
import { ICommand, PipelineMiddleware } from "./types/ICommand";
import { CommandRegistry } from "./CommandRegistry";

export type NotFoundHandler = (ctx: Context) => Promise<void>;

export class CommandPipeline {
  private readonly registry: CommandRegistry;
  private readonly middlewares: PipelineMiddleware[] = [];
  private readonly prefix: string;
  private notFoundHandler?: NotFoundHandler;

  constructor(registry: CommandRegistry, prefix = "") {
    this.registry = registry;
    this.prefix = prefix;
  }

  use(middleware: PipelineMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  onNotFound(handler: NotFoundHandler): this {
    this.notFoundHandler = handler;
    return this;
  }

  async run(ctx: Context): Promise<void> {
    let rawName = ctx.commandName;

    if (this.prefix) {
      if (!rawName.startsWith(this.prefix)) return;
      rawName = rawName.slice(this.prefix.length);
    }

    if (!rawName) return;

    const command = this.registry.resolve(rawName);

    if (!command) {
      if (this.notFoundHandler) {
        await this.notFoundHandler(ctx);
      }
      return;
    }

    await this.executeChain(ctx, command, 0);
  }

  private async executeChain(
    ctx: Context,
    command: ICommand,
    index: number
  ): Promise<void> {
    if (index >= this.middlewares.length) {
      await command.execute(ctx);
      return;
    }

    const middleware = this.middlewares[index]!;
    await middleware(ctx, command, () =>
      this.executeChain(ctx, command, index + 1)
    );
  }
}
