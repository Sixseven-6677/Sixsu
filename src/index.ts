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

import { createApp }                   from "./app";
import { Bot }                         from "./core/Bot";
import { FacebookConnection }          from "./facebook/FacebookConnection";
import { FacebookClient }              from "./facebook/FacebookClient";
import { FacebookSender }              from "./facebook/FacebookSender";
import { CookieHttpClient }            from "./facebook/cookie/CookieHttpClient";
import { MiraiTransport }              from "./facebook/mirai/MiraiTransport";
import { MiraiSender }                 from "./facebook/mirai/MiraiSender";
import { FcaEventAdapter }             from "./facebook/mirai/FcaEventAdapter";
import { ISender }                     from "./facebook/types/ISender";
import { FacebookEventNormalizer }     from "./facebook/FacebookEventNormalizer";
import { FacebookGateway }             from "./facebook/FacebookGateway";
import { CommandRegistry }             from "./commands/CommandRegistry";
import { CommandLoader }               from "./commands/CommandLoader";
import { CommandPipeline }             from "./commands/CommandPipeline";
import { typingMiddleware }            from "./commands/middleware/typing.middleware";
import { MiddlewareManager }           from "./middleware/MiddlewareManager";
import { createLoggingMiddleware }     from "./middleware/built-in/logging.middleware";
import { createCooldownMiddleware }    from "./middleware/built-in/cooldown.middleware";
import { createAntiSpamMiddleware }    from "./middleware/built-in/antispam.middleware";
import { createPermissionsMiddleware } from "./middleware/built-in/permissions.middleware";
import {
  BanStore, BanEntry, createBannedMiddleware,
} from "./middleware/built-in/banned.middleware";
import { DatabaseManager }   from "./database/DatabaseManager";
import { UserRepository }    from "./database/repositories/user.repository";
import { CacheManager }      from "./cache/CacheManager";
import { createCacheProvider } from "./cache/providers/createProvider";
import { UserService }       from "./users/UserService";
import { TaskScheduler }     from "./scheduler";
import { AuthManager }       from "./facebook/auth/AuthManager";
import { SessionManager }    from "./facebook/session/SessionManager";
import { SessionStore }      from "./facebook/session/SessionStore";
import { ReconnectManager }  from "./facebook/reconnect/ReconnectManager";
import { ProcessErrorHandler } from "./errors/handlers/ProcessErrorHandler";
import { PluginManager }     from "./plugins/PluginManager";
import {
  setCommandPipeline, setCommandRegistry, setTaskScheduler,
  setReconnectManager, setBanStore, setUserService,
  handleMessage,
} from "./handlers/message.handler";
import {
  setGroupSender, handleMemberJoined, handleMemberLeft,
} from "./handlers/group.handler";

function buildBanMessage(entry: BanEntry): string {
  const expiry = entry.expiresAt
    ? ` ينتهي: ${entry.expiresAt.toLocaleString("ar-SA")}.`
    : "";
  if (entry.reason?.startsWith("[MUTED]")) return `🔇 تم كتمك من التفاعل مع البوت.${expiry}`;
  if (entry.reason?.startsWith("[KICKED]")) return `👢 تم طردك مؤقتاً.${expiry}`;
  const reason = entry.reason ? ` السبب: ${entry.reason}.` : "";
  const durStr = entry.expiresAt ? expiry : " الحظر دائم.";
  return `🚫 أنت محظور من استخدام البوت.${reason}${durStr}`;
}

async function bootstrap(): Promise<void> {

  // ── AppState check ────────────────────────────────────────────────────────
  const appStateEnvKey = config.auth.appStateEnvKey;
  const appStateValue  = process.env[appStateEnvKey] ?? process.env["FB_APPSTATE"];
  if (!appStateValue && !config.auth.appStateFile) {
    log.error(
      "لم يُعثر على AppState. عيّن FB_APPSTATE (base64 cookie export) في متغيرات البيئة."
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

  // ── Auth / Session ────────────────────────────────────────────────────────
  const auth = new AuthManager();

  if (config.auth.appStateFile) {
    const { provider } = AuthManager.fromFile("default", config.auth.appStateFile);
    auth.registerAccount("default", provider);
  } else if (appStateValue) {
    const { provider } = AuthManager.fromEnv("default", appStateEnvKey);
    auth.registerAccount("default", provider);
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
    healthCheckIntervalMs: 30_000,
    spamWindowMs:          60_000,
    maxAttemptsPerWindow:  3,
  });
  bot.register(reconnect);

  // ── Facebook Transport: MiraiTransport (fca-unofficial) ───────────────────
  // Uses the same session (AppState) for both listening and sending,
  // avoiding the cookie-conflict issues of having two auth mechanisms.
  let sender:         ISender;
  let cookieClient:   CookieHttpClient  | null = null;
  let miraiTransport: MiraiTransport    | null = null;
  let botUserId                               = "";

  const credentials = auth.getCredentials("default");

  if (credentials) {
    // Keep CookieHttpClient solely for the fb-cookie-client plugin service.
    cookieClient   = new CookieHttpClient(credentials.appState);
    botUserId      = cookieClient.getUserId();

    miraiTransport = new MiraiTransport(credentials.appState);
    sender         = new MiraiSender(miraiTransport);

    log.info("Sender: MiraiSender active (fca-unofficial via AppState).", {
      userId: botUserId,
    });
  } else if (config.facebook.pageAccessToken) {
    const connection = new FacebookConnection();
    const client     = new FacebookClient(connection);
    sender           = new FacebookSender(client);
    connection.connect();
    log.info("Sender: FacebookSender active (Graph API).");
  } else {
    log.error("No sender available. Set FB_APPSTATE in your environment.");
    process.exit(1);
  }

  setGroupSender(sender);

  const normalizer  = new FacebookEventNormalizer();
  const connection  = new FacebookConnection();
  const gateway     = new FacebookGateway(connection, sender, normalizer);
  connection.connect();

  // ── User System ───────────────────────────────────────────────────────────
  const userRepo = new UserRepository();
  const userSvc  = new UserService(userRepo, cache.store("users"));
  gateway.getContextBuilder().setUserService(userSvc);
  setUserService(userSvc);

  // ── Commands ──────────────────────────────────────────────────────────────
  const registry    = new CommandRegistry();
  const loader      = new CommandLoader(registry);
  const commandsDir = path.resolve(config.bot.commandsDir);

  await loader.load(commandsDir);
  loader.watch(commandsDir);

  const banStore = new BanStore();

  const mwManager = new MiddlewareManager()
    .register(createBannedMiddleware({ store: banStore, message: buildBanMessage }))
    .register(createLoggingMiddleware({ logEntry: true }))
    .register(createAntiSpamMiddleware({ maxMessages: 5, windowMs: 10_000 }))
    .register(createCooldownMiddleware({ durationMs: 3_000 }))
    .register(createPermissionsMiddleware({ adminIds: config.bot.adminIds }));

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

  // ── Plugin System ─────────────────────────────────────────────────────────
  const pluginManager = new PluginManager({
    commandRegistry: registry,
    scheduler,
    pluginsDir: path.resolve(config.plugins.dir),
    watch:      config.plugins.watch,
  });

  const svcReg = pluginManager.getServiceRegistry();
  svcReg.provide("command-registry", registry,  "core");
  svcReg.provide("facebook-sender",  sender,    "core");
  svcReg.provide("ban-store",        banStore,  "core");
  svcReg.provide("user-service",     userSvc,   "core");

  if (cookieClient) {
    // fb-cookie-client kept for backward compatibility with plugins
    svcReg.provide("fb-cookie-client", cookieClient, "core");
    log.info("Core service registered: fb-cookie-client.");
  }

  // ── MiraiTransport: FCA event listener → Adapter → Pipeline ───────────────
  if (miraiTransport) {
    const adapter = new FcaEventAdapter(botUserId);

    miraiTransport.setEventHandler((fcaEvent) => {
      const entries = adapter.adapt(fcaEvent);

      for (const entry of entries) {
        // ── [DEBUG-3] Handing MessagingEntry to gateway pipeline ─────────
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
            onMemberJoined: handleMemberJoined,
            onMemberLeft:   handleMemberLeft,
          },
        );
      }
    });

    bot.register(miraiTransport);

    log.info("MiraiTransport registered — fca-unofficial MQTT listener active.", {
      userId: botUserId,
    });
  }

  bot.register(pluginManager);

  // ── Express server ────────────────────────────────────────────────────────
  const app = createApp(gateway, {
    onMemberJoined: handleMemberJoined,
    onMemberLeft:   handleMemberLeft,
  });

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

  if (process.send) {
    process.send("ready");
    log.info("Sent ready signal to PM2.");
  }
}

bootstrap().catch((err: unknown) => {
  log.error("Fatal error during startup.", err);
  process.exit(1);
});
