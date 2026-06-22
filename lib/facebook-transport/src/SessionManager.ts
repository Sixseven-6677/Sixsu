import fs from "fs";
import { AppState, FcaCookie } from "./types.js";

// ─── SessionManager ───────────────────────────────────────────────────────────
//
// Storage Layer فقط — لا يتصل، لا يصلح، لا يفكر.
//
// المسموح:
//   • تحميل AppState من ملف JSON أو env أو Base64
//   • حفظ AppState كملف JSON أو Base64
//
// الممنوع:
//   • تعديل AppState
//   • تسجيل دخول أو reconnect
//   • أي حفظ تلقائي أثناء التشغيل

export type LoadSource =
  | { from: "file";   path:  string }
  | { from: "env";    value: string }
  | { from: "base64"; value: string };

export type SaveTarget =
  | { to: "file";   path:  string }
  | { to: "base64"; };

export interface SaveBase64Result {
  encoded: string;
}

export class SessionManager {

  // ── load ────────────────────────────────────────────────────────────────

  /**
   * يحمّل AppState من المصدر المختار ويُرجعه كـ object جاهز.
   * لا يعدّل البيانات — يُحوّلها فقط إلى كائن صالح.
   */
  load(source: LoadSource): AppState {
    const raw = this.readRaw(source);
    return this.parse(raw);
  }

  // ── save ────────────────────────────────────────────────────────────────

  /**
   * يحفظ AppState إلى الهدف المختار عند طلب صريح من الخارج.
   * لا يُغيّر بنية AppState — يُخزّنها كما هي.
   *
   * - file   → JSON مباشر على disk
   * - base64 → يُرجع string مشفّر (لا يكتب على disk)
   */
  save(appState: AppState, target: SaveTarget): SaveBase64Result | void {
    const json = JSON.stringify(appState, null, 2);

    if (target.to === "file") {
      fs.writeFileSync(target.path, json, "utf8");
      return;
    }

    if (target.to === "base64") {
      return { encoded: Buffer.from(json).toString("base64") };
    }
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private readRaw(source: LoadSource): string {
    switch (source.from) {
      case "file":
        if (!fs.existsSync(source.path)) {
          throw new Error(`SessionManager: file not found — ${source.path}`);
        }
        return fs.readFileSync(source.path, "utf8");

      case "env":
        return SessionManager.decodeEnvValue(source.value);

      case "base64":
        return Buffer.from(source.value, "base64").toString("utf8");
    }
  }

  private parse(raw: string): AppState {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("SessionManager: AppState is not valid JSON.");
    }

    if (!Array.isArray(parsed)) {
      throw new Error("SessionManager: AppState must be a JSON array.");
    }

    return parsed as FcaCookie[];
  }

  /**
   * قيمة env ممكن تكون Base64 أو JSON عادي.
   * نحاول Base64 أولاً — إذا فشل نُرجع القيمة كما هي.
   */
  static decodeEnvValue(value: string): string {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      JSON.parse(decoded);
      return decoded;
    } catch {
      return value;
    }
  }
}