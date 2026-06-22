import { FacebookTransport } from "./FacebookTransport.js";
import { TransportEvent }    from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "unstable";

export interface EventRecord {
  at:      Date;
  type:    string;
  detail:  Record<string, unknown>;
}

// ─── ConnectionController ─────────────────────────────────────────────────────
//
// مراقب فقط — لا يؤثر على الاتصال بأي شكل.
//
// المسموح:
//   • استقبال events من FacebookTransport
//   • تسجيلها في logs
//   • حساب ConnectionStatus الحالية
//   • إرجاع snapshot للتحليل
//
// الممنوع:
//   • reconnect / retry
//   • تعديل AppState
//   • أي استدعاء على FacebookTransport

export class ConnectionController {

  private status: ConnectionStatus        = "idle";
  private readonly history: EventRecord[] = [];

  // عدّادات لتحليل الاستقرار
  private loginFailCount        = 0;
  private mqttDisconnectCount   = 0;
  private connectedAt:   number | null = null;
  private disconnectedAt: number | null = null;

  // ── attach ────────────────────────────────────────────────────────────────

  /**
   * يربط المراقب بـ Transport.
   * يُشغَّل مرة واحدة فقط عند التهيئة.
   * لا يُعدّل السلوك — يستمع فقط.
   */
  attach(transport: FacebookTransport): void {
    transport.on("event",     (ev: TransportEvent)         => this.onTransportEvent(ev));
    transport.on("fca:event", (ev: Record<string, unknown>) => this.onFcaEvent(ev));
  }

  // ── read-only accessors ───────────────────────────────────────────────────

  getStatus():  ConnectionStatus        { return this.status;  }
  getHistory(): Readonly<EventRecord[]> { return this.history; }

  /**
   * Snapshot كامل للحالة الحالية — للتشخيص فقط.
   */
  getSnapshot(): {
    status:             ConnectionStatus;
    connectedAt:        Date | null;
    disconnectedAt:     Date | null;
    uptimeSec:          number | null;
    loginFailCount:     number;
    mqttDisconnects:    number;
    lastEvent:          EventRecord | null;
    isUnstable:         boolean;
  } {
    const uptimeSec =
      this.status === "connected" && this.connectedAt !== null
        ? Math.floor((Date.now() - this.connectedAt) / 1000)
        : null;

    return {
      status:          this.status,
      connectedAt:     this.connectedAt    !== null ? new Date(this.connectedAt)    : null,
      disconnectedAt:  this.disconnectedAt !== null ? new Date(this.disconnectedAt) : null,
      uptimeSec,
      loginFailCount:  this.loginFailCount,
      mqttDisconnects: this.mqttDisconnectCount,
      lastEvent:       this.history.at(-1) ?? null,
      isUnstable:      this.status === "unstable",
    };
  }

  // ── private: event handlers ───────────────────────────────────────────────

  private onTransportEvent(ev: TransportEvent): void {
    switch (ev.type) {

      case "login:started":
        this.status = "connecting";
        this.record("login:started", {});
        break;

      case "login:success":
        this.status      = "connected";
        this.connectedAt = Date.now();
        this.record("login:success", { userId: ev.userId });
        break;

      case "login:failed":
        this.loginFailCount++;
        this.status          = "disconnected";
        this.disconnectedAt  = Date.now();
        this.record("login:failed", { error: ev.error, totalFails: this.loginFailCount });
        break;

      case "mqtt:connected":
        this.status = "connected";
        this.record("mqtt:connected", { userId: ev.userId });
        break;

      case "mqtt:disconnected":
        this.mqttDisconnectCount++;
        this.disconnectedAt = Date.now();

        // "unstable" إذا انقطع أكثر من مرة منذ آخر login ناجح
        this.status = this.mqttDisconnectCount > 1 ? "unstable" : "disconnected";

        this.record("mqtt:disconnected", {
          errorCode:      ev.errorCode,
          errorMsg:       ev.errorMsg,
          totalDisconnects: this.mqttDisconnectCount,
        });
        break;
    }
  }

  private onFcaEvent(ev: Record<string, unknown>): void {
    if (ev["type"] === "message" || ev["type"] === "message_reply") {
      this.record("message:received", {
        from:     ev["senderID"],
        thread:   ev["threadID"],
        isGroup:  ev["isGroup"],
      });
    }

    if (ev["type"] === "error") {
      this.record("error:occurred", { raw: ev });
    }
  }

  // ── private: logging ──────────────────────────────────────────────────────

  private record(type: string, detail: Record<string, unknown>): void {
    this.history.push({ at: new Date(), type, detail });
  }
}