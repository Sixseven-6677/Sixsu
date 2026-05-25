import { ICacheProvider, CacheSetOptions } from "./types/ICache";

export class CacheStore {
  private provider: ICacheProvider;
  private readonly ns: string;

  constructor(provider: ICacheProvider, namespace: string) {
    this.provider = provider;
    this.ns       = namespace + ":";
  }

  get namespace(): string {
    return this.ns.slice(0, -1);
  }

  /**
   * Swap the underlying provider.
   * Called by CacheManager.useProvider() to propagate a provider change to
   * all existing CacheStore instances without breaking external references.
   */
  setProvider(provider: ICacheProvider): void {
    this.provider = provider;
  }

  async get<T>(key: string): Promise<T | null> {
    return this.provider.get<T>(this.ns + key);
  }

  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    return this.provider.set<T>(this.ns + key, value, options);
  }

  async delete(key: string): Promise<boolean> {
    return this.provider.delete(this.ns + key);
  }

  async exists(key: string): Promise<boolean> {
    return this.provider.exists(this.ns + key);
  }

  async clear(): Promise<void> {
    return this.provider.clear(this.ns);
  }

  async size(): Promise<number> {
    return this.provider.size(this.ns);
  }

  /**
   * Cache-aside pattern:
   * Returns cached value if present, otherwise calls `fn`, caches the result, and returns it.
   */
  async getOrSet<T>(
    key: string,
    fn: () => Promise<T>,
    options?: CacheSetOptions
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await fn();
    await this.set(key, value, options);
    return value;
  }

  /**
   * Wraps an async function so its result is cached automatically.
   */
  wrap<TArgs extends unknown[], TReturn>(
    key: string | ((...args: TArgs) => string),
    fn: (...args: TArgs) => Promise<TReturn>,
    options?: CacheSetOptions
  ): (...args: TArgs) => Promise<TReturn> {
    return async (...args: TArgs): Promise<TReturn> => {
      const resolvedKey = typeof key === "function" ? key(...args) : key;
      return this.getOrSet(resolvedKey, () => fn(...args), options);
    };
  }
}
