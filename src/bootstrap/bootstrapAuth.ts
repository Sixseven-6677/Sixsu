/**
 * bootstrapAuth
 *
 * Registers Facebook accounts with AuthManager, creates SessionManager and
 * ReconnectManager, and wires them to the Bot lifecycle.
 */
import { Bot }              from "../core/Bot";
import { AuthManager }      from "../facebook/auth/AuthManager";
import { SessionManager }   from "../facebook/session/SessionManager";
import { SessionStore }     from "../facebook/session/SessionStore";
import { ReconnectManager } from "../facebook/reconnect/ReconnectManager";
import { config }           from "../config/env";
import { LoggerManager }    from "../logger/LoggerManager";

const log = LoggerManager.getLogger("Boot.Auth");

export interface AuthBootstrap {
  auth:           AuthManager;
  sessionManager: SessionManager;
  reconnect:      ReconnectManager;
}

export async function bootstrapAuth(bot: Bot): Promise<AuthBootstrap> {
  const auth = new AuthManager();

  // Primary account
  const appStateVal  = process.env[config.auth.appStateEnvKey] ?? process.env["FB_APPSTATE"];
  const appStateFile = config.auth.appStateFile;
  if (appStateFile) {
    auth.registerAccount("primary", AuthManager.fromFile("primary", appStateFile).provider);
  } else if (appStateVal) {
    auth.registerAccount("primary", AuthManager.fromEnv("primary", config.auth.appStateEnvKey).provider);
  } else {
    log.warn("Auth: FB_APPSTATE not set — health-only mode.");
  }

  // Secondary account
  const appStateVal2  = process.env[config.auth.appStateEnvKey2] ?? process.env["FB_APPSTATE_2"];
  const appStateFile2 = config.auth.appStateFile2;
  if (appStateFile2) {
    auth.registerAccount("secondary", AuthManager.fromFile("secondary", appStateFile2).provider);
    log.info("Auth: secondary account registered from file.");
  } else if (appStateVal2) {
    auth.registerAccount("secondary", AuthManager.fromEnv("secondary", config.auth.appStateEnvKey2).provider);
    log.info("Auth: secondary account registered from env.");
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
    // 5-minute interval: gives MiraiTransport's self-recovery loop time to
    // recover before ReconnectManager escalates to a full credential refresh.
    healthCheckIntervalMs: 300_000,
    spamWindowMs:          120_000,
    maxAttemptsPerWindow:  2,
  });
  bot.register(reconnect);

  return { auth, sessionManager, reconnect };
}
