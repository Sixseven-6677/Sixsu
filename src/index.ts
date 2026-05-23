import path from "path";
import { config } from "./config/env";
import { LoggerManager } from "./logger/LoggerManager";
import { LogLevel } from "./logger/types/ILogger";

LoggerManager.configure({
  level:         config.logger.level as LogLevel,
  logDir:        config.logger.dir,
  enableFile:    config.logger.enableFile,
  enableConsole: true,
});

const log = LoggerManager.getLogger("Boot");

import { createApp } from "./app";
import { Bot } from "./core/Bot";
import { FacebookConnection } from "./facebook/FacebookConnection";
import { FacebookClient } from "./facebook/FacebookClient";
import { FacebookSender } from "./facebook/FacebookSender";
import { FacebookEventNormalizer } from "./facebook/FacebookEventNormalizer";
import { FacebookGateway } from "./facebook/FacebookGateway";
import { CommandRegistry } from "./commands/CommandRegistry";
import { CommandLoader } from "./commands/CommandLoader";
import { CommandPipeline } from "./commands/CommandPipeline";
import { typingMiddleware } from "./commands/middleware/typing.middleware";
import { MiddlewareManager } from "./middleware/MiddlewareManager";
import { createLoggingMiddleware } from "./middleware/built-in/logging.middleware";
import { createCooldownMiddleware } from "./middleware/built-in/cooldown.middleware";
import { createAntiSpamMiddleware } from "./middleware/built-in/antispam.middleware";
import { createPermissionsMiddleware } from "./middleware/built-in/permissions.middleware";
import { BanStore, createBannedMiddleware } from "./middleware/built-in/banned.middleware";
import { DatabaseManager } from "./database/DatabaseManager";
import { CacheManager } from "./cache/CacheManager";
import { createCacheProvider } from "./cache/providers/createProvider";
import { TaskScheduler } from "./scheduler";
import { AuthManager }      from "./facebook/auth/AuthManager";
import { SessionManager }   from "./facebook/session/SessionManager";
import { SessionStore }     from "./facebook/session/SessionStore";
import { ReconnectManager }    from "./facebook/reconnect/ReconnectManager";
import { ProcessErrorHandler }  from "./errors/handlers/ProcessErrorHandler";
import { PluginManager } from "./plugins/PluginManager";
import {
  setCommandPipeline,
  setCommandRegistry,
  setTaskScheduler,
  setReconnectManager,
  setBanStore,
} from "./handlers/message.handler";
import {
  CredentialManager,
  EnvLoader,
  EncryptedFileLoader,
  StartupValidator,
  EnvPresenceCheck,
  CredentialLoadCheck,
  SessionIntegrityCheck,
  CheckSeverity,
} from "./security";

async function bootstrap(): Promise<void> {
  // ─── Security: Startup Validation ────────────────────────────────────────
  const credManager = new CredentialManager({
    loaders: [
      new EnvLoader({
        required: ["FB_PAGE_ACCESS_TOKEN", "FB_APP_SECRET", "FB_VERIFY_TOKEN"],
        optional: ["SESSION_SECRET"],
      }),
      ...(config.auth.appStateFile
        ? [new EncryptedFileLoader({
            filePath:      config.auth.appStateFile,
            encryptionKey: config.auth.sessionSecret,
          })]
        : []),
    ],
  });

  const validator = new StartupValidator()
    .add(new EnvPresenceCheck({
      required:  ["FB_PAGE_ACCESS_TOKEN", "FB_APP_SECRET", "FB_VERIFY_TOKEN", "SESSION_SECRET"],
      severity:  CheckSeverity.CRITICAL,
    }))
    .add(new CredentialLoadCheck(credManager))
    .add(new SessionIntegrityCheck({
      sessionFilePath: config.auth.sessionFile,
      severity:        CheckSeverity.WARNING,
    }));

  const report = await validator.validate();

  if (!report.passed) {
    log.error(
      `Startup aborted — ${report.criticalFailed.length} critical check(s) failed: ` +
      `[${report.criticalFailed.join(", ")}]`
    );
    process.exit(1);
  }
  // ─────────────────────────────────────────────────────────────────────────

  const bot = new Bot();

  const errorHandler = new ProcessErrorHandler();
  errorHandler.onCriticalError(async () => {
    log.error("Critical error triggered — initiating emergency shutdown.");
    await bot.stop();
  });
  bot.register(errorHandler);

  const cache = new CacheManager({ provider: await createCacheProvider() });
  bot.register(cache);

  const db = new DatabaseManager();
  bot.register(db);

  const scheduler = new TaskScheduler();
  bot.register(scheduler);

  // Auth & Session
  const auth = new AuthManager();

  if (config.auth.appStateFile) {
    const { provider } = AuthManager.fromFile("default", config.auth.appStateFile);
    auth.registerAccount("default", provider);
  } else if (process.env[config.auth.appStateEnvKey]) {
    const { provider } = AuthManager.fromEnv("default", config.auth.appStateEnvKey);
    auth.registerAccount("default", provider);
  }

  bot.register(auth);

  const sessionStore   = new SessionStore(config.auth.sessionFile, config.auth.sessionSecret);
  const sessionManager = new SessionManager({
    store: sessionStore,
    auth,
    ttlMs: config.auth.sessionTtlDays * 24 * 60 * 60 * 1000,
  });
  bot.register(sessionManager);

  const reconnect = new ReconnectManager(auth, sessionManager, {
    retry:                 { maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 60_000 },
    healthCheckIntervalMs: 30_000,
    spamWindowMs:          60_000,
    maxAttemptsPerWindow:  3,
  });
  bot.register(reconnect);

  const connection = new FacebookConnection();
  const client     = new FacebookClient(connection);
  const sender     = new FacebookSender(client);
  const normalizer = new FacebookEventNormalizer();
  const gateway    = new FacebookGateway(connection, sender, normalizer);

  connection.connect();

  const registry    = new CommandRegistry();
  const loader      = new CommandLoader(registry);
  const commandsDir = path.resolve(config.bot.commandsDir);

  await loader.load(commandsDir);
  loader.watch(commandsDir);

  // ─── Middleware Pipeline ──────────────────────────────────────────────────
  const banStore = new BanStore();

  const mwManager = new MiddlewareManager()
    .register(createBannedMiddleware({ store: banStore }))
    .register(createLoggingMiddleware({ logEntry: true }))
    .register(createAntiSpamMiddleware({ maxMessages: 5, windowMs: 10_000 }))
    .register(createCooldownMiddleware({ durationMs: 3_000 }))
    .register(createPermissionsMiddleware({ adminIds: config.bot.adminIds }));

  log.info(
    `Middleware pipeline: [${mwManager.list().join(" → ")}] → typing → execute`
  );

  const pipeline = new CommandPipeline(registry, config.bot.prefix)
    .use(mwManager.fn("banned"))
    .use(mwManager.fn("logging"))
    .use(mwManager.fn("antispam"))
    .use(mwManager.fn("cooldown"))
    .use(mwManager.fn("permissions"))
    .use(typingMiddleware)
    .onNotFound(async (ctx) => {
      await ctx.reply(`❓ الأمر "${ctx.commandName}" غير موجود.`);
    });

  setCommandPipeline(pipeline);
  setCommandRegistry(registry);
  setTaskScheduler(scheduler);
  setReconnectManager(reconnect);
  setBanStore(banStore);

  // ─── Plugin System ────────────────────────────────────────────────────────
  // PluginManager is registered last so all core systems are available when
  // plugins call initialize(). It declares "scheduler" as a dependency so
  // Bot.start() initialises it after the scheduler is ready.
  const pluginManager = new PluginManager({
    commandRegistry: registry,
    scheduler,
    pluginsDir:      path.resolve(config.plugins.dir),
    watch:           config.plugins.watch,
  });
  bot.register(pluginManager);
  // ─────────────────────────────────────────────────────────────────────────

  const app = createApp(gateway);

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(config.port, () => {
      log.info(`Server listening on port ${config.port}`, { env: config.nodeEnv });
      resolve();
    });

    server.on("error", (err: Error) => {
      log.error("Failed to start server.", err);
      reject(err);
    });
  });

  await bot.start();

  // ─── PM2 ready signal ─────────────────────────────────────────────────────
  if (process.send) {
    process.send("ready");
    log.info("Sent ready signal to PM2.");
  }
}

bootstrap().catch((err: unknown) => {
  log.error("Fatal error during startup.", err);
  process.exit(1);
});
