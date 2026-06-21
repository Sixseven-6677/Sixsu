import { ISystem }          from "../../core/interfaces/ISystem";
import { FcaApi, FcaCookie, FcaEvent } from "./FcaTypes";
import { LoggerManager }   from "../../logger/LoggerManager";
import { diagnosticMonitor } from "../../diagnostic/DiagnosticMonitor";

const log = LoggerManager.getLogger("MiraiTransport");

/* eslint-disable @typescript-eslint/no-var-requires */
const fcaLogin = require("@dongdev/fca-unofficial") as (
  options:  { appState: FcaCookie[]; pageID?: string },
  callback: (err: Error | null, api: FcaApi | null) => void,
) => void;

export type FcaEventHandler = (event: FcaEvent) => void;

const FATAL_FB_ERRORS = new Set([
  1357004,
  1357031,
  1357045,
]);

const SESSION_EXPIRED_HINTS = [
  "fb_appstate expired",
  "appstate expired",
  "appstate die",
  "c_user/i_user cookie not found",
  "không tìm thấy cookie",
] as const;

function isSessionExpiredError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return SESSION_EXPIRED_HINTS.some(hint => lower.includes(hint.toLowerCase()));
}

// ─── Diagnostic API interceptor ───────────────────────────────────────────────

/**
 * Wraps an FcaApi object so every method call is counted by DiagnosticMonitor.
 * Uses string[] (not keyof FcaApi) so we can also track runtime methods that
 * exist on the fca-unofficial object but aren't in our minimal FcaApi type.
 * Zero behaviour change — purely additive instrumentation.
 */
function wrapApiForDiagnostics(api: FcaApi, accountId: string): FcaApi {
  // All methods we want to count. String array to avoid TS constraint on keyof FcaApi
  // since fca-unofficial exposes more methods at runtime than our stub interface.
  const TRACKED: string[] = [
    "sendMessage", "sendTypingIndicator", "setMessageReaction", "getAppState",
    "listen", "logout",
    // Runtime methods not in the stub interface but called by plugins:
    "getThreadList", "getThreadInfo", "setTitle",
    "removeUserFromGroup", "changeAdminStatus", "handleMessageRequest",
    "markAsRead", "markAsDelivered",
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped: any = Object.create(api as any);

  for (const method of TRACKED) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orig = (api as any)[method];
    if (typeof orig === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wrapped[method] = (...args: any[]) => {
        diagnosticMonitor.recordApiCall(method, accountId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (orig as any).apply(api, args);
      };
    }
  }

  return wrapped as FcaApi;
}

// ─────────────────────────────────────────────────────────────────────────────

export class MiraiTransport implements ISystem {
  /** Unique system name — configurable so multiple instances can coexist in Bot. */
  readonly name: string;

  private readonly appState:    FcaCookie[];
  private readonly initDelayMs: number;
  private api:                  FcaApi | null        = null;
  private stopListenFn:         (() => void) | null   = null;
  private eventHandler:         FcaEventHandler | null = null;
  private rawListeners:         FcaEventHandler[]     = [];
  private running               = false;
  /** Fresh AppState saved after every successful login — used on reconnect to avoid stale cookies. */
  private currentAppState:      FcaCookie[]              = [];
  private reconnectTimer:       ReturnType<typeof setTimeout> | null = null;
  private loginAttempts         = 0;
  private listenerStartMs       = 0;
  private lastConnectedAt:      number | null = null;
  private lastDisconnectedAt:   number | null = null;
  private totalReconnects       = 0;

  /** Callback invoked when the transport permanently gives up (AppState expired or max retries). */
  private onPermanentFailure:   ((reason: string) => void) | null = null;

  private static readonly MAX_LOGIN_ATTEMPTS  = 5;
  /**
   * Max times a FATAL Facebook error triggers a retry before we stop permanently.
   * Transient 1357031 errors can be caused by a secondary account logging in from
   * the same IP — allow a couple of retries before treating it as genuine expiry.
   */
  private static readonly MAX_FATAL_RETRIES   = 2;
  private static readonly STABLE_LISTEN_MS    = 30_000;
  private static readonly BASE_LOGIN_DELAY_MS = 5_000;
  private static readonly MAX_LOGIN_DELAY_MS  = 120_000;

  // autoReconnect:false — we own all reconnection logic via scheduleReLogin;
  // avoids a double-reconnect race where fca-unofficial and our code both try
  // to reconnect at the same time after an MQTT drop.
  private static readonly FCA_OPTIONS: Record<string, unknown> = {
    logLevel:          "silent",
    selfListen:        false,
    listenEvents:      true,
    updatePresence:    false,
    forceLogin:        false,
    autoMarkDelivered: true,
    autoMarkRead:      false,
    autoReconnect:     false,
  };

  /**
   * @param appState      Facebook session cookies.
   * @param systemName    Unique ISystem name. Use "mirai-transport-secondary" for
   *                      account #2 so Bot.register() does not throw on duplicate names.
   * @param initDelayMs   Milliseconds to wait before the first login attempt.
   *                      Set ≥5000 for secondary accounts to stagger Facebook logins
   *                      and avoid triggering rate-limits or MQTT interference.
   */
  constructor(appState: FcaCookie[], systemName = "mirai-transport", initDelayMs = 0) {
    this.appState    = appState;
    this.name        = systemName;
    this.initDelayMs = initDelayMs;
  }

  // ── Public accessors ─────────────────────────────────────────────────────

  setEventHandler(handler: FcaEventHandler): void { this.eventHandler = handler; }

  addRawEventListener(fn: FcaEventHandler): void {
    if (!this.rawListeners.includes(fn)) this.rawListeners.push(fn);
  }

  removeRawEventListener(fn: FcaEventHandler): void {
    this.rawListeners = this.rawListeners.filter(l => l !== fn);
  }

  /** Called when transport gives up permanently — lets outer code trigger a hard restart. */
  setOnPermanentFailure(fn: (reason: string) => void): void {
    this.onPermanentFailure = fn;
  }

  getApi():          FcaApi | null { return this.api; }
  getCurrentUserId(): string       { return this.api?.getCurrentUserID() ?? ""; }
  getAppState():     FcaCookie[]   { return this.api?.getAppState() ?? this.appState; }

  /** True when the fca-unofficial API object is active (MQTT listener running). */
  isConnected(): boolean { return this.api !== null; }

  /** True while this transport is allowed to (re)connect. */
  isRunning(): boolean { return this.running; }

  /** Diagnostic snapshot: connection uptime, reconnect count, etc. */
  getStats(): {
    connected:          boolean;
    running:            boolean;
    loginAttempts:      number;
    totalReconnects:    number;
    lastConnectedAt:    Date | null;
    lastDisconnectedAt: Date | null;
  } {
    return {
      connected:          this.isConnected(),
      running:            this.running,
      loginAttempts:      this.loginAttempts,
      totalReconnects:    this.totalReconnects,
      lastConnectedAt:    this.lastConnectedAt !== null ? new Date(this.lastConnectedAt) : null,
      lastDisconnectedAt: this.lastDisconnectedAt !== null ? new Date(this.lastDisconnectedAt) : null,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initDelayMs > 0) {
      log.info(
        `MiraiTransport [${this.name}]: staggering login by ${this.initDelayMs}ms ` +
        `to avoid Facebook rate-limiting / MQTT interference between accounts.`,
      );
      await new Promise<void>(r => setTimeout(r, this.initDelayMs));
    }
    this.running = true;
    log.info(`MiraiTransport [${this.name}]: initializing…`, { cookieCount: this.appState.length });
    await this.doLogin();
  }

  async destroy(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopListening();
    if (this.api) { try { this.api.logout(); } catch { /**/ } this.api = null; }
    this.rawListeners = [];
    log.info(`MiraiTransport [${this.name}]: destroyed.`);
  }

  /**
   * External restart — resets all retry counters and forces a fresh login attempt.
   * Called by ReconnectManager after it successfully refreshes credentials, bridging
   * the gap between "credentials valid" and "MQTT actually reconnected".
   *
   * Also used by the self-healing watchdog to recover from zombie state
   * (loginAttempts exceeded MAX without setting running=false).
   */
  async restart(): Promise<void> {
    log.info(
      `MiraiTransport [${this.name}]: external restart requested — ` +
      `resetting retry counters. [self-healing]`,
      { prevAttempts: this.loginAttempts, totalReconnects: this.totalReconnects },
    );
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopListening();
    this.api             = null;
    this.currentAppState = [];   // reset: prevents poisoned cookies persisting through restart
    this.loginAttempts   = 0;
    this.running         = true;
    await this.doLogin();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private getUserIdFromAppState(): string {
    const cookie = this.appState.find(c => c.key === "c_user");
    return cookie?.value ? String(cookie.value) : "";
  }

  private doLogin(): Promise<void> {
    return new Promise<void>((resolve) => {
      const earlyPageId = this.getUserIdFromAppState();

      log.info(`MiraiTransport [${this.name}]: logging in…`, {
        attempt:     this.loginAttempts + 1,
        earlyPageId: earlyPageId || "(not found)",
      });

      let resolved = false;

      const loginOptions: { appState: FcaCookie[]; pageID?: string } = {
        appState: this.currentAppState.length > 0 ? this.currentAppState : this.appState,
        ...(earlyPageId ? { pageID: earlyPageId } : {}),
      };

      fcaLogin(loginOptions, (err, api) => {
        if (resolved) return;

        if (err || !api) {
          const errMsg = err instanceof Error
            ? err.message
            : (err != null ? JSON.stringify(err) : "null API returned");

          if (isSessionExpiredError(errMsg)) {
            log.error(
              `MiraiTransport [${this.name}]: AppState expired — stopping retries. [permanent-failure]`,
              { error: errMsg },
            );
            // ── DIAG ─────────────────────────────────────────────────────
            diagnosticMonitor.recordAppStateInvalid(this.name, errMsg);
            // ─────────────────────────────────────────────────────────────
            this.running = false;
            this.lastDisconnectedAt = Date.now();
            resolved = true;
            resolve();
            this.onPermanentFailure?.("appstate-expired");
            return;
          }

          // ── DIAG ─────────────────────────────────────────────────────
          diagnosticMonitor.recordLogin(this.name, false, {
            error:   errMsg,
            attempt: this.loginAttempts + 1,
          });
          // ─────────────────────────────────────────────────────────────
          log.warn(`MiraiTransport [${this.name}]: login failed.`, { error: errMsg });
          resolved = true;
          resolve();
          this.scheduleReLogin("login-error");
          return;
        }

        // ── DIAG: Wrap API for call counting (zero behaviour change) ──────
        const wrappedApi = wrapApiForDiagnostics(api, this.name);
        this.api = wrappedApi;
        // ──────────────────────────────────────────────────────────────────

        wrappedApi.setOptions({ ...MiraiTransport.FCA_OPTIONS, pageID: api.getCurrentUserID() });

        this.lastConnectedAt = Date.now();
        this.totalReconnects++;

        // ── DIAG: Login success + AppState drift check ────────────────────
        const freshCookies  = api.getAppState();
        diagnosticMonitor.recordLogin(this.name, true, {
          userId:      api.getCurrentUserID(),
          cookieCount: this.appState.length,
          attempt:     this.loginAttempts + 1,
        });
        diagnosticMonitor.recordAppStateCheck(this.name, this.appState.length, freshCookies.length);
        // Save fresh cookies for next reconnect — avoids stale-AppState loops
        if (freshCookies.length > 0) {
          this.currentAppState = freshCookies;
          log.info(`MiraiTransport [${this.name}]: AppState refreshed (${freshCookies.length} cookies saved).`);
        }
        // ──────────────────────────────────────────────────────────────────

        log.info(`MiraiTransport [${this.name}]: logged in. [listener-start]`, {
          userId:          api.getCurrentUserID(),
          totalReconnects: this.totalReconnects,
          uptime:          process.uptime(),
        });

        resolved = true;
        this.startListening();
        resolve();
      });
    });
  }

  private startListening(): void {
    if (!this.api) return;

    log.info(`MiraiTransport [${this.name}]: starting MQTT listener…`);
    this.listenerStartMs = Date.now();

    // ── DIAG: MQTT connect ────────────────────────────────────────────────
    diagnosticMonitor.recordMqttConnect(this.name);
    // ─────────────────────────────────────────────────────────────────────

    this.stopListenFn = this.api.listen((err, event) => {
      if (err) {
        const stableMs = Date.now() - this.listenerStartMs;
        let errCode: number | undefined;
        let errMsg: string;

        if (err instanceof Error) {
          errMsg = err.message;
        } else if (typeof err === "object" && err !== null) {
          const e = err as Record<string, unknown>;
          errCode = typeof e["error"] === "number" ? e["error"] : undefined;
          errMsg  = JSON.stringify(err);
        } else {
          errMsg = String(err);
        }

        this.lastDisconnectedAt = Date.now();

        // ── DIAG: MQTT disconnect ─────────────────────────────────────────
        diagnosticMonitor.recordMqttDisconnect(this.name, { errorCode: errCode, errorMsg: errMsg, stableMs });
        // ─────────────────────────────────────────────────────────────────

        if (errCode !== undefined && FATAL_FB_ERRORS.has(errCode)) {
          // FATAL Facebook error on the MQTT stream (e.g. 1357031 = session interrupted).
          //
          // KEY INSIGHT: these can be TRANSIENT — when a second account logs in from the
          // same Railway IP, Facebook's MQTT broker can send a 1357031 to the first
          // account's existing connection as a side-effect of the new login.
          //
          // Strategy: allow MAX_FATAL_RETRIES retries before treating it as a genuine
          // AppState expiry that requires manual credential rotation.
          this.stopListening();
          this.api = null;

          if (this.loginAttempts < MiraiTransport.MAX_FATAL_RETRIES) {
            log.warn(
              `MiraiTransport [${this.name}]: FATAL fb error ${errCode} — ` +
              `scheduling retry (${this.loginAttempts + 1}/${MiraiTransport.MAX_FATAL_RETRIES}). ` +
              `This may be a transient error caused by multi-account login. [listener-stop]`,
              { fbErrorCode: errCode },
            );
            this.scheduleReLogin("fatal-fb-error");
          } else {
            log.error(
              `MiraiTransport [${this.name}]: FATAL fb error ${errCode} persists after ` +
              `${this.loginAttempts} retries — AppState is likely expired. Stopping. [permanent-failure]`,
              { fbErrorCode: errCode },
            );
            this.running = false;
            this.onPermanentFailure?.(`fatal-fb-error-${errCode}`);
          }
          return;
        }

        log.warn(
          `MiraiTransport [${this.name}]: listener error — scheduling re-login. [listener-stop]`,
          { error: errMsg, stableMs },
        );

        if (stableMs >= MiraiTransport.STABLE_LISTEN_MS) {
          this.loginAttempts = 0;
        }
        this.scheduleReLogin("listen-error");
        return;
      }

      if (!this.running || !event) return;

      // ── DIAG: Count incoming messages (= autoMarkDelivered API calls) ───
      if ((event as Record<string, unknown>).type === "message") {
        diagnosticMonitor.recordApiCall("incomingMessage", this.name); // autoMarkDelivered is OFF — no API call made
      }
      // ─────────────────────────────────────────────────────────────────────

      log.debug(`MiraiTransport [${this.name}]: raw event received.`, { type: event.type });

      try {
        this.eventHandler?.(event);
      } catch (handlerErr: unknown) {
        log.error(`MiraiTransport [${this.name}]: event handler threw.`, {
          eventType: (event as Record<string, unknown>).type,
          error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
        });
      }

      for (const listener of this.rawListeners) {
        try { listener(event); } catch (listenerErr: unknown) {
          log.warn(`MiraiTransport [${this.name}]: raw listener threw.`, {
            error: listenerErr instanceof Error ? listenerErr.message : String(listenerErr),
          });
        }
      }
    });

    log.info(`MiraiTransport [${this.name}]: listener active. [listener-active]`);
  }

  private stopListening(): void {
    if (this.stopListenFn) {
      try { this.stopListenFn(); } catch { /**/ }
      this.stopListenFn = null;
      log.info(`MiraiTransport [${this.name}]: listener stopped. [listener-stopped]`);
    }
  }

  private scheduleReLogin(reason: string): void {
    if (!this.running) return;

    this.loginAttempts++;

    // ── DIAG: Reconnect attempt ───────────────────────────────────────────
    diagnosticMonitor.recordReconnect(this.name, reason, this.loginAttempts);
    // ─────────────────────────────────────────────────────────────────────

    if (this.loginAttempts > MiraiTransport.MAX_LOGIN_ATTEMPTS) {
      // ── Self-healing: signal permanent failure instead of silently zombifying ──
      // Previously we just returned here, leaving the transport in a zombie state:
      // running=true but api=null and no reconnect scheduled.
      // Now we set running=false and invoke the permanent failure callback so
      // ReconnectManager can trigger a clean restart via restartHook.
      log.warn(
        `MiraiTransport [${this.name}]: max login attempts ` +
        `(${MiraiTransport.MAX_LOGIN_ATTEMPTS}) reached — signalling failure. [permanent-failure]`,
        { reason },
      );
      this.running = false;
      this.onPermanentFailure?.("max-login-attempts");
      return;
    }

    const delay = Math.min(
      MiraiTransport.BASE_LOGIN_DELAY_MS * Math.pow(2, this.loginAttempts - 1),
      MiraiTransport.MAX_LOGIN_DELAY_MS,
    );

    log.info(`MiraiTransport [${this.name}]: re-login in ${delay}ms.`, { reason, attempt: this.loginAttempts });

    this.stopListening();
    this.api = null;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.doLogin().catch((e: unknown) => {
        log.error(`MiraiTransport [${this.name}]: re-login threw.`, {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }, delay);
  }
}
