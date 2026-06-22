/**
 * run.ts — تشغيل النظام الكامل
 *
 * الطبقات:
 *   SessionManager       → يحمل AppState من ملف أو env
 *   FacebookTransport    → يتصل ويستقبل الرسائل
 *   ConnectionController → يراقب ويسجل كل الأحداث
 */

import login from "@dongdev/fca-unofficial";

import {
  SessionManager,
  FacebookTransport,
  ConnectionController,
} from "../src/index.js";

// ─── 1. تحميل AppState ────────────────────────────────────────────────────────

const session = new SessionManager();

const appState = session.load(
  process.env["FB_APPSTATE"]
    ? { from: "env",  value: process.env["FB_APPSTATE"] }
    : { from: "file", path: "./appstate.json"            }
);

// ─── 2. إنشاء Transport + Controller ─────────────────────────────────────────

const transport  = new FacebookTransport(login);
const controller = new ConnectionController();

// ─── 3. ربط المراقب قبل أي اتصال ─────────────────────────────────────────────

controller.attach(transport);

// ─── 4. طباعة كل حدث فور وصوله ───────────────────────────────────────────────

transport.on("event", (ev) => {
  const now = new Date().toISOString();
  console.log(`[${now}] TRANSPORT EVENT →`, JSON.stringify(ev));

  // بعد أي قطع اطبع snapshot للتشخيص
  if (ev.type === "mqtt:disconnected" || ev.type === "login:failed") {
    printSnapshot();
  }
});

transport.on("fca:event", (ev) => {
  if (ev["type"] === "message" || ev["type"] === "message_reply") {
    console.log(`[MSG] from=${ev["senderID"]} thread=${ev["threadID"]} body=${ev["body"]}`);
  }
});

// ─── 5. تسجيل الدخول ─────────────────────────────────────────────────────────

console.log("⟳ بدء تسجيل الدخول...");
await transport.login(appState);

// إذا نجح تسجيل الدخول → احفظ AppState المحدّث
if (transport.isConnected()) {
  const fresh = transport.getApi()?.getAppState();
  if (fresh) {
    session.save(fresh, { to: "file", path: "./appstate.json" });
    console.log("✓ AppState محدّث وتم حفظه.");
  }
}

// ─── 6. Snapshot دورية كل 30 ثانية ───────────────────────────────────────────

setInterval(printSnapshot, 30_000);

// ─── helpers ──────────────────────────────────────────────────────────────────

function printSnapshot() {
  const snap = controller.getSnapshot();
  console.log("\n──── SNAPSHOT ────");
  console.log("  الحالة     :", snap.status);
  console.log("  وقت الاتصال:", snap.connectedAt?.toISOString() ?? "—");
  console.log("  وقت الشغل  :", snap.uptimeSec !== null ? `${snap.uptimeSec} ثانية` : "—");
  console.log("  فشل login  :", snap.loginFailCount);
  console.log("  قطع MQTT   :", snap.mqttDisconnects);
  console.log("  غير مستقر  :", snap.isUnstable ? "نعم ⚠" : "لا ✓");
  console.log("  آخر حدث   :", snap.lastEvent ? `${snap.lastEvent.type} @ ${snap.lastEvent.at.toISOString()}` : "—");
  console.log("──────────────────\n");
}

// ─── 7. إيقاف نظيف عند SIGINT ────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\n⟳ إيقاف النظام...");
  printSnapshot();
  transport.disconnect();
  console.log("✓ تم الإيقاف.");
  process.exit(0);
});
