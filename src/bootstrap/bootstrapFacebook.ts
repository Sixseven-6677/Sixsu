/**
 * bootstrapFacebook
 *
 * Boots each FCA account (primary + optional secondary), creates the per-account
 * transport + sender + gateway, and wires the ReconnectManager health/restart
 * hooks. Returns the active transport list.
 */
import { Bot }                      from "../core/Bot";
import { config }                   from "../config/env";
import { AuthManager }              from "../facebook/auth/AuthManager";
import { AuthCredentials }          from "../facebook/auth/types/IAuth";
import { FacebookConnection }       from "../facebook/FacebookConnection";
import { FacebookEventNormalizer }  from "../facebook/FacebookEventNormalizer";
import { FacebookGateway }          from "../facebook/FacebookGateway";
import { MiraiTransport }           from "../facebook/mirai/MiraiTransport";
import { MiraiSender }              from "../facebook/mirai/MiraiSender";
import { HumanBehaviorSender }      from "../facebook/HumanBehaviorSender";
import { FcaEventAdapter }          from "../facebook/mirai/FcaEventAdapter";
import { ISender }                  from "../facebook/types/ISender";
import { AdminStore }               from "../middleware/built-in/admin-store";
import { UserService }              from "../users/UserService";
import { ReconnectManager }         from "../facebook/reconnect/ReconnectManager";
import { handleMessage }            from "../handlers/message.handler";
import {
  setGroupSender, setGroupBotUserId, setGroupApiGetter,
  handleMemberJoined, handleMemberLeft,
  handleNameChanged,  handleNicknameChanged,
} from "../handlers/group.handler";
import { LoggerManager }            from "../logger/LoggerManager";

const log = LoggerManager.getLogger("Boot.Facebook");

export interface ActiveTransport {
  label:     string;
  transport: MiraiTransport;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extracts the Facebook user ID from an FCA app-state cookie array.
 * The `c_user` cookie holds the numeric Facebook user ID.
 */
function getUserIdFromAppState(appState: unknown): string {
  try {
    const cookies = appState as Array<{ name: string; value: string }>;
    return cookies.find((c) => c.name === "c_user")?.value ?? "";
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
}

function bootFcaAccount(opts: AccountOpts): MiraiTransport {
  const { label, credentials, userSvc, adminStore, bot, isPrimary, startupDelayMs } = opts;

  const botUserId  = getUserIdFromAppState(credentials.appState);
  const systemName = isPrimary ? "mirai-transport" : `mirai-transport-${label}`;

  const transport       = new MiraiTransport(credentials.appState, systemName, startupDelayMs);
  const sender: ISender = new HumanBehaviorSender(new MiraiSender(transport));

  log.info(`Account [${label}]: transport created.`, { botUserId, systemName, startupDelayMs });

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
  // Note: FacebookConnection.connect() is intentionally NOT called for FCA-based
  // transports. MiraiTransport manages its own MQTT lifecycle. The connection
  // object is only needed by FacebookGateway for webhook verification logic.

  const adapter          = new FcaEventAdapter(botUserId);
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
          onMemberJoined:    (evt) => handleMemberJoined(evt, accountSender),
          onMemberLeft:      (evt) => handleMemberLeft(evt, accountSender),
          onNameChanged:     (evt) => handleNameChanged(evt, accountApiGetter),
          onNicknameChanged: (evt) => handleNicknameChanged(evt, accountApiGetter),
        },
      );
    }
  });

  bot.register(transport);
  log.info(`Account [${label}]: registered.`, { botUserId });
  return transport;
}

// ── Reconnect hooks ───────────────────────────────────────────────────────────

function wireReconnectHooks(
  transports: ActiveTransport[],
  reconnect:  ReconnectManager,
): void {
  const map = new Map(transports.map(({ label, transport }) => [label, transport]));

  reconnect.setHealthCheck(async (id) => {
    const t = map.get(id);
    // Healthy = transport is running (self-recovery counts as healthy).
    // Unhealthy = transport permanently stopped (needs credential refresh).
    return t ? t.isConnected() : false;
  });

  reconnect.setRestartHook(async (id) => {
    const t = map.get(id);
    if (t) {
      log.info(`ReconnectManager → restarting transport [${id}].`);
      await t.restart();
    }
  });

  for (const { label, transport: t } of transports) {
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
  auth:       AuthManager,
  userSvc:    UserService,
  adminStore: AdminStore,
  bot:        Bot,
  reconnect:  ReconnectManager,
): ActiveTransport[] {
  const transports: ActiveTransport[] = [];

  const primaryCreds   = auth.getCredentials("primary");
  const secondaryCreds = auth.getCredentials("secondary");

  if (primaryCreds) {
    const t = bootFcaAccount({
      label: "primary", credentials: primaryCreds,
      userSvc, adminStore, bot, isPrimary: true, startupDelayMs: 0,
    });
    transports.push({ label: "primary", transport: t });
  }

  if (secondaryCreds) {
    const t = bootFcaAccount({
      label: "secondary", credentials: secondaryCreds,
      userSvc, adminStore, bot, isPrimary: false,
      // 5-second stagger: prevents FB rate-limits when two accounts log in
      // from the same IP in quick succession.
      startupDelayMs: 5_000,
    });
    transports.push({ label: "secondary", transport: t });
    log.info("✅ Two accounts active — running on primary + secondary.");
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
    wireReconnectHooks(transports, reconnect);
  }

  return transports;
}
