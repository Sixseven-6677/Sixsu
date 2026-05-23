import { IMiddleware, MiddlewareFn, toMiddlewareFn } from "./types/IMiddleware";
import { MiddlewareChain } from "./MiddlewareChain";

export class MiddlewareManager {
  private readonly registry = new Map<string, IMiddleware>();

  register(middleware: IMiddleware): this {
    if (this.registry.has(middleware.name)) {
      throw new Error(
        `Middleware already registered: "${middleware.name}"`
      );
    }
    this.registry.set(middleware.name, middleware);
    console.log(`[MiddlewareManager] Registered: ${middleware.name}`);
    return this;
  }

  unregister(name: string): void {
    this.registry.delete(name);
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

  createChain(...names: string[]): MiddlewareChain {
    const chain = new MiddlewareChain();
    for (const name of names) {
      chain.use(this.get(name));
    }
    return chain;
  }

  getAll(): IMiddleware[] {
    return Array.from(this.registry.values());
  }

  size(): number {
    return this.registry.size;
  }
}
