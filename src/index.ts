// Polyfill: MongoDB driver requires globalThis.crypto (Node 18+).
// This ensures compatibility on all Railway Node versions.
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

import path    from "path";
import express from "express";
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

import { createWebhookRouter }               from "./routes/webhook.route";
import { httpErrorHandler, notFoundHandler }  from "./errors/handlers/HttpErrorHandler";
import { Bot }                               from "./core/Bot";
import { FacebookConnection }                from "./facebook/FacebookConnection";
import { FacebookSender }                    from "./facebook/FacebookSender";
import { FacebookClient }                    from "./facebook/FacebookClient";
import { CookieHttpClient }                  from "./facebook/cookie/CookieHttpClient";
import { MiraiTransport }                    from "./facebook/mirai/MiraiTransport";
import { MiraiSender }                       from "./facebook/mirai/MiraiSender";
import { HumanBehaviorSender }               from "./facebook/HumanBehaviorSender";
import { FcaEventAdapter }                   from "./facebook/mirai/FcaEventAdapter";
import { ISender }                           from "./facebook/types/ISender";
import { FacebookEventNormalizer }           from "./facebook/FacebookEventNormalizer";
import { FacebookGateway }                   from "./facebook/FacebookGateway";
import { CommandRegistry }                   from "./commands/CommandRegistry";
import { CommandLoader }                     from "./commands/CommandLoader";
import { CommandPipeline }                   from "./commands/CommandPipeline";
import { typingMiddleware }                  from "./commands/middleware/typing.middleware";
import { groupMuteMiddleware }                from "./commands/middleware/groupmute.middleware";
import { MiddlewareManager }                 from "./middleware/MiddlewareManager";
import { createLoggingMiddleware }           from "./middleware/built-in/logging.middleware";
import { createCooldownMiddleware }          from "./middleware/built-in/cooldown.middleware";
import { createAntiSpamMiddleware }          from "./middleware/built-in/antispam.middleware";
import { createPermissionsMiddleware }       from "./middleware/built-in/permissions.middleware";
import {
  BanStore, BanEntry, createBannedMiddleware,
} from "./middleware/built-in/banned.middleware";
import { LockdownStore, createLockdownMiddleware } from "./middleware/built-in/lockdown.middleware";
import { AdminStore }                        from "./middleware/built-in/admin-store";
import { DatabaseManager }                   from "./database/DatabaseManager";
import { UserRepository }                    from "./database/repositories/user.repository";
import { BotAdminRepository }               from "./database/repositories/botadmin.repository";
import { GroupSettingsRepository }          from "./database/repositories/group-settings.repository";
import { BanRepository }                    from "./database/repositories/ban.repository";
import { BlackConfigRepository }            from "./database/repositories/black-config.repository";
import { BotConfigRepository }              from "./database/repositories/bot-config.repository";
import { CommandStatsRepository }           from "./database/repositories/command-stats.repository";
import { runMigrationIfNeeded }             from "./database/migration";
import { CacheManager }                      from "./cache/CacheManager";
import { createCacheProvider }               from "./cache/providers/createProvider";
import { UserService }                       from "./users/UserService";
import { TaskScheduler }                     from "./scheduler";
import { AuthManager }                       from "./facebook/auth/AuthManager";
import { SessionManager }                    from "./facebook/session/SessionManager";
import { SessionStore }                      from "./facebook/session/SessionStore";
import { ReconnectManager }                  from "./facebook/reconnect/ReconnectManager";
import { ProcessErrorHandler }               from "./errors/handlers/ProcessErrorHandler";
import { PluginManager }                     from "./plugins/PluginManager";
import { prefixStore }                      from "./prefix/PrefixStore";
import { AuthCredentials }                   from "./facebook/auth/types/IAuth";
import {
  setCommandPipeline, setCommandRegistry, setTaskScheduler,
  setReconnectManager, setBanStore, setUserService,
  handleMessage,
} from "./handlers/message.handler";
import {
  setGroupSender, setGroupBotUserId, setGroupApiGetter,
  handleMemberJoined, handleMemberLeft,
  handleNameChanged, handleNicknameChanged,
} from "./handlers/group.handler";

function buildBanMessage(entry: BanEntry): string {
  const expiry = entry.expiresAt
    ? ` ينتهي: ${entry.expiresAt.toLocaleString("ar-SA")}.`
    : "";
  if (entry.reason?.startsWith("[MUTED]"))  return `🔇 تم كتمك من التفاعل مع البوت.${expiry}`;
  if (entry.reason?.startsWith("[KICKED]")) return `👢 تم طردك مؤقتاً.${expiry}`;
  const reason = entry.reason ? ` السبب: ${entry.reason}.` : "";
  const durStr = entry.expiresAt ? expiry : " الحظر دائم.";
  return `🚫 أنت محظور من استخدام البوت.${reason}${durStr}`;
}

function isValidMongoUri(uri: string): boolean {
  return (uri.startsWith("mongodb://") && uri.length > 10) ||
         (uri.startsWith("mongodb+srv://") && uri.length > 14);
}

// ─── Per-account setup ────────────────────────────────────────────────────────

interface AccountSetupOptions {
  label:           string;
  credentials:     AuthCredentials;
  userSvc:         UserService;
  adminStore:      AdminStore;
  bot:             Bot;
  isPrimary:       boolean;
  /** Milliseconds to wait before the first login attempt (stagger). Default: 0.
   *  Set ≥5000 for secondary accounts to prevent Facebook rate-limits / MQTT
   *  interference when two accounts log in from the same IP in quick succession. */
  startupDelayMs?: number;
}

function bootFcaAccount(opts: AccountSetupOptions): MiraiTransport {
  const { label, credentials, userSvc, adminStore, bot, isPrimary, startupDelayMs = 0 } = opts;

  const cookieClient = new CookieHttpClient(credentials.appState);
  const botUserId    = cookieClient.getUserId();

  const systemName   = isPrimary ? "mirai-transport" : `mirai-transport-${label}`;

  // Pass startupDelayMs so secondary accounts stagger their login attempts.
  const transport    = new MiraiTransport(credentials.appState, systemName, startupDelayMs);
  const sender: ISender = new HumanBehaviorSender(new MiraiSender(transport));

  log.info(`Account [${label}]: transport created.`, { botUserId, systemName, startupDelayMs });

  if (isPrimary) {
    setGroupSender(sender);
    setGroupBotUserId(botUserId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setGroupApiGetter(() => transport.getApi() as any);
  }

  const normalizer  = new FacebookEventNormalizer();
  const connection  = new FacebookConnection();
  const gateway     = new FacebookGateway(connection, sender, normalizer);
  connection.connect();

  gateway.getContextBuilder().setOwnerIds(config.bot.ownerIds);
  gateway.getContextBuilder().setUserService(userSvc);
  gateway.getContextBuilder().setAdminStore(adminStore);

  const adapter = new FcaEventAdapter(botUserId);

  // Capture the account-specific sender and API getter in closures so group
  // events (member joined/left, name/nickname changes) are processed through
  // the correct account rather than always falling back to the primary account.
  const accountSender    = sender;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountApiGetter = (): any => transport.getApi();

  transport.setEventHandler((fcaEvent) => {
    const entries = adapter.adapt(fcaEvent);
    for (const entry of entries) {
      gateway.processWebhookBody(
        {
          object: "page",
          entry: [{
            id:        botUserId,
            time:      entry.timestamp,
            messaging: [entry],
          }],
        },
        handleMessage,
        {
          // Pass per-account sender so secondary account's group events
          // are delivered via the secondary account, not via primary.
          onMemberJoined:    (evt) => handleMemberJoined(evt, accountSender),
          onMemberLeft:      (evt) => handleMemberLeft(evt, accountSender),
          // Pass per-account API getter so name/nickname protection reverts
          // (setTitle / changeNickname) are executed through the account that
          // actually received the event — not always the primary account.
          onNameChanged:     (evt) => handleNameChanged(evt, accountApiGetter),
          onNicknameChanged: (evt) => handleNicknameChanged(evt, accountApiGetter),
        },
      );
    }
  });

  bot.register(transport);
  log.info(`Account [${label}]: registered (${systemName}).`, { botUserId });
  return transport;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {

  // 1. HTTP server starts first — Railway healthcheck passes immediately
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  const transports: Array<{ label: string; transport: MiraiTransport }> = [];

  app.get(["/health", "/api/health", "/api/healthz"], (_req, res) => {
    const accounts = transports.map(({ label, transport: t }) => ({
      account:   label,
      connected: t.isConnected(),
      running:   t.isRunning(),
      userId:    t.getCurrentUserId() || null,
    }));
    res.status(200).json({ status: "ok", uptime: process.uptime(), accounts });
  });

  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(config.port, () => {
      log.info(`HTTP server ready on port ${config.port}.`, { env: config.nodeEnv });
      resolve();
    });
    srv.on("error", (err: Error) => { log.error("HTTP server failed.", err); reject(err); });
  });

  // 2. Core services
  const bot = new Bot();

  const errorHandler = new ProcessErrorHandler();
  errorHandler.onCriticalError(async () => {
    log.error("Critical error — emergency shutdown.");
    await bot.stop();
  });
  bot.register(errorHandler);

  const cache = new CacheManager({ provider: await createCacheProvider() });
  bot.register(cache);

  const mongoUri    = config.database.mongoUri;
  const mongoEnabled = isValidMongoUri(mongoUri);

  if (mongoEnabled) {
    bot.register(new DatabaseManager());
    log.info("Database: MongoDB enabled.");
  } else if (mongoUri) {
    log.warn("Database: MONGODB_URI looks invalid — skipping. Set a valid mongodb+srv:// URI.");
  } else {
    log.warn(
      "Database: no MONGODB_URI set — running without persistence. " +
      "Admins added at runtime will be lost on restart. " +
      "Set MONGODB_URI on Railway to enable full persistence."
    );
  }

  const scheduler = new TaskScheduler();
  bot.register(scheduler);

  // 3. Auth — register primary and optional secondary account
  const auth = new AuthManager();

  const appStateVal  = process.env[config.auth.appStateEnvKey] ?? process.env["FB_APPSTATE"];
  const appStateFile = config.auth.appStateFile;
  if (appStateFile) {
    auth.registerAccount("primary", AuthManager.fromFile("primary", appStateFile).provider);
  } else if (appStateVal) {
    auth.registerAccount("primary", AuthManager.fromEnv("primary", config.auth.appStateEnvKey).provider);
  } else {
    log.warn("FB_APPSTATE not set — health-only mode.");
  }

  const appStateVal2  = process.env[config.auth.appStateEnvKey2] ?? process.env["FB_APPSTATE_2"];
  const appStateFile2 = config.auth.appStateFile2;
  if (appStateFile2) {
    auth.registerAccount("secondary", AuthManager.fromFile("secondary", appStateFile2).provider);
    log.info("Secondary account registered from file.");
  } else if (appStateVal2) {
    auth.registerAccount("secondary", AuthManager.fromEnv("secondary", config.auth.appStateEnvKey2).provider);
    log.info("Secondary account registered from env (FB_APPSTATE_2).");
  }

  await auth.loginAll();
  bot.register(auth);

  const sessionStore   = new SessionStore(config.auth.sessionFile, config.auth.sessionSecret ?? "");
  const sessionManager = new SessionManager({
    store: sessionStore,
    auth,
    ttlMs: config.auth.sessionTtlDays * 24 * 60 * 60 * 1000,
  });
  bot.register(sessionManager);

  const reconnect = new ReconnectManager(auth, sessionManager, {
    retry:                 { maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 60_000 },
    // Increased from 30s → 5 minutes.
    // 30s was too aggressive: during any brief MQTT reconnect window (api=null for
    // 5–120s), the health monitor saw isConnected()=false and immediately triggered
    // a full auth.login() → Facebook issued new cookies → old AppState invalidated.
    // 5 minutes gives MiraiTransport's own retry loop time to self-recover before
    // ReconnectManager escalates to a full credential refresh.
    healthCheckIntervalMs: 300_000,
    spamWindowMs:          120_000,
    maxAttemptsPerWindow:  2,
  });
  bot.register(reconnect);

  // 4. User system
  const userRepo = new UserRepository();
  const userSvc  = new UserService(userRepo, cache.store("users"));
  setUserService(userSvc);

  // 5. Commands & middleware
  const registry    = new CommandRegistry();
  const loader      = new CommandLoader(registry);
  await loader.load(path.resolve(config.bot.commandsDir));
  loader.watch(path.resolve(config.bot.commandsDir));

  const banStore      = new BanStore();
  const lockdownStore = new LockdownStore();
  const adminStore    = new AdminStore(config.bot.adminIds);
  log.info("AdminStore ready.", { adminCount: adminStore.size() });

  const mwManager = new MiddlewareManager()
    .register(createBannedMiddleware({ store: banStore, message: buildBanMessage }))
    .register(createLockdownMiddleware({ store: lockdownStore }))
    .register(createLoggingMiddleware({ logEntry: true }))
    .register(createAntiSpamMiddleware({ maxMessages: 5, windowMs: 10_000 }))
    .register(createCooldownMiddleware({ durationMs: 3_000 }))
    .register(createPermissionsMiddleware({ adminIds: config.bot.adminIds, adminStore }));

  const pipeline = new CommandPipeline(registry, () => prefixStore.get())
    .use(mwManager.fn("banned"))
    .use(mwManager.fn("logging"))
    .use(mwManager.fn("lockdown"))
    .use(groupMuteMiddleware)           // block commands from muted groups
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

  // 6. FCA accounts — each gets its own transport + sender + gateway
  const primaryCreds   = auth.getCredentials("primary");
  const secondaryCreds = auth.getCredentials("secondary");

  if (primaryCreds) {
    const t = bootFcaAccount({
      label: "primary", credentials: primaryCreds,
      userSvc, adminStore, bot, isPrimary: true,
      startupDelayMs: 0,  // Primary logs in immediately
    });
    transports.push({ label: "primary", transport: t });
  }

  if (secondaryCreds) {
    const t = bootFcaAccount({
      label: "secondary", credentials: secondaryCreds,
      userSvc, adminStore, bot, isPrimary: false,
      // 5-second stagger: prevents Facebook rate-limits and transient MQTT
      // interference (error 1357031) that occurs when two accounts log in
      // from the same IP address in rapid succession.
      startupDelayMs: 5_000,
    });
    transports.push({ label: "secondary", transport: t });
    log.info("✅ Two accounts active — bot running on primary + secondary Facebook accounts.");
  }

  // Wire ReconnectManager to actually monitor MQTT connectivity (not just credentials)
  // and to restart the transport when credentials are refreshed.
  // Must be done after transports are created so the map is populated.
  if (transports.length > 0) {
    const transportMap = new Map<string, MiraiTransport>(
      transports.map(({ label, transport }) => [label, transport])
    );

    // Health check: only report unhealthy when the transport has *stopped running*
    // (permanent failure or max retries exceeded) — NOT when it is simply mid-reconnect.
    //
    // isConnected() === false during any brief MiraiTransport self-recovery window
    // (api=null for 5-120s). Triggering ReconnectManager during that window causes a
    // full auth.login() → Facebook issues new cookies → old AppState invalidated.
    //
    // isRunning() === false only after MiraiTransport explicitly gives up (appstate
    // expired, or MAX_LOGIN_ATTEMPTS exhausted) — that is the right time to escalate.
    reconnect.setHealthCheck(async (accountId: string) => {
      const t = transportMap.get(accountId);
      if (!t) return false;
      // Healthy = transport is still running (self-recovery in progress counts as healthy)
      // Unhealthy = transport permanently stopped (needs credential refresh)
      return t.isRunning();
    });

    // Restart hook: after ReconnectManager refreshes credentials, also restart the
    // MQTT transport. Without this, auth refreshes silently but the bot stays offline.
    reconnect.setRestartHook(async (accountId: string) => {
      const t = transportMap.get(accountId);
      if (t) {
        log.info(`ReconnectManager → transport restart for account [${accountId}].`);
        await t.restart();
      }
    });

    // Permanent failure hook: when MiraiTransport gives up (AppState expired or
    // max retries exceeded), it signals here so ReconnectManager can decide whether
    // to attempt a full credential refresh or log a critical alert.
    // This prevents the silent zombie state where transport stops retrying but
    // nothing in the outer system knows about it.
    for (const { label, transport: t } of transports) {
      t.setOnPermanentFailure((reason: string) => {
        log.error(
          `Transport [${label}]: permanent failure signalled — reason: ${reason}. ` +
          `Triggering ReconnectManager forced reconnect. [permanent-failure]`,
          { label, reason, stats: t.getStats() },
        );
        // Force an immediate reconnect attempt (bypasses the health-check interval delay).
        // ReconnectManager.reconnect() respects guard limits so it won't spam Facebook.
        reconnect.reconnect(label).catch((err: unknown) => {
          log.error(`Forced reconnect after permanent failure threw for [${label}].`, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    }
  }

  if (!primaryCreds && !secondaryCreds) {
    if (config.facebook.pageAccessToken) {
      const connection = new FacebookConnection();
      const client     = new FacebookClient(connection);
      const sender: ISender = new FacebookSender(client);
      setGroupSender(sender);
      connection.connect();
      log.info("Sender: FacebookSender (Graph API).");
    } else {
      log.warn("No sender — health-only mode. Set FB_APPSTATE.");
      const noOp: ISender = {
        sendText:     async () => { log.warn("NoOpSender: no FB_APPSTATE."); },
        sendTyping:   async () => {},
        sendReaction: async () => {},
      };
      setGroupSender(new HumanBehaviorSender(noOp));
    }
  }

  // 7. Plugin system
  const pluginManager = new PluginManager({
    commandRegistry: registry,
    scheduler,
    pluginsDir: path.resolve(config.plugins.dir),
    watch:      config.plugins.watch,
  });

  const svcReg = pluginManager.getServiceRegistry();
  svcReg.provide("command-registry", registry,      "core");
  svcReg.provide("ban-store",        banStore,       "core");
  svcReg.provide("lockdown-store",   lockdownStore,  "core");
  svcReg.provide("admin-store",      adminStore,     "core");
  svcReg.provide("user-service",     userSvc,        "core");

  if (transports[0]) {
    svcReg.provide("mirai-transport",  transports[0].transport, "core");
    const primarySender = new HumanBehaviorSender(new MiraiSender(transports[0].transport));
    svcReg.provide("facebook-sender", primarySender,            "core");
  }
  if (transports[1]) {
    svcReg.provide("mirai-transport-secondary", transports[1].transport, "core");
  }

  if (config.facebook.pageAccessToken) {
    svcReg.provide("fb-access-token", config.facebook.pageAccessToken, "core");
  }

  // Pre-start MongoDB repos — provided BEFORE bot.register so plugins can consume them
  // during onLoad. DatabaseManager initializes before PluginManager inside bot.start(),
  // so DB is connected by the time any plugin's onLoad runs.
  let botAdminRepo_:       BotAdminRepository     | null = null;
  let groupSettingsRepo_:  GroupSettingsRepository | null = null;
  let banRepo_:            BanRepository           | null = null;
  let botConfigRepo_:      BotConfigRepository     | null = null;

  if (mongoEnabled) {
    botAdminRepo_      = new BotAdminRepository();
    groupSettingsRepo_ = new GroupSettingsRepository();
    banRepo_           = new BanRepository();
    const blackConfigRepo = new BlackConfigRepository();
    botConfigRepo_     = new BotConfigRepository();
    const commandStatsRepo = new CommandStatsRepository();

    adminStore.setRepository(botAdminRepo_);
    lockdownStore.setRepository(groupSettingsRepo_);
    banStore.setRepository(banRepo_);

    svcReg.provide("group-settings-repo", groupSettingsRepo_,  "core");
    svcReg.provide("ban-repo",            banRepo_,            "core");
    svcReg.provide("botadmin-repo",       botAdminRepo_,       "core");
    svcReg.provide("black-config-repo",   blackConfigRepo,     "core");
    svcReg.provide("bot-config-repo",     botConfigRepo_,      "core");
    svcReg.provide("command-stats-repo",  commandStatsRepo,    "core");

    log.info("Database: MongoDB repos wired to stores and service registry (pre-start).");
  }

  bot.register(pluginManager);

  // 8. Webhook routes (primary account handles webhook verification)
  if (transports[0]) {
    const conn    = new FacebookConnection();
    const gateway = new FacebookGateway(
      conn,
      new HumanBehaviorSender(new MiraiSender(transports[0].transport)),
      new FacebookEventNormalizer()
    );
    gateway.getContextBuilder().setOwnerIds(config.bot.ownerIds);
    gateway.getContextBuilder().setUserService(userSvc);
    gateway.getContextBuilder().setAdminStore(adminStore);
    conn.connect();

    app.use("/webhook", createWebhookRouter(gateway, {
      onMemberJoined: (evt) => handleMemberJoined(evt),
      onMemberLeft:   (evt) => handleMemberLeft(evt),
    }));
  }

  app.use(notFoundHandler);
  app.use(httpErrorHandler);

  // 9. Start bot (initializes all registered systems, including DatabaseManager)
  await bot.start();

  // 10. Post-start: load persisted data from MongoDB into in-memory stores
  // (DB is now connected; repos were wired pre-start so plugins already loaded their data)
  if (mongoEnabled && botAdminRepo_ && groupSettingsRepo_ && banRepo_) {
    try {
      await Promise.all([
        adminStore.loadFromDatabase(),
        lockdownStore.loadFromDatabase(),
        banStore.loadFromDatabase(),
      ]);

      if (botConfigRepo_) {
        await prefixStore.loadFromDatabase(botConfigRepo_);
      }

      // One-time migration: imports any existing data/*.json files into MongoDB
      await runMigrationIfNeeded();

      log.info("Post-start: all stores loaded from MongoDB.", {
        admins:        adminStore.size(),
        lockedThreads: lockdownStore.lockedCount,
        activeBans:    banStore.size,
        prefix:        prefixStore.get(),
      });
    } catch (err) {
      log.error("Post-start: failed to load from MongoDB.", err);
    }
  }

  log.info("── BOT READY ────────────────────────────────────────────────", {
    accounts:    transports.map(({ label, transport: t }) => ({
      label,
      userId:    t.getCurrentUserId(),
      connected: t.isConnected(),
    })),
    prefix:      prefixStore.get(),
    nodeEnv:     config.nodeEnv,
    mongoDb:     mongoEnabled ? "connected" : "disabled — set MONGODB_URI for persistence",
    adminCount:  adminStore.size(),
  });

  if (process.send) process.send("ready");
}

bootstrap().catch((err: unknown) => {
  log.error("Fatal startup error.", err);
  process.exit(1);
});
