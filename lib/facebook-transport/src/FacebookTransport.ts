import { EventEmitter } from "events";
import { AppState, FcaApi, FcaLoginFn, FcaRawEvent, TransportEvent } from "./types.js";

// ─── fca-unofficial options ────────────────────────────────────────────────────

const FCA_OPTIONS: Record<string, unknown> = {
  logLevel:          "silent",
  selfListen:        false,
  listenEvents:      true,
  updatePresence:    false,
  forceLogin:        false,
  autoMarkDelivered: true,
  autoMarkRead:      false,
  autoReconnect:     false,
};

// ─── FacebookTransport ────────────────────────────────────────────────────────
//
// مسؤول عن:
//   • تسجيل الدخول (login مرة واحدة فقط)
//   • تشغيل listenMqtt بعد نجاح تسجيل الدخول
//   • إرسال الرسائل
//   • استقبال الأحداث وإعادة إرسالها عبر EventEmitter
//
// غير مسؤول عن:
//   • Retry أو Reconnect
//   • Session Management
//   • أي منطق تجاري

export class FacebookTransport extends EventEmitter {

  private api:         FcaApi | null    = null;
  private stopListen: (() => void) | null = null;
  private connected                      = false;

  constructor(private readonly fcaLogin: FcaLoginFn) {
    super();
  }

  // ── read-only ─────────────────────────────────────────────────────────────

  isConnected(): boolean        { return this.connected; }
  getApi():      FcaApi | null  { return this.api;       }

  // ── login ─────────────────────────────────────────────────────────────────

  /**
   * ينفذ login مرة واحدة فقط.
   * عند النجاح يبدأ listenMqtt مباشرة.
   * لا يعيد المحاولة — القرار للخارج.
   */
  login(appState: AppState): Promise<void> {
    this.emit("event", { type: "login:started" } satisfies TransportEvent);

    return new Promise<void>((resolve) => {
      const pageID = appState.find(c => c.key === "c_user")?.value;

      this.fcaLogin({ appState, ...(pageID ? { pageID } : {}) }, (err, api) => {

        // ── فشل ─────────────────────────────────────────────────────────
        if (err || !api) {
          const error = err instanceof Error ? err.message
                      : err != null          ? JSON.stringify(err)
                      : "null API returned";

          this.emit("event", { type: "login:failed", error } satisfies TransportEvent);
          resolve();
          return;
        }

        // ── نجاح ─────────────────────────────────────────────────────────
        api.setOptions({ ...FCA_OPTIONS, pageID: api.getCurrentUserID() });

        this.api       = api;
        this.connected = true;

        this.emit("event", {
          type:         "login:success",
          userId:       api.getCurrentUserID(),
          freshCookies: api.getAppState(),
        } satisfies TransportEvent);

        this.listenMqtt(api);
        resolve();
      });
    });
  }

  // ── listenMqtt ────────────────────────────────────────────────────────────

  /**
   * يبدأ الاستماع لأحداث Facebook عبر MQTT.
   * يُطلق mqtt:connected عند البدء.
   * عند أي خطأ يُطلق mqtt:disconnected ولا يعيد الاتصال.
   */
  private listenMqtt(api: FcaApi): void {
    this.emit("event", {
      type:   "mqtt:connected",
      userId: api.getCurrentUserID(),
    } satisfies TransportEvent);

    this.stopListen = api.listen((err, event: FcaRawEvent) => {

      // ── خطأ MQTT ──────────────────────────────────────────────────────
      if (err) {
        let errorCode: number | undefined;
        let errorMsg:  string;

        if (err instanceof Error) {
          errorMsg = err.message;
        } else if (typeof err === "object" && err !== null) {
          const e   = err as Record<string, unknown>;
          errorCode = typeof e["error"] === "number" ? e["error"] : undefined;
          errorMsg  = JSON.stringify(err);
        } else {
          errorMsg = String(err);
        }

        this.api       = null;
        this.connected = false;

        this.emit("event", {
          type: "mqtt:disconnected",
          errorCode,
          errorMsg,
        } satisfies TransportEvent);

        return;
      }

      // ── حدث وارد من Facebook ──────────────────────────────────────────
      if (event) {
        this.emit("fca:event", event);
      }
    });
  }

  // ── sendMessage ───────────────────────────────────────────────────────────

  /**
   * يرسل رسالة نصية أو مع مرفق.
   * يُرجع Promise يُحل عند النجاح أو يُرفض عند الفشل.
   */
  sendMessage(threadID: string, message: string): Promise<{ messageID: string }> {
    return new Promise((resolve, reject) => {
      if (!this.api) {
        reject(new Error("Not connected — call login() first."));
        return;
      }

      this.api.sendMessage(message, threadID, (err, info) => {
        if (err) { reject(err); return; }
        resolve(info);
      });
    });
  }

  // ── disconnect ────────────────────────────────────────────────────────────

  /**
   * يوقف الاستماع ويُسجّل الخروج.
   */
  disconnect(): void {
    if (this.stopListen) { this.stopListen(); this.stopListen = null; }
    if (this.api)        { try { this.api.logout(); } catch { /**/ } this.api = null; }
    this.connected = false;
  }
}