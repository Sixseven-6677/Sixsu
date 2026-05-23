import { IMiddleware, MiddlewareFn, toMiddlewareFn } from "./types/IMiddleware";
import { MiddlewareChain }  from "./MiddlewareChain";
import { LoggerManager }    from "../logger/LoggerManager";

const log = LoggerManager.getLogger("MiddlewareManager");

export class MiddlewareManager {
  /** Ordered list of registered names (insertion order). */
  private readonly order:    string[] = [];
  private readonly registry: Map<string, IMiddleware> = new Map();

  register(middleware: IMiddleware): this {
    if (this.registry.has(middleware.name)) {
      throw new Error(`Middleware already registered: "${middleware.name}"`);
    }

    this.registry.set(middleware.name, middleware);
    this.order.push(middleware.name);

    log.info(
      `Registered: "${middleware.name}"` +
      (middleware.description ? ` — ${middleware.description}` : "")
    );

    return this;
  }

  unregister(name: string): this {
    if (!this.registry.has(name)) return this;
    this.registry.delete(name);
    const idx = this.order.indexOf(name);
    if (idx !== -1) this.order.splice(idx, 1);
    log.info(`Unregistered: "${name}"`);
    return this;
  }

  get(name: string): IMiddleware {
    const mw = this.registry.get(name);
    if (!mw) throw new Error(`Middleware not found: "${name}"`);
    return mw;
  }

  fn(name: string): MiddlewareFn {
    return toMiddlewareFn(this.get(name));
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Build a MiddlewareChain from named middlewares.
   * If no names given, uses all registered in registration order.
   */
  createChain(...names: string[]): MiddlewareChain {
    const chain = new MiddlewareChain();
    const targets = names.length > 0 ? names : this.order;
    for (const name of targets) {
      chain.use(this.get(name));
    }
    return chain;
  }

  /** Returns all middlewares in registration order. */
  getAll(): IMiddleware[] {
    return this.order.map((n) => this.registry.get(n)!);
  }

  /** Returns registered names in insertion order. */
  list(): string[] {
    return [...this.order];
  }

  size(): number {
    return this.registry.size;
  }
}
