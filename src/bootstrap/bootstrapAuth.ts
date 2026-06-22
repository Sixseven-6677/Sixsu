/**
 * bootstrapAuth
 *
 * Registers Facebook accounts with AuthManager, creates SessionManager and
 * ReconnectManager, and wires them to the Bot lifecycle.
 *
 * Load order:
 *  1. SessionManager infrastructure is created first.
 *  2. Providers (env / file) are registered with AuthManager.
 *  3. auth.loginAll() loads fresh credentials from env/file.
 *  4. Sessions are persisted for every account that authenticated successfully.
 *
 * This ensures:
 *  - Fresh cookies obtained from fca-unofficial are saved after each login.
 *  - On the next restart, the session store holds the newest cookies.
 *  - Env/file credentials always take priority over stale session data.
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

  // ── Session infrastructure ─────────────────────────────────────────────────
  const sessionSecret = config.auth.sessionSecret;
  if (!sessionSecret) {
    log.warn(
      "Auth: SESSION_SECRET / FB_SESSION_SECRET is not set. " +
      "Sessions will be encrypted with an empty key — set a secret in production."
    );
  }

  const sessionStore   = new SessionStore(config.auth.sessionFile, sessionSecret || "");
  const sessionManager = new SessionManager({
    store: sessionStore,
    auth,
    ttlMs: config.auth.sessionTtlDays * 24 * 60 * 60 * 1000,
  });

  // ── Register providers ─────────────────────────────────────────────────────
  const appStateVal  = process.env[config.auth.appStateEnvKey] ?? process.env["FB_APPSTATE"];
  const appStateFile = config.auth.appStateFile;

  if (appStateFile) {
    auth.registerAccount("primary", AuthManager.fromFile("primary", appStateFile).provider);
    log.info("Auth: primary account registered from file.");
  } else if (appStateVal) {
    auth.registerAccount("primary", AuthManager.fromEnv("primary", config.auth.appStateEnvKey).provider);
    log.info("Auth: primary account registered from env.");
  } else {
    log.warn("Auth: FB_APPSTATE not set — health-only mode. Bot cannot send messages.");
  }

  const appStateVal2  = process.env[config.auth.appStateEnvKey2] ?? process.env["FB_APPSTATE_2"];
  const appStateFile2 = config.auth.appStateFile2;

  if (appStateFile2) {
    auth.registerAccount("secondary", AuthManager.fromFile("secondary", appStateFile2).provider);
    log.info("Auth: secondary account registered from file.");
  } else if (appStateVal2) {
    auth.registerAccount("secondary", AuthManager.fromEnv("secondary", config.auth.appStateEnvKey2).provider);
    log.info("Auth: secondary account registered from env.");
  }

  // ── Load credentials ───────────────────────────────────────────────────────
  const loginResults = await auth.loginAll();

  for (const [id, result] of loginResults) {
    if (result.success) {
      log.info(`Auth: account "${id}" authenticated. Persisting session...`);
      try {
        await sessionManager.saveSession(id);
      } catch (err) {
        log.warn(`Auth: failed to save session for "${id}".`, err);
      }
    } else {
      log.error(
        `Auth: account "${id}" failed to authenticate: ${result.error ?? result.status}`
      );
    }
  }

  bot.register(auth);
  bot.register(sessionManager);

  // ── Reconnect manager ──────────────────────────────────────────────────────
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
