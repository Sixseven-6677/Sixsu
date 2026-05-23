import { ICommand }   from "../types/ICommand";
import { getBanStore } from "../../handlers/message.handler";

export const command: ICommand = {
  name:        "bans",
  aliases:     ["banlist"],
  description: "يعرض قائمة المحظورين وإحصائيات البان",
  usage:       "/bans [list|summary|purge]",
  category:    "admin",
  adminOnly:   true,

  execute: async (ctx) => {
    const store = getBanStore();
    if (!store) {
      await ctx.reply("⚠️ BanStore غير متاح.");
      return;
    }

    const sub = ctx.getArg(0)?.toLowerCase() ?? "summary";

    if (sub === "purge") {
      const removed = store.purgeExpired();
      await ctx.reply(
        removed > 0
          ? `🧹 تم حذف ${removed} حظر منتهٍ.`
          : "✅ لا توجد حظوظ منتهية للحذف."
      );
      return;
    }

    if (sub === "list") {
      const entries = store.getAll();
      if (entries.length === 0) {
        await ctx.reply("📭 لا يوجد أي مستخدم محظور حالياً.");
        return;
      }

      const lines = entries.map((e) => {
        const expiry = e.expiresAt
          ? `⏰ ${e.expiresAt.toLocaleString()}`
          : "♾️ دائم";
        const reason = e.reason ? ` — ${e.reason}` : "";
        return `• ${e.userId}${reason}\n  ${expiry}`;
      });

      await ctx.reply(
        `📋 المحظورون (${entries.length}):\n` + lines.join("\n\n")
      );
      return;
    }

    // Default: summary
    const s = store.summary();
    await ctx.reply(
      `📊 إحصائيات الحظر:\n` +
      `• الإجمالي:   ${s.total}\n` +
      `• نشط:        ${s.active}\n` +
      `• دائم:       ${s.permanent}\n` +
      `• مؤقت:       ${s.temporary}\n` +
      `• منتهٍ:      ${s.expired}`
    );
  },
};
