// Polyfill: MongoDB driver requires globalThis.crypto (Node 18+).
if (typeof globalThis.crypto === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("crypto");
  if (nodeCrypto.webcrypto) {
    Object.defineProperty(globalThis, "crypto", {
      value: nodeCrypto.webcrypto,
      configurable: true,
      writable: true,
    });
  }
}

import express            from "express";
import { config }         from "./config/env";
import { LoggerManager }  from "./logger/LoggerManager";
import { LogLevel }       from "./logger/types/ILogger";
import { prefixStore }    from "./prefix/PrefixStore";
import { runMigrationIfNeeded } from "./database/migration";

import { bootstrapCore }                      from "./bootstrap/bootstrapCore";
import { bootstrapAuth }                      from "./bootstrap/bootstrapAuth";
import { bootstrapStores }                    from "./bootstrap/bootstrapStores";
import { bootstrapCommands }                  from "./bootstrap/bootstrapCommands";
import { bootstrapFacebook, ActiveTransport } from "./bootstrap/bootstrapFacebook";
import { bootstrapPlugins }                   from "./bootstrap/bootstrapPlugins";
import { bootstrapRoutes }                    from "./bootstrap/bootstrapRoutes";

LoggerManager.configure({
  level:         config.logger.level as LogLevel,
  logDir:        config.logger.dir,
  enableFile:    config.logger.enableFile,
  enableConsole: true,
});

const log = LoggerManager.getLogger("Boot");

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {

  // 1. HTTP server — Railway healthcheck passes immediately
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // transports is populated by bootstrapFacebook; health uses it via closure
  const transports: ActiveTransport[] = [];

  app.get(["/health", "/api/health", "/api/healthz"], (_req, res) => {
    res.status(200).json({
      status:  "ok",
      uptime:  process.uptime(),
      accounts: transports.map(({ label, transport: t }) => ({
        account:   label,
        connected: t.isConnected(),
        running:   t.isRunning(),
        userId:    t.getCurrentUserId() || null,
      })),
    });
  });

  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(config.port, () => {
      log.info(`HTTP server ready on port ${config.port}.`, { env: config.nodeEnv });
      resolve();
    });
    srv.on("error", (err: Error) => { log.error("HTTP server failed.", err); reject(err); });
  });

  // 2. Core: Bot + CacheManager + TaskScheduler + optional DatabaseManager
  const { bot, cache, scheduler, mongoEnabled } = await bootstrapCore(config.database.mongoUri);

  // 3. Auth: AuthManager + SessionManager + ReconnectManager
  const { auth, reconnect } = await bootstrapAuth(bot);

  // 4. In-memory stores + UserService
  const { banStore, lockdownStore, adminStore, userSvc } = bootstrapStores(
    config.bot.adminIds,
    cache,
  );

  // 5. Command registry + pipeline + all middleware + MessageHandler singleton
  const { registry } = await bootstrapCommands(
    banStore, lockdownStore, adminStore, scheduler, reconnect, userSvc,
  );

  // 6. FCA accounts: transports + reconnect hooks
  const booted = bootstrapFacebook(auth, userSvc, adminStore, bot, reconnect);
  transports.push(...booted);

  // 7. Plugin system + optional MongoDB repos (pre-wired before bot.start())
  const {
    botAdminRepo, groupSettingsRepo, banRepo, botConfigRepo,
  } = bootstrapPlugins(
    bot, registry, scheduler, userSvc,
    banStore, lockdownStore, adminStore,
    transports, mongoEnabled,
  );

  // 8. Webhook routes + 404 + error handlers (must come after all routes)
  bootstrapRoutes(app, transports, adminStore, userSvc);

  // 9. Start all registered systems in registration order
  //    (DatabaseManager connects here — must precede any DB read)
  await bot.start();

  // 10. Post-start: load persisted data from MongoDB into in-memory stores
  //     DB is connected at this point; repos were pre-wired in step 7.
  if (mongoEnabled && botAdminRepo && groupSettingsRepo && banRepo) {
    try {
      await Promise.all([
        adminStore.loadFromDatabase(),
        lockdownStore.loadFromDatabase(),
        banStore.loadFromDatabase(),
      ]);

      if (botConfigRepo) {
        await prefixStore.loadFromDatabase(botConfigRepo);
      }

      // One-time migration: import any data/*.json files into MongoDB.
      await runMigrationIfNeeded();

      log.info("Post-start: stores loaded from MongoDB.", {
        admins:        adminStore.size(),
        lockedThreads: lockdownStore.lockedCount,
        activeBans:    banStore.size,
        prefix:        prefixStore.get(),
      });
    } catch (err) {
      log.error("Post-start: failed to load from MongoDB.", err);
    }
  }

  log.info("── BOT READY ──", {
    accounts:   transports.map(({ label, transport: t }) => ({
      label,
      userId:    t.getCurrentUserId(),
      connected: t.isConnected(),
    })),
    prefix:     prefixStore.get(),
    nodeEnv:    config.nodeEnv,
    mongoDb:    mongoEnabled ? "connected" : "disabled — set MONGODB_URI",
    adminCount: adminStore.size(),
  });

  if (process.send) process.send("ready");
}

bootstrap().catch((err: unknown) => {
  log.error("Fatal startup error.", err);
  process.exit(1);
});
