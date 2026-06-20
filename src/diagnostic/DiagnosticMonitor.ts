/**
 * DiagnosticMonitor — Phase 1 diagnostic system.
 *
 * A singleton that instruments:
 *   • Login / Logout events
 *   • MQTT Connect / Disconnect / Error events
 *   • AppState Load / Save / Invalidation
 *   • Reconnect attempts & loop detection
 *   • Facebook API call counts per method and source
 *   • Interval / timer registrations
 *   • Duplicate listener detection
 *
 * PHASE 1 ONLY — pure observation, zero behaviour changes.
 */

import fs   from "fs";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("DiagnosticMonitor");

// ─── Event types ──────────────────────────────────────────────────────────────

export interface LoginEvent {
  accountId:   string;
  at:          Date;
  success:     boolean;
  userId?:     string;
  cookieCount?: number;
  attempt?:    number;
  error?:      string;
}

export interface MqttEvent {
  accountId: string;
  type:      "connect" | "disconnect" | "error";
  at:        Date;
  errorCode?: number;
  errorMsg?:  string;
  stableMs?:  number;
}

export interface ReconnectEvent {
  accountId: string;
  at:        Date;
  reason:    string;
  attempt:   number;
}

export interface AppStateEvent {
  accountId:   string;
  type:        "load" | "save" | "stale-check" | "invalid" | "expired";
  at:          Date;
  cookieCount?: number;
  freshCount?:  number;
  source?:      string;
  drift?:       boolean;
  error?:       string;
}

export interface ApiCallRecord {
  method:   string;
  source:   string;
  count:    number;
  firstAt:  Date;
  lastAt:   Date;
  errors:   number;
}

export interface IntervalRecord {
  name:          string;
  intervalMs:    number;
  registeredAt:  Date;
  runCount:      number;
  lastRunAt:     Date | null;
  source?:       string;
}

// ─── Monitor ──────────────────────────────────────────────────────────────────

class DiagnosticMonitor {
  private readonly startedAt      = new Date();

  private readonly loginEvents:    LoginEvent[]    = [];
  private readonly mqttEvents:     MqttEvent[]     = [];
  private readonly reconnectEvents:ReconnectEvent[]= [];
  private readonly appStateEvents: AppStateEvent[] = [];
  private readonly apiCalls        = new Map<string, ApiCallRecord>();
  private readonly intervals:      IntervalRecord[] = [];

  private activeListeners        = 0;
  private duplicateListenerCount = 0;
  private saveTimer:             ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic auto-report every 10 minutes
    this.saveTimer = setInterval(() => this.saveReport(), 10 * 60_000);
    log.info("[DIAG] DiagnosticMonitor started.", { startedAt: this.startedAt.toISOString() });
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  recordLogin(accountId: string, success: boolean, opts: {
    userId?:      string;
    cookieCount?: number;
    attempt?:     number;
    error?:       string;
  } = {}): void {
    const ev: LoginEvent = { accountId, at: new Date(), success, ...opts };
    this.loginEvents.push(ev);

    if (success) {
      log.info("[DIAG][LOGIN] ✅ Login SUCCESS", {
        accountId,
        userId:        opts.userId,
        cookieCount:   opts.cookieCount,
        attempt:       opts.attempt,
        totalLogins:   this.loginEvents.filter(e => e.success).length,
        uptimeMin:     this._uptimeMin(),
      });
    } else {
      log.error("[DIAG][LOGIN] ❌ Login FAILED", {
        accountId,
        error:          opts.error,
        attempt:        opts.attempt,
        totalFailures:  this.loginEvents.filter(e => !e.success).length,
      });
    }
  }

  // ── MQTT ──────────────────────────────────────────────────────────────────

  recordMqttConnect(accountId: string): void {
    const ev: MqttEvent = { accountId, type: "connect", at: new Date() };
    this.mqttEvents.push(ev);
    this.activeListeners++;

    const totalConnects = this.mqttEvents.filter(e => e.type === "connect").length;

    log.info("[DIAG][MQTT] ✅ MQTT Connected", {
      accountId,
      activeListeners: this.activeListeners,
      totalConnects,
    });

    if (this.activeListeners > 1) {
      this.duplicateListenerCount++;
      log.error("[DIAG][MQTT] 🚨 DUPLICATE LISTENER DETECTED — two MQTT streams on same account!", {
        accountId,
        activeListeners:  this.activeListeners,
        duplicateCount:   this.duplicateListenerCount,
        diagnostic:       "This directly invalidates the AppState. One of the listeners must be stopped.",
      });
    }
  }

  recordMqttDisconnect(accountId: string, opts: {
    errorCode?: number;
    errorMsg?:  string;
    stableMs?:  number;
  } = {}): void {
    const ev: MqttEvent = { accountId, type: "disconnect", at: new Date(), ...opts };
    this.mqttEvents.push(ev);
    this.activeListeners = Math.max(0, this.activeListeners - 1);

    const stableSec = opts.stableMs !== undefined ? (opts.stableMs / 1000).toFixed(1) : "?";
    log.warn("[DIAG][MQTT] ⚡ MQTT Disconnected", {
      accountId,
      errorCode:      opts.errorCode,
      errorMsg:       opts.errorMsg?.slice(0, 120),
      stableSec,
      activeListeners: this.activeListeners,
      totalDisconnects: this.mqttEvents.filter(e => e.type === "disconnect").length,
    });
  }

  recordMqttError(accountId: string, errorCode?: number, errorMsg?: string): void {
    const ev: MqttEvent = { accountId, type: "error", at: new Date(), errorCode, errorMsg };
    this.mqttEvents.push(ev);
    log.error("[DIAG][MQTT] 🔴 MQTT Error", {
      accountId,
      errorCode,
      errorMsg: errorMsg?.slice(0, 120),
    });
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  recordReconnect(accountId: string, reason: string, attempt: number): void {
    const ev: ReconnectEvent = { accountId, at: new Date(), reason, attempt };
    this.reconnectEvents.push(ev);

    // Detect reconnect loop: >5 reconnects in last 10 minutes
    const tenMinsAgo       = Date.now() - 10 * 60_000;
    const recentReconnects = this.reconnectEvents.filter(
      e => e.accountId === accountId && e.at.getTime() > tenMinsAgo
    ).length;

    log.warn("[DIAG][RECONNECT] 🔄 Re-login scheduled", {
      accountId,
      reason,
      attempt,
      recentReconnectsIn10Min: recentReconnects,
      isLoop: recentReconnects > 5,
    });

    if (recentReconnects > 5) {
      log.error(
        "[DIAG][RECONNECT] 🚨 RECONNECT LOOP DETECTED — " +
        `${recentReconnects} reconnects in last 10min for [${accountId}]`,
        { reason, recentReconnects },
      );
    }
  }

  // ── AppState ──────────────────────────────────────────────────────────────

  recordAppStateLoad(accountId: string, cookieCount: number, source: string): void {
    const ev: AppStateEvent = { accountId, type: "load", at: new Date(), cookieCount, source };
    this.appStateEvents.push(ev);
    log.info("[DIAG][APPSTATE] 📂 AppState Loaded", { accountId, cookieCount, source });
  }

  recordAppStateSave(accountId: string, cookieCount: number): void {
    const ev: AppStateEvent = { accountId, type: "save", at: new Date(), cookieCount };
    this.appStateEvents.push(ev);
    log.info("[DIAG][APPSTATE] 💾 AppState Saved", { accountId, cookieCount });
  }

  /**
   * Called after each successful login to compare the original AppState with
   * the live cookies returned by api.getAppState(). A drift (different count
   * or values) means Facebook rotated the session — the original cookies in
   * MiraiTransport.appState are stale and a reconnect with them will fail.
   */
  recordAppStateCheck(accountId: string, originalCount: number, freshCount: number): void {
    const drift = freshCount !== originalCount;
    const ev: AppStateEvent = {
      accountId, type: "stale-check", at: new Date(),
      cookieCount: originalCount, freshCount, drift,
    };
    this.appStateEvents.push(ev);

    if (drift) {
      log.error(
        "[DIAG][APPSTATE] 🚨 COOKIE DRIFT DETECTED — Facebook rotated the session cookies!", {
          accountId,
          originalCount,
          freshCount,
          delta: freshCount - originalCount,
          diagnostic:
            "MiraiTransport.appState is readonly and never updated. " +
            "On next reconnect, the bot will use the STALE original cookies → AppState expired. " +
            "ROOT CAUSE CONFIRMED.",
        },
      );
    } else {
      log.info("[DIAG][APPSTATE] ✅ Cookie check: no drift", { accountId, cookieCount: originalCount });
    }
  }

  recordAppStateInvalid(accountId: string, error: string): void {
    const ev: AppStateEvent = { accountId, type: "invalid", at: new Date(), error };
    this.appStateEvents.push(ev);
    log.error("[DIAG][APPSTATE] 🚨 AppState INVALID / EXPIRED", {
      accountId,
      error: error.slice(0, 200),
      loginEventsBeforeThis: this.loginEvents.length,
      mqttDisconnectsBeforeThis: this.mqttEvents.filter(e => e.type === "disconnect").length,
    });
  }

  // ── API call tracking ─────────────────────────────────────────────────────

  recordApiCall(method: string, source: string, isError = false): void {
    const key      = `${method}::${source}`;
    const existing = this.apiCalls.get(key);
    const now      = new Date();

    if (existing) {
      existing.count++;
      existing.lastAt = now;
      if (isError) existing.errors++;
    } else {
      this.apiCalls.set(key, {
        method, source, count: 1,
        firstAt: now, lastAt: now,
        errors: isError ? 1 : 0,
      });
    }

    // Warn on every 100th call to flag high-frequency methods
    const record     = this.apiCalls.get(key)!;
    const runningMin = this._uptimeMin();
    const cpm        = runningMin > 0 ? (record.count / runningMin).toFixed(1) : "?";

    if (record.count % 100 === 0) {
      log.warn("[DIAG][API] High-frequency API method", {
        method,
        source,
        totalCount: record.count,
        callsPerMinute: cpm,
        errors: record.errors,
      });
    }
  }

  // ── Interval tracking ─────────────────────────────────────────────────────

  recordInterval(name: string, intervalMs: number, source?: string): void {
    this.intervals.push({
      name, intervalMs, source,
      registeredAt: new Date(),
      runCount: 0, lastRunAt: null,
    });
    log.info("[DIAG][INTERVAL] ⏰ Recurring interval registered", {
      name,
      intervalMs,
      intervalSec: intervalMs / 1000,
      source,
    });
  }

  // ── Report ────────────────────────────────────────────────────────────────

  generateReport(): string {
    const now      = new Date();
    const upMin    = this._uptimeMin();
    const runMin   = upMin;
    const lines: string[] = [];

    lines.push(`╔══════════════════════════════════════════════════════`);
    lines.push(`║ تقرير التشخيص — ${now.toISOString()}`);
    lines.push(`║ مدة التشغيل: ${upMin.toFixed(1)} دقيقة`);
    lines.push(`╚══════════════════════════════════════════════════════`);
    lines.push(``);

    // ── Login events
    const successLogins = this.loginEvents.filter(e => e.success);
    const failedLogins  = this.loginEvents.filter(e => !e.success);
    lines.push(`🔑 تسجيل الدخول:`);
    lines.push(`   إجمالي: ${this.loginEvents.length}  |  نجاح: ${successLogins.length}  |  فشل: ${failedLogins.length}`);
    this.loginEvents.forEach((ev, i) => {
      const badge = ev.success ? "✅" : "❌";
      lines.push(`   [${i + 1}] ${ev.at.toISOString()} ${badge} ${ev.accountId}  userId=${ev.userId ?? "?"}  cookies=${ev.cookieCount ?? "?"}  attempt=${ev.attempt ?? "?"}`);
      if (ev.error) lines.push(`       └─ خطأ: ${ev.error.slice(0, 100)}`);
    });

    // ── MQTT events
    lines.push(``);
    const mqttConnect    = this.mqttEvents.filter(e => e.type === "connect");
    const mqttDisconnect = this.mqttEvents.filter(e => e.type === "disconnect");
    const mqttError      = this.mqttEvents.filter(e => e.type === "error");
    lines.push(`🔌 MQTT:`);
    lines.push(`   اتصالات: ${mqttConnect.length}  |  انقطاعات: ${mqttDisconnect.length}  |  أخطاء: ${mqttError.length}`);
    lines.push(`   مستمعون نشطون الآن: ${this.activeListeners}`);
    lines.push(`   مستمعون مكررون (خطر): ${this.duplicateListenerCount}`);
    this.mqttEvents.forEach(ev => {
      const t = ev.type === "connect" ? "🟢 اتصال" : ev.type === "disconnect" ? "🔴 انقطاع" : "⚠️ خطأ";
      lines.push(`   ${ev.at.toISOString()} ${t}  acc=${ev.accountId}` +
        (ev.errorCode ? `  code=${ev.errorCode}` : ``) +
        (ev.errorMsg  ? `  "${ev.errorMsg.slice(0, 60)}"` : ``) +
        (ev.stableMs  ? `  مستقر=${(ev.stableMs/1000).toFixed(0)}s` : ``));
    });

    // ── Reconnect events
    lines.push(``);
    lines.push(`🔄 محاولات إعادة الاتصال: ${this.reconnectEvents.length}`);
    this.reconnectEvents.forEach(ev => {
      lines.push(`   ${ev.at.toISOString()} acc=${ev.accountId}  سبب=${ev.reason}  محاولة=${ev.attempt}`);
    });

    // ── AppState events
    lines.push(``);
    lines.push(`💾 أحداث AppState: ${this.appStateEvents.length}`);
    this.appStateEvents.forEach(ev => {
      const extra = ev.drift === true
        ? `⚠️ DRIFT original=${ev.cookieCount} fresh=${ev.freshCount}`
        : ev.cookieCount !== undefined ? `cookies=${ev.cookieCount}` : ``;
      lines.push(`   ${ev.at.toISOString()} [${ev.type}] acc=${ev.accountId}  ${extra}${ev.error ? `  خطأ: ${ev.error.slice(0,80)}` : ``}`);
    });

    // ── API calls sorted by count
    lines.push(``);
    lines.push(`📤 طلبات Facebook API (مرتبة تنازلياً):`);
    const sorted = Array.from(this.apiCalls.values()).sort((a, b) => b.count - a.count);
    sorted.forEach(rec => {
      const cpm = runMin > 0 ? (rec.count / runMin).toFixed(1) : `?`;
      lines.push(
        `   ${rec.method.padEnd(28)} ${String(rec.count).padStart(7)} مرة` +
        `  (${cpm}/دقيقة)  من [${rec.source}]  أخطاء: ${rec.errors}`
      );
    });
    const totalCalls = sorted.reduce((s, r) => s + r.count, 0);
    lines.push(`   ─── الإجمالي: ${totalCalls} طلب  (${runMin > 0 ? (totalCalls / runMin).toFixed(1) : "?"}/دقيقة)`);

    // ── Intervals
    lines.push(``);
    lines.push(`⏰ المهام الدورية (setInterval):`);
    this.intervals.forEach(iv => {
      lines.push(`   ${iv.name}  كل ${iv.intervalMs / 1000}s  مصدر=${iv.source ?? "?"}  مسجّل=${iv.registeredAt.toISOString()}`);
    });

    // ── Diagnosis summary
    lines.push(``);
    lines.push(`🔍 ملخص التشخيص:`);

    const issues: string[] = [];

    if (this.duplicateListenerCount > 0)
      issues.push(`🚨 مستمعون MQTT مكررون: ${this.duplicateListenerCount} حالة — يُبطل AppState فوراً`);

    const driftEvents = this.appStateEvents.filter(e => e.drift === true);
    if (driftEvents.length > 0)
      issues.push(`🚨 Cookie Drift: تم رصده ${driftEvents.length} مرة — AppState القديمة تُستخدم للإعادة وهي منتهية الصلاحية`);

    const invalidEvents = this.appStateEvents.filter(e => e.type === "invalid" || e.type === "expired");
    if (invalidEvents.length > 0)
      issues.push(`🚨 AppState المنتهية: ${invalidEvents.length} حالة`);

    const tenMinsAgo = Date.now() - 10 * 60_000;
    const loopCheck: Record<string, number> = {};
    this.reconnectEvents.forEach(ev => {
      if (ev.at.getTime() > tenMinsAgo)
        loopCheck[ev.accountId] = (loopCheck[ev.accountId] ?? 0) + 1;
    });
    Object.entries(loopCheck).forEach(([id, cnt]) => {
      if (cnt > 5) issues.push(`🚨 Reconnect Loop: ${cnt} محاولات في 10 دقائق لـ [${id}]`);
    });

    const markDelivered = sorted.find(r => r.method === "autoMarkDelivered" || r.method.includes("markDelivered"));
    if (markDelivered && runMin > 0 && markDelivered.count / runMin > 30)
      issues.push(`⚠️ autoMarkDelivered: ${(markDelivered.count / runMin).toFixed(1)} مرة/دقيقة — استهلاك مرتفع`);

    const getThreadList = sorted.find(r => r.method === "getThreadList");
    if (getThreadList)
      issues.push(`⚠️ getThreadList: ${getThreadList.count} استدعاء (كل 60 ثانية من control plugin)`);

    if (issues.length === 0) {
      lines.push(`   ✅ لم يُرصد أي خلل واضح حتى الآن.`);
    } else {
      issues.forEach(issue => lines.push(`   ${issue}`));
    }

    return lines.join("\n");
  }

  saveReport(): void {
    try {
      const report   = this.generateReport();
      const filename = `/tmp/diag-${Date.now()}.txt`;
      fs.writeFileSync(filename, report, "utf8");

      const runMin     = this._uptimeMin();
      const totalCalls = Array.from(this.apiCalls.values()).reduce((s, r) => s + r.count, 0);

      log.info("[DIAG][SUMMARY] ─── Periodic diagnostic summary ───", {
        uptimeMin:        runMin.toFixed(1),
        logins:           this.loginEvents.length,
        mqttConnects:     this.mqttEvents.filter(e => e.type === "connect").length,
        mqttDisconnects:  this.mqttEvents.filter(e => e.type === "disconnect").length,
        reconnects:       this.reconnectEvents.length,
        totalApiCalls:    totalCalls,
        callsPerMin:      runMin > 0 ? (totalCalls / runMin).toFixed(1) : "?",
        duplicateListeners: this.duplicateListenerCount,
        cookieDrifts:     this.appStateEvents.filter(e => e.drift === true).length,
        appStateInvalids: this.appStateEvents.filter(e => e.type === "invalid").length,
        reportFile:       filename,
      });
    } catch (err) {
      log.error("[DIAG] Failed to save report.", err);
    }
  }

  getReportText(): string { return this.generateReport(); }

  destroy(): void {
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
    this.saveReport();
    log.info("[DIAG] DiagnosticMonitor destroyed — final report saved.");
  }

  private _uptimeMin(): number {
    return (Date.now() - this.startedAt.getTime()) / 60_000;
  }
}

export const diagnosticMonitor = new DiagnosticMonitor();
