import { ISystem }          from "../../core/interfaces/ISystem";
import { FcaApi, FcaCookie, FcaEvent } from "./FcaTypes";
import { LoggerManager }   from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("MiraiTransport");

/* eslint-disable @typescript-eslint/no-var-requires */
const fcaLogin = require("fca-unofficial") as (
  options:  { appState: FcaCookie[] },
  callback: (err: Error | null, api: FcaApi | null) => void,
) => void;

export type FcaEventHandler = (event: FcaEvent) => void;

/** Facebook error codes that indicate an unrecoverable session problem. */
const FATAL_FB_ERRORS = new Set([
  1357004, // "Not logged in" — AppState expired or MQTT seq-id missing
  1357031, // Checkpoint / suspicious login
  1357045, // Account locked
]);

/**
 * MiraiTransport — Facebook transport layer for Sixsu.
 *
 * Uses fca-unofficial (proven in Fang / isoy-fca 1.3.10) as a Facebook
 * MQTT transport.
 *
 * autoReconnect: true → fca-unofficial handles transient MQTT drops
 * internally; our listen() callback fires only for real events or fatal
 * session errors (e.g. error 1357004 "Not logged in").
 *
 * On fatal error the transport stops retrying and logs a clear message
 * asking the operator to refresh the AppState.
 */
export class MiraiTransport implements ISystem {
  readonly name = "mirai-transport";

  private readonly appState: FcaCookie[];
  private api:              FcaApi | null       = null;
  private stopListenFn:     (() => void) | null  = null;
  private eventHandler:     FcaEventHandler | null = null;
  private running           = false;
  private reconnectTimer:   ReturnType<typeof setTimeout> | null = null;
  private loginAttempts     = 0;
  private listenerStartMs   = 0;

  private static readonly MAX_LOGIN_ATTEMPTS  = 5;
  private static readonly STABLE_LISTEN_MS    = 30_000;  // reset counter after 30 s of stable listening
  private static readonly BASE_LOGIN_DELAY_MS = 5_000;
  private static readonly MAX_LOGIN_DELAY_MS  = 120_000;

  private static readonly FCA_OPTIONS: Record<string, unknown> = {
    logLevel:          "silent",
    selfListen:        false,
    listenEvents:      true,
    updatePresence:    false,
    forceLogin:        false,
    autoMarkDelivered: true,
    autoMarkRead:      false,
    autoReconnect:     true,   // fca-unofficial handles transient MQTT reconnects
  };

  constructor(appState: FcaCookie[]) {
    this.appState = appState;
  }

  setEventHandler(handler: FcaEventHandler): void {
    this.eventHandler = handler;
  }

  getApi(): FcaApi | null         { return this.api; }
  getCurrentUserId(): string      { return this.api?.getCurrentUserID() ?? ""; }
  getAppState(): FcaCookie[]      { return this.api?.getAppState() ?? this.appState; }

  // ── ISystem ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.running = true;
    log.info("MiraiTransport: initializing…", { cookieCount: this.appState.length });
    await this.doLogin();
  }

  async destroy(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopListening();
    if (this.api) { try { this.api.logout(); } catch { /**/ } this.api = null; }
    log.info("MiraiTransport: destroyed.");
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private doLogin(): Promise<void> {
    return new Promise<void>((resolve) => {
      log.info("MiraiTransport: logging in via fca-unofficial…", {
        attempt: this.loginAttempts + 1,
      });

      fcaLogin({ appState: this.appState }, (err, api) => {
        if (err || !api) {
          const errMsg = err instanceof Error
            ? err.message
            : (err != null ? JSON.stringify(err) : "null API returned");

          log.warn("MiraiTransport: login failed.", { error: errMsg });
          resolve();
          this.scheduleReLogin("login-error");
          return;
        }

        this.api = api;
        api.setOptions(MiraiTransport.FCA_OPTIONS);

        log.info("MiraiTransport: logged in successfully.", {
          userId: api.getCurrentUserID(),
        });

        this.startListening();
        resolve();
      });
    });
  }

  private startListening(): void {
    if (!this.api) return;

    log.info("MiraiTransport: starting MQTT event listener…");
    this.listenerStartMs = Date.now();

    this.stopListenFn = this.api.listen((err, event) => {
      if (err) {
        const stableMs = Date.now() - this.listenerStartMs;

        // Parse the raw error — fca-unofficial may return a plain object
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

        // ── Fatal Facebook session errors — stop retrying ──────────────
        if (errCode !== undefined && FATAL_FB_ERRORS.has(errCode)) {
          log.warn(
            "MiraiTransport: FATAL session error — AppState is expired or invalid." +
            " Please refresh APPSTATE in Railway environment variables and redeploy.",
            { fbErrorCode: errCode, error: errMsg },
          );
          // Stop the transport — retrying is pointless until AppState is refreshed
          this.running = false;
          this.stopListening();
          this.api = null;
          return;
        }

        log.warn("MiraiTransport: listener error — scheduling re-login.", {
          error: errMsg, stableMs,
        });

        if (stableMs >= MiraiTransport.STABLE_LISTEN_MS) {
          this.loginAttempts = 0;
          log.info("MiraiTransport: listener was stable — resetting login counter.");
        }

        this.scheduleReLogin("listen-error");
        return;
      }

      if (!this.running || !event) return;

      // ── [DEBUG-1] Raw event from Facebook MQTT ──────────────────────────
      log.debug("MiraiTransport: raw event received.", { type: event.type });

      this.eventHandler?.(event);
    });

    log.info("MiraiTransport: listener active — waiting for messages.");
  }

  private stopListening(): void {
    if (this.stopListenFn) {
      try { this.stopListenFn(); } catch { /**/ }
      this.stopListenFn = null;
    }
  }

  private scheduleReLogin(reason: string): void {
    if (!this.running) return;

    this.loginAttempts++;

    if (this.loginAttempts > MiraiTransport.MAX_LOGIN_ATTEMPTS) {
      log.warn("MiraiTransport: max login attempts reached — giving up.", {
        loginAttempts: this.loginAttempts,
      });
      return;
    }

    const delay = Math.min(
      MiraiTransport.BASE_LOGIN_DELAY_MS * Math.pow(2, this.loginAttempts - 1),
      MiraiTransport.MAX_LOGIN_DELAY_MS,
    );

    log.info("MiraiTransport: scheduling re-login.", {
      reason, attempt: this.loginAttempts, maxAttempts: MiraiTransport.MAX_LOGIN_ATTEMPTS, delayMs: delay,
    });

    this.stopListening();
    this.api = null;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.doLogin().catch((e: unknown) => {
        log.error("MiraiTransport: re-login threw.", {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }, delay);
  }
}
