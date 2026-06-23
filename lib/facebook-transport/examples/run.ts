/**
 * examples/run.ts
 *
 * تشغيل النظام الكامل — إثبات أن جميع الطبقات تعمل معاً.
 *
 * الترتيب:
 *   1. SessionManager    → يحمل AppState
 *   2. FacebookTransport → الاتصال
 *   3. ConnectionController → المراقبة
 *   4. ReconnectManager  → إعادة الاتصال الذكي
 */

import login from "@dongdev/fca-unofficial";

import {
  SessionManager,
  FacebookTransport,
  ConnectionController,
  ReconnectManager,
} from "../src/index.js";

// ─── 1. تحميل AppState ────────────────────────────────────────────────────────

const session  = new SessionManager();

const appState = session.load(
  process.env["FB_APPSTATE"]
    ? { from: "env",  value: process.env["FB_APPSTATE"] }
    : { from: "file", path: "./appstate.json"            }
);

// ─── 2. إنشاء الطبقات ─────────────────────────────────────────────────────────

const transport  = new FacebookTransport(login);
const controller = new ConnectionController();
const reconnect  = new ReconnectManager(
  transport,
  session,
  controller,
  () => appState,   // يُرجع AppState الحالي عند كل محاولة
  {
    baseDelayMs:             5_000,
    maxDelayMs:            300_000,
    maxAttempts:                10,
    shortSessionThresholdMs: 300_000,
  }
);

// ─── 3. ربط المراقب + ReconnectManager قبل أي اتصال ─────────────────────────

controller.attach(transport);
reconnect.start();

// ─── 4. طباعة كل حدث فور وصوله ───────────────────────────────────────────────

transport.on("event", (ev) => {
  console.log(`[${ts()}] ▶ transport:event  ${JSON.stringify(ev)}`);
});

transport.on("fca:event", (ev) => {
  const type = ev["type"];
  if (type === "message" || type === "message_reply") {
    console.log(`[${ts()}] ✉  من=${ev["senderID"]}  thread=${ev["threadID"]}  body=${ev["body"]}`);
  }
});

// ─── 5. تسجيل الدخول ─────────────────────────────────────────────────────────

console.log(`[${ts()}] ⟳ بدء تسجيل الدخول...`);
await transport.login(appState);

// حفظ AppState المحدّث فور نجاح تسجيل الدخول
if (transport.isConnected()) {
  const fresh = transport.getApi()?.getAppState();
  if (fresh) {
    session.save(fresh, { to: "file", path: "./appstate.json" });
    console.log(`[${ts()}] ✓ AppState محدّث وتم حفظه.`);
  }
}

// ─── 6. طباعة snapshot كل 30 ثانية ──────────────────────────────────────────

setInterval(() => {
  printSnapshot();
}, 30_000);

// ─── 7. إيقاف نظيف عند SIGINT ────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log(`\n[${ts()}] ⟳ إيقاف النظام...`);
  reconnect.stop();
  transport.disconnect();
  printSnapshot();
  console.log(`[${ts()}] ✓ تم الإيقاف.`);
  process.exit(0);
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function printSnapshot(): void {
  const c = controller.getSnapshot();
  const r = reconnect.getSnapshot();

  console.log(`
┌─── SNAPSHOT ─────────────────────────────────────
│  حالة الاتصال : ${c.status}
│  وقت الاتصال  : ${c.connectedAt?.toISOString() ?? "—"}
│  وقت الشغل    : ${c.uptimeSec !== null ? `${c.uptimeSec}s` : "—"}
│  فشل login    : ${c.loginFailCount}
│  قطع MQTT     : ${c.mqttDisconnects}
│  غير مستقر   : ${c.isUnstable ? "نعم ⚠" : "لا ✓"}
│  آخر حدث     : ${c.lastEvent ? `${c.lastEvent.type} @ ${c.lastEvent.at.toISOString()}` : "—"}
├─── RECONNECT ─────────────────────────────────────
│  الحالة       : ${r.state}
│  المحاولة     : ${r.attempt} / ${r.maxAttempts}
│  آخر delay    : ${r.lastDelayMs !== null ? `${(r.lastDelayMs / 1000).toFixed(1)}s` : "—"}
│  المحاولة القادمة: ${r.nextAttemptAt?.toISOString() ?? "—"}
└───────────────────────────────────────────────────`);
}
