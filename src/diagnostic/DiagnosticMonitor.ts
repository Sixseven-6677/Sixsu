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
 *
 * Memory safety: all event arrays are capped at MAX_EVENTS entries (oldest
 * dropped first) to prevent unbounded memory growth during long-running sessions.
 */

import fs   from "fs";
import { LoggerManager } from "../logger/LoggerManager";

const log = LoggerManager.getLogger("DiagnosticMonitor");

/** Maximum events kept per category. Oldest entries are dropped first. */
const MAX_EVENTS = 500;

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

  // Running counters — incremented alongside the capped arrays so totals
  // remain accurate even after old entries are evicted.
  private totalLogins     = 0;
  private totalLoginFails = 0;
  private totalMqttConnects    = 0;
  private totalMqttDisconnects = 0;
  private totalMqttErrors      = 0;
  private totalReconnects      = 0;
  // Running count of recent reconnects for loop detection (last 10 min)
  private reconnectTimestamps: number[] = [];

  private activeListeners        = 0;
  private duplicateListenerCount = 0;
  private saveTimer:             ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic auto-report every 10 minutes
    this.saveTimer = setInterval(() => this.saveReport(), 10 * 60_000);
    log.info("[DIAG] DiagnosticMonitor started.", { startedAt: this.startedAt.toISOString() });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Push an event into a capped array.
   * When the array exceeds MAX_EVENTS, the oldest entry is dropped.
   * This prevents unbounded memory growth in long-running sessions.
   */
  private pushCapped<T>(arr: T[], event: T): void {
    arr.push(event);
    if (arr.length > MAX_EVENTS) {
      arr.shift(); // drop oldest
    }
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  recordLogin(accountId: string, success: boolean, opts: {
    userId?:      string;
    cookieCount?: number;
    attempt?:     number;
    error?:       string;
  } = {}): void {
    const ev: LoginEvent = { accountId, at: new Date(), success, ...opts };
    this.pushCapped(this.loginEvents, ev);

    if (success) {
      this.totalLogins++;
      log.info("[DIAG][LOGIN] ✅ Login SUCCESS", {
        accountId,
        userId:        opts.userId,
        cookieCount:   opts.cookieCount,
        attempt:       opts.attempt,
        totalLogins:   this.totalLogins,
        uptimeMin:     this._uptimeMin(),
      });
    } else {
      this.totalLoginFails++;
      log.error("[DIAG][LOGIN] ❌ Login FAILED", {
        accountId,
        error:          opts.error,
        attempt:        opts.attempt,
        totalFailures:  this.totalLoginFails,
      });
    }
  }

  // ── MQTT ──────────────────────────────────────────────────────────────────

  recordMqttConnect(accountId: string): void {
    const ev: MqttEvent = { accountId, type: "connect", at: new Date() };
    this.pushCapped(this.mqttEvents, ev);
    this.totalMqttConnects++;
    this.activeListeners++;

    log.info("[DIAG][MQTT] ✅ MQTT Connected", {
      accountId,
      activeListeners: this.activeListeners,
      totalConnects:   this.totalMqttConnects,
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
    this.pushCapped(this.mqttEvents, ev);
    this.totalMqttDisconnects++;
    this.activeListeners = Math.max(0, this.activeListeners - 1);

    const stableSec = opts.stableMs !== undefined ? (opts.stableMs / 1000).toFixed(1) : "?";
    log.warn("[DIAG][MQTT] ⚡ MQTT Disconnected", {
      accountId,
      errorCode:         opts.errorCode,
      errorMsg:          opts.errorMsg?.slice(0, 120),
      stableSec,
      activeListeners:   this.activeListeners,
      totalDisconnects:  this.totalMqttDisconnects,
    });
  }

  recordMqttError(accountId: string, errorCode?: number, errorMsg?: string): void {
    const ev: MqttEvent = { accountId, type: "error", at: new Date(), errorCode, errorMsg };
    this.pushCapped(this.mqttEvents, ev);
    this.totalMqttErrors++;
    log.error("[DIAG][MQTT] 🔴 MQTT Error", {
      accountId,
      errorCode,
      errorMsg: errorMsg?.slice(0, 120),
    });
  }

  // ── Reconnect ─────────────────────────────────────────────────────────────

  recordReconnect(accountId: string, reason: string, attempt: number): void {
    const ev: ReconnectEvent = { accountId, at: new Date(), reason, attempt };
    this.pushCapped(this.reconnectEvents, ev);
    this.totalReconnects++;

    // Track recent reconnect timestamps for loop detection (O(1) amortized)
    const now = Date.now();
    this.reconnectTimestamps.push(now);
    // Trim timestamps older than 10 minutes to keep the array small
    const tenMinsAgo = now - 10 * 60_000;
    const oldestValid = this.reconnectTimestamps.findIndex(t => t > tenMinsAgo);
    if (oldestValid > 0) this.reconnectTimestamps.splice(0, oldestValid);

    // Count recent reconnects for this account from the capped array (bounded O(n) with n≤MAX_EVENTS)
    const recentReconnects = this.reconnectEvents.filter(
      e => e.accountId === accountId && e.at.getTime() > tenMinsAgo
    ).length;

    log.warn("[DIAG][RECONNECT] 🔄 Re-login scheduled", {
      accountId,
      reason,
      attempt,
      recentReconnectsIn10Min: recentReconnects,
      totalReconnects:         this.totalReconnects,
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
    this.pushCapped(this.appStateEvents, ev);
    log.info("[DIAG][APPSTATE] 📂 AppState Loaded", { accountId, cookieCount, source });
  }

  recordAppStateSave(accountId: string, cookieCount: number): void {
    const ev: AppStateEvent = { accountId, type: "save", at: new Date(), cookieCount };
    this.pushCapped(this.appStateEvents, ev);
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
    this.pushCapped(this.appStateEvents, ev);

    if (drift) {
      log.error(
        "[DIAG][APPSTATE] 🚨 COOKIE DRIFT DETECTED — Facebook rotated the session cookies!", {
          accountId,
          originalCount,
          freshCount,
          delta: freshCount - originalCount,
          diagnostic:
            "MiraiTransport now saves fresh cookies via setOnAppStateRefresh, and " +
            "ReconnectManager.attemptLogin now tries session store first before env cookies. " +
            "This drift is expected and handled correctly.",
        },
      );
    } else {
      log.info("[DIAG][APPSTATE] ✅ Cookie check: no drift", { accountId, cookieCount: originalCount });
    }
  }

  recordAppStateInvalid(accountId: string, error: string): void {
    const ev: AppStateEvent = { accountId, type: "invalid", at: new Date(), error };
    this.pushCapped(this.appStateEvents, ev);
    log.error("[DIAG][APPSTATE] 🚨 AppState INVALID / EXPIRED", {
      accountId,
      error: error.slice(0, 200),
      loginEventsInWindow:     this.loginEvents.length,
      mqttDisconnectsInWindow: this.mqttEvents.filter(e => e.type === "disconnect").length,
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
    lines.push(`║ (المصفوفات تحتفظ بآخر ${MAX_EVENTS} حدث لكل نوع — الإجمالي محفوظ في العدادات)`);
    lines.push(`╚══════════════════════════════════════════════════════`);
    lines.push(``);

    // ── Login events
    lines.push(`🔑 تسجيل الدخول:`);
    lines.push(`   إجمالي نجاح: ${this.totalLogins}  |  إجمالي فشل: ${this.totalLoginFails}  |  في النافذة: ${this.loginEvents.length}`);
    this.loginEvents.forEach((ev, i) => {
      const badge = ev.success ? "✅" : "❌";
      lines.push(`   [${i + 1}] ${ev.at.toISOString()} ${badge} ${ev.accountId}  userId=${ev.userId ?? "?"}  cookies=${ev.cookieCount ?? "?"}  attempt=${ev.attempt ?? "?"}`);
      if (ev.error) lines.push(`       └─ خطأ: ${ev.error.slice(0, 100)}`);
    });

    // ── MQTT events
    lines.push(``);
    lines.push(`🔌 MQTT:`);
    lines.push(`   اتصالات (الكل): ${this.totalMqttConnects}  |  انقطاعات (الكل): ${this.totalMqttDisconnects}  |  أخطاء (الكل): ${this.totalMqttErrors}`);
    lines.push(`   مستمعون نشطون الآن: ${this.activeListeners}`);
    lines.push(`   مستمعون مكررون (خطر): ${this.duplicateListenerCount}`);
    lines.push(`   أحداث في النافذة: ${this.mqttEvents.length}`);
    this.mqttEvents.slice(-20).forEach(ev => {
      const t = ev.type === "connect" ? "🟢 اتصال" : ev.type === "disconnect" ? "🔴 انقطاع" : "⚠️ خطأ";
      lines.push(`   ${ev.at.toISOString()} ${t}  acc=${ev.accountId}` +
        (ev.errorCode ? `  code=${ev.errorCode}` : ``) +
        (ev.errorMsg  ? `  "${ev.errorMsg.slice(0, 60)}"` : ``) +
        (ev.stableMs  ? `  مستقر=${(ev.stableMs/1000).toFixed(0)}s` : ``));
    });
    if (this.mqttEvents.length > 20) lines.push(`   ... (عرض آخر 20 من ${this.mqttEvents.length})`);

    // ── Reconnect events
    lines.push(``);
    lines.push(`🔄 محاولات إعادة الاتصال (الكل): ${this.totalReconnects}  |  في النافذة: ${this.reconnectEvents.length}`);
    this.reconnectEvents.slice(-10).forEach(ev => {
      lines.push(`   ${ev.at.toISOString()} acc=${ev.accountId}  سبب=${ev.reason}  محاولة=${ev.attempt}`);
    });

    // ── AppState events
    lines.push(``);
    lines.push(`💾 أحداث AppState: ${this.appStateEvents.length}`);
    this.appStateEvents.slice(-10).forEach(ev => {
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
      issues.push(`ℹ️ Cookie Drift: رُصد ${driftEvents.length} مرة — مُعالَج الآن (session store يُستخدم أولاً)`);

    const invalidEvents = this.appStateEvents.filter(e => e.type === "invalid" || e.type === "expired");
    if (invalidEvents.length > 0)
      issues.push(`🚨 AppState المنتهية: ${invalidEvents.length} حالة — يجب تحديث FB_APPSTATE`);

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
        totalLogins:      this.totalLogins,
        totalLoginFails:  this.totalLoginFails,
        mqttConnects:     this.totalMqttConnects,
        mqttDisconnects:  this.totalMqttDisconnects,
        totalReconnects:  this.totalReconnects,
        totalApiCalls:    totalCalls,
        callsPerMin:      runMin > 0 ? (totalCalls / runMin).toFixed(1) : "?",
        duplicateListeners: this.duplicateListenerCount,
        cookieDrifts:     this.appStateEvents.filter(e => e.drift === true).length,
        appStateInvalids: this.appStateEvents.filter(e => e.type === "invalid").length,
        heapUsedMB:       (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMB:      (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(1),
        rssMB:            (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
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
