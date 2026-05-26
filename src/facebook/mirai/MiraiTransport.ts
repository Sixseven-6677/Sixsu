import { ISystem }          from "../../core/interfaces/ISystem";
import { FcaApi, FcaCookie, FcaEvent } from "./FcaTypes";
import { LoggerManager }   from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("MiraiTransport");

/* eslint-disable @typescript-eslint/no-var-requires */
const fcaLogin = require("fca-unofficial") as (
  options:  { appState: FcaCookie[] },
  callback: (err: Error | null, api: FcaApi | null) => void,
) => void;

/** Callback invoked for every raw FCA event. */
export type FcaEventHandler = (event: FcaEvent) => void;

/**
 * MiraiTransport — Facebook transport layer for Sixsu.
 *
 * Uses fca-unofficial (the same library proven in Fang) to provide:
 *   • AppState-based login (no Page Token or Developer App required)
 *   • MQTT real-time event listener
 *   • Exponential-backoff auto-reconnect on listen errors
 *   • Live FcaApi exposure so MiraiSender can share the same session
 *
 * Implements ISystem so it participates in the Bot lifecycle:
 *   initialize() → login → listen
 *   destroy()    → stop listening → logout
 */
export class MiraiTransport implements ISystem {
  readonly name = "mirai-transport";

  private readonly appState: FcaCookie[];
  private api:              FcaApi | null      = null;
  private stopListenFn:     (() => void) | null = null;
  private eventHandler:     FcaEventHandler | null = null;
  private running           = false;
  private reconnectTimer:   ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  private static readonly MAX_RECONNECT  = 10;
  private static readonly BASE_DELAY_MS  = 3_000;
  private static readonly MAX_DELAY_MS   = 120_000;

  private static readonly FCA_OPTIONS: Record<string, unknown> = {
    logLevel:          "silent",
    selfListen:        false,
    listenEvents:      true,
    updatePresence:    false,
    forceLogin:        false,
    autoMarkDelivered: true,
    autoMarkRead:      false,
    autoReconnect:     false,   // We handle reconnect ourselves
  };

  constructor(appState: FcaCookie[]) {
    this.appState = appState;
  }

  /** Register the handler that receives every raw FCA event. */
  setEventHandler(handler: FcaEventHandler): void {
    this.eventHandler = handler;
  }

  /** Returns the live FcaApi, or null if not yet logged in / disconnected. */
  getApi(): FcaApi | null {
    return this.api;
  }

  /** Returns the current bot user ID (empty string before first login). */
  getCurrentUserId(): string {
    return this.api?.getCurrentUserID() ?? "";
  }

  /** Returns the latest AppState (updated by fca-unofficial after login). */
  getAppState(): FcaCookie[] {
    return this.api?.getAppState() ?? this.appState;
  }

  // ── ISystem ──────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.running = true;
    log.info("MiraiTransport: initializing…", { cookieCount: this.appState.length });
    await this.login();
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

  private login(): Promise<void> {
    return new Promise<void>((resolve) => {
      log.info("MiraiTransport: logging in via fca-unofficial…");

      fcaLogin({ appState: this.appState }, (err, api) => {
        if (err || !api) {
          log.warn("MiraiTransport: login failed — will retry.", {
            error: err?.message ?? "null API returned",
          });
          resolve();
          this.scheduleReconnect();
          return;
        }

        this.api = api;
        this.reconnectAttempts = 0;
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

    this.stopListenFn = this.api.listen((err, event) => {
      if (err) {
        log.warn("MiraiTransport: listen error — scheduling reconnect.", {
          error: err.message,
        });
        this.scheduleReconnect();
        return;
      }

      if (!this.running) return;

      // ── [DEBUG-1] Raw event received from Facebook MQTT ────────────────
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

  private scheduleReconnect(): void {
    if (!this.running) return;

    if (this.reconnectAttempts >= MiraiTransport.MAX_RECONNECT) {
      log.warn("MiraiTransport: max reconnect attempts reached — giving up.", {
        maxAttempts: MiraiTransport.MAX_RECONNECT,
      });
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      MiraiTransport.BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      MiraiTransport.MAX_DELAY_MS,
    );

    log.info("MiraiTransport: scheduling reconnect.", {
      attempt:     this.reconnectAttempts,
      maxAttempts: MiraiTransport.MAX_RECONNECT,
      delayMs:     delay,
    });

    this.stopListening();
    this.api = null;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;

      this.login().catch((e: unknown) => {
        log.error("MiraiTransport: reconnect threw unexpectedly.", {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }, delay);
  }
}
