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

/**
 * MiraiTransport — Facebook transport layer for Sixsu.
 *
 * Key design decisions:
 *   • autoReconnect: true  → fca-unofficial handles MQTT-layer reconnects
 *     internally.  The listen() callback only fires for real events or
 *     fatal session-level errors (not transient MQTT hiccups).
 *   • loginAttempts counter only resets when the listener has been stable
 *     for 30 s, so we do not spin-loop on a broken session.
 *   • Exposes the live FcaApi to MiraiSender so both share the same session.
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
  private static readonly STABLE_LISTEN_MS    = 30_000;
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
    autoReconnect:     true,  // fca-unofficial handles MQTT reconnects internally
  };

  constructor(appState: FcaCookie[]) {
    this.appState = appState;
  }

  setEventHandler(handler: FcaEventHandler): void {
    this.eventHandler = handler;
  }

  getApi(): FcaApi | null {
    return this.api;
  }

  getCurrentUserId(): string {
    return this.api?.getCurrentUserID() ?? "";
  }

  getAppState(): FcaCookie[] {
    return this.api?.getAppState() ?? this.appState;
  }

  // ── ISystem ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.running = true;
    log.info("MiraiTransport: initializing…", { cookieCount: this.appState.length });
    await this.doLogin();
  }

  async destroy(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopListening();
    if (this.api) {
      try { this.api.logout(); } catch { /* ignore */ }
      this.api = null;
    }
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
          this.scheduleReLogin();
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
        const errMsg = err instanceof Error
          ? err.message
          : (typeof err === "object" && err !== null
              ? JSON.stringify(err)
              : String(err));

        log.warn("MiraiTransport: listener error (fatal session error).", {
          error:    errMsg,
          stableMs,
        });

        // If the listener was stable for 30+ seconds before failing,
        // this is a transient issue — reset the login counter so backoff
        // does not grow forever.
        if (stableMs >= MiraiTransport.STABLE_LISTEN_MS) {
          this.loginAttempts = 0;
          log.info("MiraiTransport: listener was stable — resetting login counter.");
        }

        // Schedule a full re-login (fca-unofficial's autoReconnect already
        // handled transient MQTT issues; reaching here means a session error).
        this.scheduleReLogin();
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
      try { this.stopListenFn(); } catch { /* ignore */ }
      this.stopListenFn = null;
    }
  }

  private scheduleReLogin(): void {
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
      attempt:     this.loginAttempts,
      maxAttempts: MiraiTransport.MAX_LOGIN_ATTEMPTS,
      delayMs:     delay,
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
