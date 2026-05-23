import { ICacheProvider } from "../types/ICache";
import { MemoryProvider } from "./MemoryProvider";
import { RedisProvider } from "./RedisProvider";
import { LoggerManager } from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("Cache");

/**
 * Factory that resolves the best available cache provider at startup.
 *
 * Resolution order:
 *   1. If REDIS_URL is set → try RedisProvider.connect()
 *      - Success : Redis is used.
 *      - Failure : logs a warning and falls back to MemoryProvider.
 *   2. If REDIS_URL is absent → MemoryProvider is used directly.
 *
 * This means the app never crashes due to Redis being unavailable;
 * it degrades gracefully while making the situation visible in logs.
 */
export async function createCacheProvider(): Promise<ICacheProvider> {
  const redisUrl = process.env["REDIS_URL"];

  if (!redisUrl) {
    log.info(
      "Cache: REDIS_URL is not set — using in-memory cache. " +
      "Set REDIS_URL to enable Redis."
    );
    return new MemoryProvider();
  }

  log.info("Cache: REDIS_URL detected — attempting to connect to Redis...");

  try {
    const provider = await RedisProvider.connect(redisUrl);
    log.info("Cache: Redis connected successfully. Using RedisProvider.");
    return provider;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(
      `Cache: Redis unavailable — ${reason} ` +
      "Falling back to in-memory cache. Data will not persist across restarts."
    );
    return new MemoryProvider();
  }
}
