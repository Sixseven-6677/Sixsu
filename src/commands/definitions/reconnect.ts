import { ICommand }            from "../types/ICommand";
import { getReconnectManager } from "../../handlers/message.handler";
import { ReconnectStatus }     from "../../facebook/reconnect/types/IReconnect";

const STATUS_EMOJI: Record<string, string> = {
  [ReconnectStatus.IDLE]:      "💤",
  [ReconnectStatus.RETRYING]:  "🔄",
  [ReconnectStatus.CONNECTED]: "🟢",
  [ReconnectStatus.FAILED]:    "🔴",
  [ReconnectStatus.BLOCKED]:   "🚫",
};

export const command: ICommand = {
  name:        "reconnect",
  aliases:     ["rc"],
  description: "يعرض حالة إعادة الاتصال أو يُشغّلها يدوياً",
  usage:       "/reconnect [status|trigger <account>|summary]",
  category:    "admin",
  adminOnly:   true,

  execute: async (ctx) => {
    const mgr = getReconnectManager();
    if (!mgr) {
      await ctx.reply("⚠️ ReconnectManager غير مُفعَّل.");
      return;
    }

    const sub = ctx.getArg(0)?.toLowerCase() ?? "status";

    // ── summary ──────────────────────────────────────────────
    if (sub === "summary") {
      const s = mgr.summary();
      await ctx.reply(
        `📊 ملخص إعادة الاتصال:\n` +
        `• الإجمالي: ${s.total}\n` +
        `• متصل:     ${s.connected}\n` +
        `• فاشل:     ${s.failed}\n` +
        `• محظور:    ${s.blocked}`
      );
      return;
    }

    // ── trigger ───────────────────────────────────────────────
    if (sub === "trigger") {
      const accountId = ctx.getArg(1) ?? "default";
      await ctx.reply(`🔄 جارٍ تشغيل إعادة الاتصال للحساب [${accountId}]...`);
      const ok = await mgr.reconnect(accountId);
      await ctx.reply(
        ok
          ? `✅ نجح الاتصال للحساب [${accountId}].`
          : `❌ فشلت إعادة الاتصال للحساب [${accountId}]. تحقق من السجلات.`
      );
      return;
    }

    // ── status (default) ──────────────────────────────────────
    const records = mgr.getAllRecords();
    if (records.length === 0) {
      await ctx.reply("📭 لا توجد سجلات اتصال حتى الآن.");
      return;
    }

    const lines = records.map((r) => {
      const emoji = STATUS_EMOJI[r.status] ?? "❓";
      const runs  = r.totalRuns > 0 ? ` | محاولات: ${r.totalRuns}` : "";
      const last  = r.lastAttemptAt
        ? ` | آخر محاولة: ${r.lastAttemptAt.toLocaleTimeString()}`
        : "";
      return `${emoji} ${r.accountId} — ${r.status}${runs}${last}`;
    });

    await ctx.reply(`📶 حالة إعادة الاتصال:\n` + lines.join("\n"));
  },
};
