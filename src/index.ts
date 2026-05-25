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
import { CookieSender }                from "./facebook/cookie/CookieSender";
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
} from "./handlers/message.handler";
import {
  setGroupSender, handleMemberJoined, handleMemberLeft,
} from "./handlers/group.handler";
import {
  CredentialManager, EnvLoader, EncryptedFileLoader,
  StartupValidator, EnvPresenceCheck, CredentialLoadCheck,
  SessionIntegrityCheck, CheckSeverity,
} from "./security";

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

  // ── Startup Validation ────────────────────────────────────────────────────
  const credManager = new CredentialManager({
    loaders: [
      new EnvLoader({
        // FB_PAGE_ACCESS_TOKEN is no longer required — AppState cookies are used instead.
        required: ["FB_APP_SECRET", "FB_VERIFY_TOKEN"],
        optional: ["SESSION_SECRET", "FB_PAGE_ACCESS_TOKEN"],
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
      required:  ["FB_APP_SECRET", "FB_VERIFY_TOKEN", "SESSION_SECRET"],
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

  // ── Auth / Session system ────────────────────────────────────────────────
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

  // ── Sender selection: cookies first, page token as fallback ──────────────
  //
  //   Mode A — Cookie / AppState (preferred, no page token needed):
  //     Set FB_APPSTATE or FB_APPSTATE_FILE → Bot sends via cookie auth.
  //
  //   Mode B — Graph API fallback (requires FB_PAGE_ACCESS_TOKEN):
  //     Set FB_PAGE_ACCESS_TOKEN → Bot sends via official Messenger Platform API.
  //
  let sender: ISender;
  let cookieClient: CookieHttpClient | null = null;

  const credentials = auth.getCredentials("default");

  if (credentials) {
    // ── Mode A: Cookie-based sender ────────────────────────────────────────
    cookieClient = new CookieHttpClient(credentials.appState);
    sender       = new CookieSender(cookieClient);
    log.info("Sender: CookieSender active (AppState cookies).", {
      userId: cookieClient.getUserId(),
    });
  } else if (config.facebook.pageAccessToken) {
    // ── Mode B: Graph API sender (legacy) ──────────────────────────────────
    const connection = new FacebookConnection();
    const client     = new FacebookClient(connection);
    sender           = new FacebookSender(client);
    connection.connect();
    log.info("Sender: FacebookSender active (Graph API / Page Access Token).");
  } else {
    log.error(
      "No sender available. Set either:" +
      "\n  • FB_APPSTATE (base64 cookie export) — recommended" +
      "\n  • FB_APPSTATE_FILE (path to appState JSON file)" +
      "\n  • FB_PAGE_ACCESS_TOKEN (Graph API fallback)"
    );
    process.exit(1);
  }

  setGroupSender(sender);
  log.info("GroupHandler wired with sender.");

  const normalizer = new FacebookEventNormalizer();
  const connection  = new FacebookConnection();
  const gateway    = new FacebookGateway(connection, sender, normalizer);
  connection.connect();
  // ─────────────────────────────────────────────────────────────────────────

  // ── User System ───────────────────────────────────────────────────────────
  const userRepo = new UserRepository();
  const userSvc  = new UserService(userRepo, cache.store("users"));
  gateway.getContextBuilder().setUserService(userSvc);
  setUserService(userSvc);
  log.info("UserService wired into ContextBuilder.");
  // ─────────────────────────────────────────────────────────────────────────

  const registry    = new CommandRegistry();
  const loader      = new CommandLoader(registry);
  const commandsDir = path.resolve(config.bot.commandsDir);

  await loader.load(commandsDir);
  loader.watch(commandsDir);

  // ── Middleware Pipeline ───────────────────────────────────────────────────
  const banStore = new BanStore();

  const mwManager = new MiddlewareManager()
    .register(createBannedMiddleware({ store: banStore, message: buildBanMessage }))
    .register(createLoggingMiddleware({ logEntry: true }))
    .register(createAntiSpamMiddleware({ maxMessages: 5, windowMs: 10_000 }))
    .register(createCooldownMiddleware({ durationMs: 3_000 }))
    .register(createPermissionsMiddleware({ adminIds: config.bot.adminIds }));

  log.info(`Middleware pipeline: [${mwManager.list().join(" → ")}] → typing → execute`);

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
  // ─────────────────────────────────────────────────────────────────────────

  // ── Plugin System + Core Services ────────────────────────────────────────
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

  // Provide cookie client if available (plugins can use it for advanced FB ops)
  if (cookieClient) {
    svcReg.provide("fb-cookie-client", cookieClient, "core");
    log.info("Core service registered: fb-cookie-client.");
  } else if (config.facebook.pageAccessToken) {
    // Legacy: expose page token for plugins that still reference it
    svcReg.provide("fb-access-token", config.facebook.pageAccessToken, "core");
    log.info("Core service registered: fb-access-token (Graph API mode).");
  }

  bot.register(pluginManager);
  // ─────────────────────────────────────────────────────────────────────────

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
