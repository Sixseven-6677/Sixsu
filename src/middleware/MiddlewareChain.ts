import { Context }                           from "../context/Context";
import { ICommand }                          from "../commands/types/ICommand";
import { IMiddleware, MiddlewareFn, toMiddlewareFn } from "./types/IMiddleware";

export interface ExecutionResult {
  /** True if any middleware stopped the chain by not calling next(). */
  stopped:    boolean;
  /** How long the full chain took in milliseconds. */
  durationMs: number;
}

export class MiddlewareChain {
  private readonly fns: MiddlewareFn[];

  constructor(fns: MiddlewareFn[] = []) {
    this.fns = [...fns];
  }

  use(middleware: MiddlewareFn | IMiddleware): this {
    this.fns.push(toMiddlewareFn(middleware));
    return this;
  }

  /**
   * Execute the middleware chain.
   * Stops early if any middleware doesn't call next().
   */
  async execute(
    ctx:      Context,
    command:  ICommand | null,
    terminal?: MiddlewareFn
  ): Promise<void> {
    const chain = terminal ? [...this.fns, terminal] : [...this.fns];
    await this.dispatch(ctx, command, chain, 0);
  }

  /**
   * Execute the chain and return whether it was stopped.
   * A tracker sentinel is injected just before the terminal to detect
   * whether all middlewares called next().
   */
  async executeWithResult(
    ctx:      Context,
    command:  ICommand | null,
    terminal?: MiddlewareFn
  ): Promise<ExecutionResult> {
    const start = Date.now();
    let reachedTerminal = false;

    const tracker: MiddlewareFn = async (_ctx, _cmd, next) => {
      reachedTerminal = true;
      await next();
    };

    const chain = terminal
      ? [...this.fns, tracker, terminal]
      : [...this.fns, tracker];

    await this.dispatch(ctx, command, chain, 0);

    return {
      stopped:    !reachedTerminal,
      durationMs: Date.now() - start,
    };
  }

  private async dispatch(
    ctx:     Context,
    command: ICommand | null,
    chain:   MiddlewareFn[],
    index:   number
  ): Promise<void> {
    if (index >= chain.length) return;
    const fn = chain[index]!;
    await fn(ctx, command, () => this.dispatch(ctx, command, chain, index + 1));
  }

  clone(): MiddlewareChain {
    return new MiddlewareChain(this.fns);
  }

  get size(): number {
    return this.fns.length;
  }
}
