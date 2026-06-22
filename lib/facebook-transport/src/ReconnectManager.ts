import { FacebookTransport } from "./FacebookTransport.js";
import { SessionManager }    from "./SessionManager.js";
import { ConnectionController } from "./ConnectionController.js";
import { AppState } from "./types.js";

// ─── ReconnectManager ─────────────────────────────────────────────────────────
//
// الوحيد المسؤول عن منطق إعادة الاتصال.
// يقرأ الحالة من ConnectionController ويحسب delay ذكي قبل كل محاولة.
//
// القواعد:
//   • كل منطق الانتظار مركزي هنا فقط
//   • لا يعدل AppState
//   • لا يتدخل في Transport أو SessionManager
//   • يوقف نفسه تلقائياً عند maxAttempts

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ReconnectConfig {
  /** أقصر وقت انتظار أساسي (ms) — افتراضي 5 ثوانٍ */
  baseDelayMs?:        number;
  /** أقصى وقت انتظار إجمالي (ms) — افتراضي 5 دقائق */
  maxDelayMs?:         number;
  /** أقصى عدد محاولات قبل الاستسلام — افتراضي 10 */
  maxAttempts?:        number;
  /** حد مدة الجلسة "القصيرة" بالـ ms — افتراضي 5 دقائق */
  shortSessionThresholdMs?: number;
}

// ─── State ────────────────────────────────────────────────────────────────────

export type ReconnectState =
  | "idle"
  | "waiting"       // ينتظر delay
  | "reconnecting"  // يُشغّل login
  | "stopped";      // وصل maxAttempts أو أُوقف يدوياً

export interface ReconnectSnapshot {
  state:         ReconnectState;
  attempt:       number;
  maxAttempts:   number;
  lastDelayMs:   number | null;
  nextAttemptAt: Date | null;
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class ReconnectManager {

  private readonly baseDelayMs:            number;
  private readonly maxDelayMs:             number;
  private readonly maxAttempts:            number;
  private readonly shortSessionThresholdMs: number;

  private state:         ReconnectState = "idle";
  private attempt:       number         = 0;
  private lastDelayMs:   number | null  = null;
  private nextAttemptAt: Date   | null  = null;
  private timer:         ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly transport:   FacebookTransport,
    private readonly session:     SessionManager,
    private readonly controller:  ConnectionController,
    private readonly getAppState: () => AppState,
    config: ReconnectConfig = {}
  ) {
    this.baseDelayMs             = config.baseDelayMs             ??  5_000;
    this.maxDelayMs              = config.maxDelayMs              ?? 300_000;
    this.maxAttempts             = config.maxAttempts             ?? 10;
    this.shortSessionThresholdMs = config.shortSessionThresholdMs ?? 300_000;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** يبدأ الاستماع لأحداث الانقطاع من Transport */
  start(): void {
    this.transport.on("event", (ev) => {
      if (ev.type === "mqtt:disconnected" || ev.type === "login:failed") {
        this.scheduleReconnect();
      }
      if (ev.type === "login:success") {
        this.reset();
      }
    });
  }

  /** يوقف أي محاولة قادمة نهائياً */
  stop(): void {
    this.clearTimer();
    this.state = "stopped";
  }

  getSnapshot(): ReconnectSnapshot {
    return {
      state:         this.state,
      attempt:       this.attempt,
      maxAttempts:   this.maxAttempts,
      lastDelayMs:   this.lastDelayMs,
      nextAttemptAt: this.nextAttemptAt,
    };
  }

  // ── core logic ────────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.state === "stopped") return;
    if (this.state === "waiting" || this.state === "reconnecting") return;

    this.attempt++;

    if (this.attempt > this.maxAttempts) {
      console.warn(`[ReconnectManager] وصلت maxAttempts (${this.maxAttempts}) — توقف.`);
      this.state = "stopped";
      return;
    }

    const delay = this.computeDelay();

    this.state         = "waiting";
    this.lastDelayMs   = delay;
    this.nextAttemptAt = new Date(Date.now() + delay);

    console.log(
      `[ReconnectManager] محاولة ${this.attempt}/${this.maxAttempts}` +
      ` — انتظار ${(delay / 1000).toFixed(1)}s` +
      ` (${this.delayReason()})`
    );

    this.timer = setTimeout(() => this.doReconnect(), delay);
  }

  private async doReconnect(): Promise<void> {
    if (this.state === "stopped") return;

    this.state         = "reconnecting";
    this.nextAttemptAt = null;

    console.log(`[ReconnectManager] ⟳ إعادة الاتصال (محاولة ${this.attempt})...`);

    const appState = this.getAppState();
    await this.transport.login(appState);
    // نتيجة login تصل عبر events → start() يستمع لها
  }

  // ── delay computation ─────────────────────────────────────────────────────

  /**
   * يحسب وقت الانتظار الكلي بناءً على ثلاثة عوامل:
   *
   *   1. عدد الانقطاعات المتتالية  → backoff أسّي بحد أقصى
   *   2. مدة الجلسة السابقة       → جلسة قصيرة = خطر → delay أطول
   *   3. عدد فشل login            → كل فشل يضيف 30 ثانية
   */
  private computeDelay(): number {
    const snap = this.controller.getSnapshot();

    // ── العامل 1: exponential backoff على عدد المحاولات
    const exponential = Math.min(
      this.baseDelayMs * Math.pow(2, this.attempt - 1),
      this.maxDelayMs
    );

    // ── العامل 2: جلسة قصيرة → Facebook قطع بسرعة → انتظر أكثر
    let sessionPenalty = 0;
    if (snap.uptimeSec !== null) {
      const durationMs = snap.uptimeSec * 1000;
      if (durationMs < this.shortSessionThresholdMs) {
        // كلما كانت الجلسة أقصر كلما زاد العقاب (حتى 60 ثانية)
        const ratio = 1 - durationMs / this.shortSessionThresholdMs;
        sessionPenalty = Math.round(ratio * 60_000);
      }
    }

    // ── العامل 3: فشل login متكرر → زيادة ثابتة 30s لكل فشل فوق 2
    const loginPenalty =
      snap.loginFailCount > 2
        ? (snap.loginFailCount - 2) * 30_000
        : 0;

    // ── المجموع بحد أقصى maxDelayMs
    return Math.min(exponential + sessionPenalty + loginPenalty, this.maxDelayMs);
  }

  /** وصف نصي لسبب الـ delay — للـ logs */
  private delayReason(): string {
    const snap    = this.controller.getSnapshot();
    const reasons: string[] = [];

    if (this.attempt > 1)                reasons.push(`محاولة#${this.attempt}`);
    if (snap.mqttDisconnects > 3)        reasons.push(`${snap.mqttDisconnects} قطع`);
    if (snap.uptimeSec !== null && snap.uptimeSec < 300) reasons.push(`جلسة قصيرة ${snap.uptimeSec}s`);
    if (snap.loginFailCount > 2)         reasons.push(`${snap.loginFailCount} فشل login`);

    return reasons.length ? reasons.join(" + ") : "backoff عادي";
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private reset(): void {
    this.clearTimer();
    this.attempt       = 0;
    this.lastDelayMs   = null;
    this.nextAttemptAt = null;
    this.state         = "idle";
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.state === "waiting") this.state = "idle";
  }
}
