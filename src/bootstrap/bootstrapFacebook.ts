/**
 * bootstrapFacebook
 *
 * Boots each FCA account (primary + optional secondary), creates the per-account
 * MiraiConnectionManager (hybrid Sixsu+Goatbot session layer) + sender + gateway,
 * and wires the ReconnectManager health/restart hooks.
 * Returns the active transport list.
 *
 * Integration summary:
 *   MiraiTransport   — login + listenMqtt + exponential backoff (unchanged)
 *   MiraiConnectionManager — wraps MiraiTransport with Goatbot session patterns:
 *     • callbackListenTime dedup (generation counter)
 *     • storage5Message ring-buffer
 *     • restartListenMqtt (30-min proactive MQTT restart)
 *     • filterKeysAppState (6-key whitelist: c_user,xs,datr,fr,sb,i_user)
 *     • checkLiveCookie (10-min HTTP health check → checkpoint detection)
 */
import { Bot }                         from "../core/Bot";
import { config }                      from "../config/env";
import { AuthManager }                 from "../facebook/auth/AuthManager";
import { AuthCredentials }             from "../facebook/auth/types/IAuth";
import { FacebookConnection }          from "../facebook/FacebookConnection";
import { FacebookEventNormalizer }     from "../facebook/FacebookEventNormalizer";
import { FacebookGateway }             from "../facebook/FacebookGateway";
import { MiraiConnectionManager }      from "../facebook/mirai/MiraiConnectionManager";
import { MiraiSender }                 from "../facebook/mirai/MiraiSender";
import { HumanBehaviorSender }         from "../facebook/HumanBehaviorSender";
import { FcaEventAdapter }             from "../facebook/mirai/FcaEventAdapter";
import { ISender }                     from "../facebook/types/ISender";
import { AdminStore }                  from "../middleware/built-in/admin-store";
import { UserService }                 from "../users/UserService";
import { ReconnectManager }            from "../facebook/reconnect/ReconnectManager";
import { SessionManager }              from "../facebook/session/SessionManager";
import { FcaCookie }                   from "../facebook/mirai/FcaTypes";
import { handleMessage }               from "../handlers/message.handler";
import {
  setGroupSender, setGroupBotUserId, setGroupApiGetter,
  handleMemberJoined, handleMemberLeft,
  handleNameChanged,  handleNicknameChanged,
} from "../handlers/group.handler";
import { LoggerManager }               from "../logger/LoggerManager";

const log = LoggerManager.getLogger("Boot.Facebook");

export interface ActiveTransport {
  label:     string;
  transport: MiraiConnectionManager;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getUserIdFromAppState(appState: unknown): string {
  try {
    const cookies = appState as Array<{ key?: string; name?: string; value: string }>;
    return cookies.find((c) => (c.key ?? c.name) === "c_user")?.value ?? "";
  } catch {
    return "";
  }
}

// ── Per-account bootstrap ─────────────────────────────────────────────────────

interface AccountOpts {
  label:          string;
  credentials:    AuthCredentials;
  userSvc:        UserService;
  adminStore:     AdminStore;
  bot:            Bot;
  isPrimary:      boolean;
  startupDelayMs: number;
  auth:           AuthManager;
  sessionManager: SessionManager;
}

function bootFcaAccount(opts: AccountOpts): MiraiConnectionManager {
  const {
    label, credentials, userSvc, adminStore, bot,
    isPrimary, startupDelayMs, auth, sessionManager,
  } = opts;

  const botUserId  = getUserIdFromAppState(credentials.appState);
  const systemName = isPrimary ? "mirai-connection" : `mirai-connection-${label}`;

  // MiraiConnectionManager wraps MiraiTransport and adds Goatbot session patterns.
  // Cookie filtering (filterKeysAppState), dedup, proactive restart, and health
  // check are all handled internally — bootstrapFacebook stays clean.
  const transport = new MiraiConnectionManager(
    credentials.appState,
    systemName,
    { initDelayMs: startupDelayMs },
  );

  // MiraiSender now accepts { getApi(): FcaApi | null } — satisfied by MiraiConnectionManager.
  const sender: ISender = new HumanBehaviorSender(new MiraiSender(transport));

  log.info(`Account [${label}]: MiraiConnectionManager created.`, { botUserId, systemName, startupDelayMs });

  if (isPrimary) {
    setGroupSender(sender);
    setGroupBotUserId(botUserId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setGroupApiGetter(() => transport.getApi() as any);
  }

  const gateway = new FacebookGateway(
    new FacebookConnection(),
    sender,
    new FacebookEventNormalizer(),
    config.bot.ownerIds,
    adminStore,
    userSvc,
  );

  const adapter          = new FcaEventAdapter(botUserId);
  const accountSender    = sender;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountApiGetter = (): any => transport.getApi();

  // MiraiConnectionManager intercepts events first (dedup + generation check),
  // then forwards clean events here via setEventHandler.
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
          onMemberJoined:    (evt) => handleMemberJoined(evt, accountSender),
          onMemberLeft:      (evt) => handleMemberLeft(evt, accountSender),
          onNameChanged:     (evt) => handleNameChanged(evt, accountApiGetter),
          onNicknameChanged: (evt) => handleNicknameChanged(evt, accountApiGetter),
        },
      );
    }
  });

  // MiraiConnectionManager filters cookies internally (filterKeysAppState)
  // before calling this callback, so we receive clean essential-only cookies.
  transport.setOnAppStateRefresh((freshCookies: FcaCookie[]) => {
    auth.updateAppState(label, freshCookies);
    sessionManager.saveSession(label).catch((err: unknown) => {
      log.warn(`[${label}] Failed to persist refreshed AppState.`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  bot.register(transport);
  log.info(`Account [${label}]: registered with Bot.`, { botUserId });
  return transport;
}

// ── Reconnect hooks ───────────────────────────────────────────────────────────

function wireReconnectHooks(
  transports: ActiveTransport[],
  reconnect:  ReconnectManager,
  auth:       AuthManager,
): void {
  const map = new Map(transports.map(({ label, transport }) => [label, transport]));

  reconnect.setHealthCheck(async (id) => {
    const t = map.get(id);
    return t ? t.isConnected() : false;
  });

  reconnect.setRestartHook(async (id) => {
    const t = map.get(id);
    if (t) {
      const creds = auth.getCredentials(id);
      log.info(`ReconnectManager → restarting MiraiConnectionManager [${id}].`, {
        hasFreshCreds: (creds?.appState?.length ?? 0) > 0,
      });
      // restart() increments generation + rewires handler + filters cookies
      await t.restart(creds?.appState);
    }
  });

  for (const { label, transport: t } of transports) {
    // MiraiConnectionManager fires onPermanentFailure for:
    //   • appstate-expired (from MiraiTransport)
    //   • checkpoint-detected (from HTTP health check)
    //   • cookie-health-check-failed (from HTTP health check)
    t.setOnPermanentFailure((reason) => {
      log.error(
        `Transport [${label}]: permanent failure — ${reason}. ` +
        `Triggering ReconnectManager. [permanent-failure]`,
        { label, reason, stats: t.getStats() },
      );
      reconnect.reconnect(label).catch((err: unknown) => {
        log.error(`Forced reconnect threw for [${label}].`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────

export function bootstrapFacebook(
  auth:           AuthManager,
  userSvc:        UserService,
  adminStore:     AdminStore,
  bot:            Bot,
  reconnect:      ReconnectManager,
  sessionManager: SessionManager,
): ActiveTransport[] {
  const transports: ActiveTransport[] = [];

  const primaryCreds   = auth.getCredentials("primary");
  const secondaryCreds = auth.getCredentials("secondary");

  if (primaryCreds) {
    const t = bootFcaAccount({
      label: "primary", credentials: primaryCreds,
      userSvc, adminStore, bot, isPrimary: true, startupDelayMs: 0,
      auth, sessionManager,
    });
    transports.push({ label: "primary", transport: t });
  }

  if (secondaryCreds) {
    const t = bootFcaAccount({
      label: "secondary", credentials: secondaryCreds,
      userSvc, adminStore, bot, isPrimary: false,
      startupDelayMs: 5_000,
      auth, sessionManager,
    });
    transports.push({ label: "secondary", transport: t });
    log.info("Two accounts active — primary + secondary.");
  }

  if (transports.length === 0) {
    log.warn("No FB_APPSTATE set — health-only mode. Bot cannot send messages.");
    const noOp: ISender = {
      sendText:     async () => { log.warn("NoOpSender: no FB_APPSTATE configured."); },
      sendTyping:   async () => {},
      sendReaction: async () => {},
    };
    setGroupSender(new HumanBehaviorSender(noOp));
  }

  if (transports.length > 0) {
    wireReconnectHooks(transports, reconnect, auth);
  }

  return transports;
}
