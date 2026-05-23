import { Context } from "../context/Context";
import { ICommand } from "../commands/types/ICommand";
import { IMiddleware, MiddlewareFn, toMiddlewareFn } from "./types/IMiddleware";

export class MiddlewareChain {
  private readonly fns: MiddlewareFn[];

  constructor(fns: MiddlewareFn[] = []) {
    this.fns = [...fns];
  }

  use(middleware: MiddlewareFn | IMiddleware): this {
    this.fns.push(toMiddlewareFn(middleware));
    return this;
  }

  async execute(
    ctx: Context,
    command: ICommand | null,
    terminal?: MiddlewareFn
  ): Promise<void> {
    const chain = terminal ? [...this.fns, terminal] : [...this.fns];
    await this.dispatch(ctx, command, chain, 0);
  }

  private async dispatch(
    ctx: Context,
    command: ICommand | null,
    chain: MiddlewareFn[],
    index: number
  ): Promise<void> {
    if (index >= chain.length) return;
    const fn = chain[index]!;
    await fn(ctx, command, () =>
      this.dispatch(ctx, command, chain, index + 1)
    );
  }

  clone(): MiddlewareChain {
    return new MiddlewareChain(this.fns);
  }

  get size(): number {
    return this.fns.length;
  }
}
