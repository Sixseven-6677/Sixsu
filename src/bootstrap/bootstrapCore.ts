/**
 * bootstrapCore
 *
 * Initialises the fundamental runtime systems (Bot, error handler, cache,
 * scheduler, optional DatabaseManager). Returns the live instances so the
 * orchestrator can pass them to subsequent bootstrap modules.
 */
import { Bot }                from "../core/Bot";
import { CacheManager }       from "../cache/CacheManager";
import { createCacheProvider } from "../cache/providers/createProvider";
import { DatabaseManager }    from "../database/DatabaseManager";
import { TaskScheduler }      from "../scheduler";
import { ProcessErrorHandler } from "../errors/handlers/ProcessErrorHandler";
import { LoggerManager }      from "../logger/LoggerManager";

const log = LoggerManager.getLogger("Boot.Core");

export interface CoreBootstrap {
  bot:          Bot;
  cache:        CacheManager;
  scheduler:    TaskScheduler;
  mongoEnabled: boolean;
}

export async function bootstrapCore(mongoUri: string): Promise<CoreBootstrap> {
  const bot   = new Bot();
  const cache = new CacheManager({ provider: await createCacheProvider() });
  bot.register(cache);

  const mongoEnabled =
    (mongoUri.startsWith("mongodb://") && mongoUri.length > 10) ||
    (mongoUri.startsWith("mongodb+srv://") && mongoUri.length > 14);

  if (mongoEnabled) {
    bot.register(new DatabaseManager());
    log.info("Core: MongoDB enabled.");
  } else if (mongoUri) {
    log.warn("Core: MONGODB_URI looks invalid — skipping. Set a valid mongodb+srv:// URI.");
  } else {
    log.warn(
      "Core: no MONGODB_URI — running without persistence. " +
      "Set MONGODB_URI on Railway to enable full persistence."
    );
  }

  const scheduler = new TaskScheduler();
  bot.register(scheduler);

  return { bot, cache, scheduler, mongoEnabled };
}
