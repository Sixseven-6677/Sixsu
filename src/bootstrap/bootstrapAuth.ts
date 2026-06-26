/**
 * bootstrapAuth
 *
 * Registers Facebook accounts with AuthManager, wires the email/password
 * fallback provider, then runs AuthPipeline for each account.
 *
 * Multi-stage authentication order:
 *  Stage 1 — AppState   : cookies from env var / file.
 *  Stage 2 — Email+Pass : full fca-unofficial login → extracts fresh AppState.
 *                         Only attempted when Stage 1 fails AND FB_EMAIL +
 *                         FB_PASSWORD are configured in the environment.
 *
 * A structured auth report is emitted at INFO level after every pipeline run.
 * On total failure the bot starts but cannot send Facebook messages.
 *
 * Reconnect integration:
 *  EmailPasswordProvider is also registered as a fallback on AuthManager so
 *  that AuthManager.login() — called by ReconnectManager internally — will
 *  automatically try email/password when AppState fails during reconnects.
 *  No changes to ReconnectManager are needed.
 */
import { Bot }                   from "../core/Bot";
import { AuthManager }           from "../facebook/auth/AuthManager";
import { EmailPasswordProvider } from "../facebook/auth/EmailPasswordProvider";
import { AuthPipeline }          from "../facebook/auth/AuthPipeline";
import { SessionManager }        from "../facebook/session/SessionManager";
import { SessionStore }          from "../facebook/session/SessionStore";
import { ReconnectManager }      from "../facebook/reconnect/ReconnectManager";
import { config }                from "../config/env";
import { LoggerManager }         from "../logger/LoggerManager";

const log = LoggerManager.getLogger("Boot.Auth");

export interface AuthBootstrap {
  auth:           AuthManager;
  sessionManager: SessionManager;
  reconnect:      ReconnectManager;
  pipeline:       AuthPipeline;
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

  // ── Email/Password fallback provider ───────────────────────────────────────
  // Built once — reused by both the startup pipeline (AuthPipeline) and the
  // reconnect path (registered as a fallback on AuthManager so ReconnectManager
  // benefits automatically without any code changes to that layer).
  const emailPasswordProvider = EmailPasswordProvider.fromEnv();
  if (emailPasswordProvider) {
    log.info(
      "Auth: email/password fallback ENABLED " +
      "(FB_EMAIL + FB_PASSWORD are set). Stage 2 will activate on AppState failure."
    );
  } else {
    log.info(
      "Auth: email/password fallback DISABLED. " +
      "Set FB_EMAIL and FB_PASSWORD to enable automatic recovery when AppState expires."
    );
  }

  // ── Register AppState providers ────────────────────────────────────────────
  const appStateVal  = process.env[config.auth.appStateEnvKey] ?? process.env["FB_APPSTATE"];
  const appStateFile = config.auth.appStateFile;

  if (appStateFile) {
    auth.registerAccount("primary", AuthManager.fromFile("primary", appStateFile).provider);
    log.info("Auth: primary account registered from file.");
  } else if (appStateVal) {
    auth.registerAccount("primary", AuthManager.fromEnv("primary", config.auth.appStateEnvKey).provider);
    log.info("Auth: primary account registered from env.");
  } else {
    log.warn(
      "Auth: FB_APPSTATE not set. " +
      (emailPasswordProvider
        ? "Will attempt email/password login directly."
        : "Bot starts in health-only mode — cannot send Facebook messages.")
    );
  }

  // Register email/password as transparent fallback on the primary account.
  // AuthManager.login() will try it automatically if the AppState provider fails —
  // this transparently covers the ReconnectManager reconnect path.
  if (emailPasswordProvider) {
    auth.registerFallbackProvider("primary", emailPasswordProvider);
  }

  // ── Optional secondary account ─────────────────────────────────────────────
  const appStateVal2  = process.env[config.auth.appStateEnvKey2] ?? process.env["FB_APPSTATE_2"];
  const appStateFile2 = config.auth.appStateFile2;

  if (appStateFile2) {
    auth.registerAccount("secondary", AuthManager.fromFile("secondary", appStateFile2).provider);
    if (emailPasswordProvider) auth.registerFallbackProvider("secondary", emailPasswordProvider);
    log.info("Auth: secondary account registered from file.");
  } else if (appStateVal2) {
    auth.registerAccount("secondary", AuthManager.fromEnv("secondary", config.auth.appStateEnvKey2).provider);
    if (emailPasswordProvider) auth.registerFallbackProvider("secondary", emailPasswordProvider);
    log.info("Auth: secondary account registered from env.");
  }

  // ── Multi-stage auth pipeline (startup) ────────────────────────────────────
  const pipeline = new AuthPipeline({
    auth,
    session:       sessionManager,
    emailPassword: emailPasswordProvider,
  });

  for (const accountId of auth.getRegisteredAccounts()) {
    const result = await pipeline.run(accountId);

    // Always emit the full report — essential for startup audits
    log.info(AuthPipeline.formatReport(result));

    if (!result.success) {
      const advice = AuthPipeline.remediationAdvice(result);
      log.error(
        `Auth: account "${accountId}" failed all authentication stages.\n` +
        `  Remediation: ${advice}`
      );
    } else if (result.freshAppStateGenerated) {
      log.info(
        `Auth: account "${accountId}" recovered via email/password. ` +
        `Fresh AppState saved to session — bot will use it for all future reconnects.`
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

  return { auth, sessionManager, reconnect, pipeline };
}
