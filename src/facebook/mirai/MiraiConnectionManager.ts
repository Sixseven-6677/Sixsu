/**
 * MiraiConnectionManager
 *
 * نظام إدارة جلسات هجين:
 *   معمارية Sixsu المتطورة  +  ذكاء Goatbot في إدارة الجلسات
 *
 * ما تم استعارته من Goatbot:
 *   1. callbackListenTime dedup (listenerGeneration)
 *      كل دورة MQTT لها رقم generation ملتقط خارج الـ closure.
 *      عند إعادة التشغيل يرتفع الرقم وتُعاد كتابة handler بـ generation جديد،
 *      فتُسقط أي أحداث تصل من handler قديم فور مقارنة الرقمين.
 *
 *   2. storage5Message — آخر 5 messageID. إذا وصل messageID مكرر:
 *      ← يُسقط الحدث
 *      ← يُبطل الـ generation الحالي (إشارة لوجود listener مزدوج)
 *      مثل Goatbot تماماً.
 *
 *   3. restartListenMqtt — إعادة تشغيل MQTT دورية كل 30 دقيقة
 *      باستخدام أحدث الكوكيز (نمط Goatbot الأصلي).
 *
 *   4. filterKeysAppState — 6 كوكيز أساسية فقط:
 *      c_user, xs, datr, fr, sb, i_user
 *      (نفس قائمة Goatbot الحرفية).
 *
 *   5. checkLiveCookie — فحص صحة الجلسة عبر HTTP كل 10 دقائق
 *      (مستقل عن MQTT، يكتشف checkpoint مبكراً).
 *
 * ما يحافظ عليه من Sixsu:
 *   • ISystem lifecycle (initialize / destroy)
 *   • LoggerManager (pino)
 *   • setOnPermanentFailure / setOnAppStateRefresh
 *   • Exponential backoff (مفوّض لـ MiraiTransport)
 */

import axios                              from "axios";
import { ISystem }                        from "../../core/interfaces/ISystem";
import { MiraiTransport, FcaEventHandler } from "./MiraiTransport";
import { FcaApi, FcaCookie }              from "./FcaTypes";
import { LoggerManager }                  from "../../logger/LoggerManager";

const log = LoggerManager.getLogger("MiraiConnectionManager");

// ─── Cookie whitelist — نفس قائمة Goatbot الحرفية ────────────────────────────
// filterKeysAppState في Goatbot:
//   return appState.filter(item =>
//     ["c_user","xs","datr","fr","sb","i_user"].includes(item.key));
const GOATBOT_ESSENTIAL_KEYS = new Set(["c_user", "xs", "datr", "fr", "sb", "i_user"]);

// ─── Options ──────────────────────────────────────────────────────────────────

export interface MiraiConnectionManagerOptions {
  /** Milliseconds to wait before the first login (stagger multiple accounts). */
  initDelayMs?: number;
  /**
   * Proactive MQTT restart interval (ms). Default: 30 min (Goatbot default).
   * Set 0 to disable.
   */
  proactiveRestartMs?: number;
  /**
   * HTTP cookie health check interval (ms). Default: 10 min.
   * Set 0 to disable.
   */
  cookieHealthCheckIntervalMs?: number;
}

// ─── MiraiConnectionManager ───────────────────────────────────────────────────

export class MiraiConnectionManager implements ISystem {
  readonly name: string;

  private readonly transport:          MiraiTransport;
  private readonly proactiveRestartMs: number;
  private readonly cookieHealthMs:     number;

  private externalHandler:   FcaEventHandler | null = null;
  private onPermFailure:     ((reason: string) => void) | null = null;
  private onAppStateRefresh: ((cookies: FcaCookie[]) => void) | null = null;

  /**
   * Goatbot: callbackListenTime generation counter.
   * مهم: يُلتقط خارج الـ event-handler closure في rewireEventHandler()،
   * فيمثّل نسخة الـ generation وقت التسجيل، لا وقت تنفيذ الحدث.
   */
  private listenerGeneration = 0;

  /** Goatbot: storage5Message — ring-buffer لآخر 5 messageIDs */
  private readonly seenMessageIds: string[] = [];

  private proactiveRestartTimer: ReturnType<typeof setInterval> | null = null;
  private cookieHealthTimer:     ReturnType<typeof setInterval> | null = null;

  // ── Constructor ─────────────────────────────────────────────────────────────

  constructor(
    rawAppState: FcaCookie[],
    systemName  = "mirai-connection",
    opts: MiraiConnectionManagerOptions = {},
  ) {
    this.name               = systemName;
    this.proactiveRestartMs = opts.proactiveRestartMs          ?? 30 * 60_000;
    this.cookieHealthMs     = opts.cookieHealthCheckIntervalMs ?? 10 * 60_000;

    const appState = MiraiConnectionManager.filterAppState(rawAppState);
    log.info(
      `[${systemName}]: AppState filtered — ` +
      `${rawAppState.length} cookies → ${appState.length} essential (Goatbot filter).`,
    );

    this.transport = new MiraiTransport(appState, systemName, opts.initDelayMs ?? 0);

    // wire transport-level callbacks (غير حدث-handler — يُسجَّل لاحقاً)
    this.transport.setOnPermanentFailure((reason) => {
      log.error(`[${this.name}]: transport permanent failure — ${reason}.`);
      this.onPermFailure?.(reason);
    });

    this.transport.setOnAppStateRefresh((cookies) => {
      const filtered = MiraiConnectionManager.filterAppState(cookies);
      const toSave   = filtered.length >= 2 ? filtered : cookies;
      log.info(`[${this.name}]: AppState refreshed — ${cookies.length} → ${toSave.length} cookies.`);
      this.onAppStateRefresh?.(toSave);
    });
  }

  // ── ISystem lifecycle ────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    log.info(`[${this.name}]: initializing hybrid session manager…`);
    // يجب تسجيل event-handler قبل initialize() حتى يستقبل الأحداث من البداية
    this.rewireEventHandler();
    await this.transport.initialize();
    this.startProactiveRestart();
    this.startCookieHealthCheck();
    log.info(
      `[${this.name}]: ready. ` +
      `proactiveRestart=${this.proactiveRestartMs / 60_000}min ` +
      `cookieHealth=${this.cookieHealthMs / 60_000}min`,
    );
  }

  async destroy(): Promise<void> {
    log.info(`[${this.name}]: destroying.`);
    this.stopProactiveRestart();
    this.stopCookieHealthCheck();
    await this.transport.destroy();
    this.externalHandler   = null;
    this.onPermFailure     = null;
    this.onAppStateRefresh = null;
    log.info(`[${this.name}]: destroyed.`);
  }

  /**
   * External restart — يرفع generation ثم يُعيد كتابة handler بالرقم الجديد،
   * ثم يفوّض لـ MiraiTransport.restart() مع تصفية الكوكيز.
   */
  async restart(freshAppState?: FcaCookie[]): Promise<void> {
    this.listenerGeneration++;
    log.info(
      `[${this.name}]: restart — generation=${this.listenerGeneration}. [goatbot-callbackListenTime]`,
    );

    // إعادة تسجيل handler بـ generation ملتقط جديد قبل الاتصال
    this.rewireEventHandler();

    const filtered = freshAppState
      ? MiraiConnectionManager.filterAppState(freshAppState)
      : undefined;

    await this.transport.restart(
      filtered && filtered.length >= 2 ? filtered : freshAppState,
    );
  }

  // ── Static helpers ───────────────────────────────────────────────────────────

  /**
   * Goatbot: filterKeysAppState
   * نفس الكود الحرفي من Goatbot — 6 كوكيز فقط.
   */
  static filterAppState(cookies: FcaCookie[]): FcaCookie[] {
    const filtered = cookies.filter(c => GOATBOT_ESSENTIAL_KEYS.has(c.key));
    // Safety: إذا فقدت c_user أو xs يعني الفلتر أفسد الجلسة — ارجع للأصل
    const hasCUser = filtered.some(c => c.key === "c_user");
    const hasXs    = filtered.some(c => c.key === "xs");
    if (!hasCUser || !hasXs) {
      log.warn(
        `[MiraiConnectionManager]: filterAppState — c_user/xs missing after filter, ` +
        `reverting to original ${cookies.length} cookies.`,
      );
      return cookies;
    }
    return filtered;
  }

  /**
   * Goatbot: checkLiveCookie
   * يفحص صحة الجلسة عبر HTTP لـ mbasic.facebook.com/settings.
   * مستقل عن MQTT — يكتشف checkpoint حتى لو MQTT يبدو طبيعياً.
   */
  static async checkLiveCookie(
    cookies: FcaCookie[],
  ): Promise<{ alive: boolean; checkpoint: boolean; error?: string }> {
    const cookieStr = cookies
      .filter(c => c.key && c.value)
      .map(c => `${c.key}=${c.value}`)
      .join("; ");

    try {
      const resp = await axios.get<string>("https://mbasic.facebook.com/settings", {
        maxRedirects: 5,
        timeout:      15_000,
        headers: {
          cookie:             cookieStr,
          "user-agent":
            "Mozilla/5.0 (Linux; Android 12; M2102J20SG) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/101.0.0.0 Mobile Safari/537.36",
          accept:             "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language":  "en-US,en;q=0.9",
          "sec-fetch-dest":   "document",
          "sec-fetch-mode":   "navigate",
        },
      });

      const data       = resp.data ?? "";
      const finalUrl   = String(
        ((resp.request as Record<string, unknown>)?.res as Record<string, unknown>)?.responseUrl ?? "",
      );

      if (finalUrl.includes("/checkpoint/") || data.includes("/checkpoint/")) {
        return { alive: false, checkpoint: true };
      }

      const alive =
        data.includes("/notifications.php") ||
        data.includes("/privacy/xcs/action/logging/") ||
        data.includes("href=\"/login/save-password-interstitial") ||
        data.includes("/settings");

      return { alive, checkpoint: false };

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("checkpoint")) {
        return { alive: false, checkpoint: true, error: msg };
      }
      return { alive: false, checkpoint: false, error: msg };
    }
  }

  // ── Public accessors ─────────────────────────────────────────────────────────

  setEventHandler(fn: FcaEventHandler): void {
    this.externalHandler = fn;
  }

  setOnPermanentFailure(fn: (reason: string) => void): void {
    this.onPermFailure = fn;
  }

  setOnAppStateRefresh(fn: (cookies: FcaCookie[]) => void): void {
    this.onAppStateRefresh = fn;
  }

  isConnected():      boolean        { return this.transport.isConnected(); }
  isRunning():        boolean        { return this.transport.isRunning(); }
  getApi():           FcaApi | null  { return this.transport.getApi(); }
  getCurrentUserId(): string         { return this.transport.getCurrentUserId(); }
  getAppState():      FcaCookie[]    { return this.transport.getAppState(); }

  addRawEventListener(fn: FcaEventHandler): void {
    this.transport.addRawEventListener(fn);
  }
  removeRawEventListener(fn: FcaEventHandler): void {
    this.transport.removeRawEventListener(fn);
  }

  getStats(): ReturnType<MiraiTransport["getStats"]> & {
    listenerGeneration: number;
    seenMessageCount:   number;
  } {
    return {
      ...this.transport.getStats(),
      listenerGeneration: this.listenerGeneration,
      seenMessageCount:   this.seenMessageIds.length,
    };
  }

  // ── Private: rewire event handler (الإصلاح الرئيسي) ─────────────────────────
  //
  // يُستدعى في initialize() وفي كل restart().
  // يلتقط listenerGeneration خارج الـ closure — هذا هو الفرق الحاسم عن النسخة
  // المعطوبة التي كانت تلتقطه داخل الـ closure (فكان دائماً مساوياً لنفسه).
  //
  // نظير Goatbot:
  //   callbackListenTime[key] = callBackListen;  // يسجّل callback بمفتاح فريد
  //   return function(error, event) {
  //     callbackListenTime[key](error, event);   // يبحث بالمفتاح وقت التنفيذ
  //   };
  // عندما يبدأ listener جديد، القديم يجد قيمة مفتاحه صارت () => {}
  // هنا نحقق نفس الأثر بـ generation رقمي يُلتقط خارج الـ closure.

  private rewireEventHandler(): void {
    // ← يُلتقط الآن، قبل أي حدث قادم
    const capturedGeneration = this.listenerGeneration;

    this.transport.setEventHandler((event) => {
      // 1. Goatbot: callbackListenTime — هل هذا handler من نسخة قديمة؟
      if (capturedGeneration !== this.listenerGeneration) {
        log.debug(
          `[${this.name}]: stale event dropped — ` +
          `handler generation=${capturedGeneration}, current=${this.listenerGeneration}. ` +
          `[goatbot-callbackListenTime]`,
        );
        return;
      }

      // 2. Goatbot: storage5Message — كشف حلقة MQTT مكررة
      const ev = event as Record<string, unknown>;
      if (ev.type === "message" || ev.type === "message_reply") {
        const mid = ev.messageID as string | undefined;
        if (mid) {
          if (this.seenMessageIds.includes(mid)) {
            // Goatbot: عند الكشف، يُبطل كل listeners القديمة بإعادة كتابة generation
            // (في Goatbot: Object.keys(callbackListenTime).slice(0,-1).forEach(k => callbackListenTime[k] = ()=>{}) )
            log.warn(
              `[${this.name}]: duplicate messageID=${mid} — ` +
              `MQTT loop detected. Invalidating current generation ${capturedGeneration}. ` +
              `[goatbot-storage5Message]`,
            );
            // إبطال generation الحالي يجعل هذا الـ handler وأي handler مزدوج يرفض كل الأحداث
            this.listenerGeneration++;
            // تسجيل handler نظيف فوراً
            this.rewireEventHandler();
            return;
          }
          this.seenMessageIds.push(mid);
          if (this.seenMessageIds.length > 5) this.seenMessageIds.shift();
        }
      }

      this.externalHandler?.(event);
    });
  }

  // ── Private: proactive restart (Goatbot: restartListenMqtt) ─────────────────

  private startProactiveRestart(): void {
    if (this.proactiveRestartMs <= 0) {
      log.info(`[${this.name}]: proactive restart disabled.`);
      return;
    }
    log.info(
      `[${this.name}]: proactive restart every ` +
      `${this.proactiveRestartMs / 60_000}min. [goatbot-restartListenMqtt]`,
    );

    this.proactiveRestartTimer = setInterval(async () => {
      if (!this.transport.isRunning()) return;
      log.info(`[${this.name}]: proactive restart firing. [goatbot-restartListenMqtt]`);
      try {
        const latestCookies = this.transport.getAppState();
        await this.restart(latestCookies.length > 0 ? latestCookies : undefined);
        log.info(`[${this.name}]: proactive restart complete.`);
      } catch (err: unknown) {
        log.error(`[${this.name}]: proactive restart failed.`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.proactiveRestartMs);
  }

  private stopProactiveRestart(): void {
    if (this.proactiveRestartTimer) {
      clearInterval(this.proactiveRestartTimer);
      this.proactiveRestartTimer = null;
    }
  }

  // ── Private: cookie health check (Goatbot: checkLiveCookie) ─────────────────

  private startCookieHealthCheck(): void {
    if (this.cookieHealthMs <= 0) {
      log.info(`[${this.name}]: cookie health check disabled.`);
      return;
    }
    log.info(
      `[${this.name}]: cookie health check every ` +
      `${this.cookieHealthMs / 60_000}min. [goatbot-checkLiveCookie]`,
    );

    this.cookieHealthTimer = setInterval(async () => {
      if (!this.transport.isRunning()) return;
      const cookies = this.transport.getAppState();
      if (cookies.length === 0) return;

      try {
        const result = await MiraiConnectionManager.checkLiveCookie(cookies);

        if (result.checkpoint) {
          log.error(
            `[${this.name}]: CHECKPOINT detected! ` +
            `Account needs manual Facebook verification. [goatbot-checkLiveCookie]`,
          );
          this.onPermFailure?.("checkpoint-detected");
          return;
        }

        if (!result.alive) {
          log.warn(
            `[${this.name}]: cookie health FAILED — session may be expired. ` +
            `Triggering reconnect. [goatbot-checkLiveCookie]`,
            { error: result.error },
          );
          this.onPermFailure?.("cookie-health-check-failed");
          return;
        }

        log.info(`[${this.name}]: cookie health OK. [goatbot-checkLiveCookie]`);
      } catch (err: unknown) {
        log.warn(`[${this.name}]: cookie health check threw — skipping.`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.cookieHealthMs);
  }

  private stopCookieHealthCheck(): void {
    if (this.cookieHealthTimer) {
      clearInterval(this.cookieHealthTimer);
      this.cookieHealthTimer = null;
    }
  }
}
